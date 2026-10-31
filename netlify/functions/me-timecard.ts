import { requireEmployee } from './_shared/auth';
import { json, error, readJson, requireMethod } from './_shared/http';
import { deriveSegments } from '../../src/lib/domain/segments';
import type { StoredEvent } from '../../src/lib/domain/punch';
import { payPeriodFor, shiftPayPeriod } from '../../src/lib/time';

// Self-service time card for TRUSTED senior staff (employees.can_manage_own_time).
// The caller can view and edit ONLY THEIR OWN punches — identity comes from the
// verified token, never the body. Same append-only model + guardrails as the
// admin Timesheet, plus: edits are limited to the current + previous pay period,
// and a locked pay period is read-only. Entries are stamped source='employee_self'.
//   POST /api/me-timecard  { action:'load', start, end }
//   POST /api/me-timecard  { action:'save', days:[{date, segments:[{startTs,endTs,locationId,departmentId}]}], reason? }

const TZ = 'America/New_York';
const etDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const toLocal = (iso: string) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)); const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00'; return `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`; };

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { admin, employee, authUserId } = await requireEmployee(req);
    if (employee.timekeeping_access !== 'enabled') return error(403, 'not_enabled', 'Your time-clock access is not enabled.');
    if (!employee.can_manage_own_time) return error(403, 'not_allowed', 'You do not have access to edit your own time card. Ask an administrator.');
    const empId = employee.id;

    // Editable window: previous + current pay period.
    const current = payPeriodFor(new Date());
    const prev = shiftPayPeriod(current, -1);
    const allowedStart = prev.start, allowedEnd = current.end;

    const body = await readJson<{ action?: string; start?: string; end?: string; reason?: string; days?: Array<{ date: string; segments: Array<{ startTs: string; endTs?: string | null; locationId?: string | null; departmentId?: string | null }> }> }>(req);

    // ---- LOAD ----
    if (body.action !== 'save') {
      const start = body.start && /^\d{4}-\d{2}-\d{2}$/.test(body.start) ? body.start : current.start;
      const end = body.end && /^\d{4}-\d{2}-\d{2}$/.test(body.end) ? body.end : current.end;
      const startTs = `${start}T00:00:00-05:00`, endTs = `${end}T23:59:59-04:00`;
      const { data: pev } = await admin.from('punch_events').select('event_type, location_id, department_id, server_ts').eq('employee_id', empId).is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs).order('server_ts', { ascending: true });
      const byDay = new Map<string, any[]>();
      for (const s of deriveSegments((pev ?? []) as StoredEvent[])) { const d = etDay(s.startedAt); const a = byDay.get(d) ?? []; a.push(s); byDay.set(d, a); }
      const days: any[] = [];
      const [sy, sm, sd] = start.split('-').map(Number); const [ey, em, ed] = end.split('-').map(Number);
      let cur = Date.UTC(sy, sm - 1, sd); const lastMs = Date.UTC(ey, em - 1, ed);
      while (cur <= lastMs) {
        const d = new Date(cur);
        const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        const daySegs = (byDay.get(date) ?? []).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        const segments = daySegs.map((s) => ({ startLocal: toLocal(s.startedAt), endLocal: s.endedAt ? toLocal(s.endedAt) : null, locationId: s.locationId ?? null, departmentId: s.departmentId ?? null, hours: s.durationSeconds != null ? Math.round(s.durationSeconds / 3600 * 100) / 100 : null, open: s.endedAt == null }));
        days.push({ date, weekday: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }), segments });
        cur += 86400000;
      }
      return json({ ok: true, start, end, allowedStart, allowedEnd, home: { locationId: employee.home_location_id, departmentId: employee.home_department_id }, days });
    }

    // ---- SAVE ----
    const daysIn = Array.isArray(body.days) ? body.days : [];
    if (!daysIn.length) return error(400, 'nothing', 'No days to save.');
    const reason = (String(body.reason ?? '').trim() || 'self time entry').slice(0, 200);

    // Validate everything BEFORE writing anything.
    const lockedPeriods = new Map<string, boolean>();
    const isLocked = async (dateStr: string): Promise<boolean> => {
      const pp = payPeriodFor(new Date(`${dateStr}T12:00:00Z`));
      const key = `${pp.start}|${pp.end}`;
      if (lockedPeriods.has(key)) return lockedPeriods.get(key)!;
      const { data: ppRow } = await admin.from('pay_periods').select('id').eq('start_date', pp.start).eq('end_date', pp.end).maybeSingle();
      let locked = false;
      if (ppRow?.id) { const { data: ap } = await admin.from('timecard_approvals').select('state').eq('employee_id', empId).eq('pay_period_id', ppRow.id).maybeSingle(); locked = ap?.state === 'locked'; }
      lockedPeriods.set(key, locked); return locked;
    };
    for (const d of daysIn) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return error(400, 'bad_date', `Bad date ${d.date}.`);
      if (d.date < allowedStart || d.date > allowedEnd) return error(403, 'out_of_window', `You can only edit the current and previous pay period (${allowedStart} to ${allowedEnd}).`);
      if (await isLocked(d.date)) return error(409, 'locked', `That pay period is locked/submitted for payroll and can no longer be edited. Ask an administrator.`);
      for (const s of d.segments ?? []) {
        if (Number.isNaN(Date.parse(s.startTs))) return error(400, 'bad_ts', `Bad start time on ${d.date}.`);
        if (s.endTs) { // end is optional — a start-only entry is an open clock-in
          if (Number.isNaN(Date.parse(s.endTs))) return error(400, 'bad_ts', `Bad end time on ${d.date}.`);
          if (Date.parse(s.endTs) <= Date.parse(s.startTs)) return error(400, 'bad_range', `Clock-out must be after clock-in on ${d.date}.`);
          if (Date.parse(s.endTs) - Date.parse(s.startTs) > 16 * 3600 * 1000) return error(400, 'too_long', `Over 16 hours on ${d.date}.`);
          if (etDay(s.startTs) !== etDay(s.endTs)) return error(400, 'overnight', `A shift can't cross midnight (${d.date}).`);
        }
      }
    }

    let inserted = 0; const touched: string[] = [];
    for (const d of daysIn) {
      const startTs = `${d.date}T00:00:00-05:00`, endTs = `${d.date}T23:59:59-04:00`;
      const { data: existing } = await admin.from('punch_events').select('id').eq('employee_id', empId).is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs);
      const ids = (existing ?? []).map((e: any) => e.id);
      if (ids.length) await admin.from('punch_events').update({ voided_at: new Date().toISOString(), voided_by_auth_id: authUserId, void_reason: reason }).in('id', ids);
      const rows: any[] = [];
      for (const s of d.segments ?? []) {
        const locId = s.locationId ?? employee.home_location_id ?? null;
        const deptId = s.departmentId ?? employee.home_department_id ?? null;
        const base = { employee_id: empId, gusto_employee_uuid: employee.gusto_employee_uuid, location_id: locId, department_id: deptId, source: 'employee_self', created_by_auth_id: authUserId, correction_reason: reason };
        const pp = payPeriodFor(new Date(s.startTs));
        await admin.from('pay_periods').upsert({ start_date: pp.start, end_date: pp.end }, { onConflict: 'start_date,end_date', ignoreDuplicates: true });
        const { data: ppRow } = await admin.from('pay_periods').select('id').eq('start_date', pp.start).eq('end_date', pp.end).maybeSingle();
        rows.push({ ...base, event_type: 'clock_in', server_ts: s.startTs, employee_ts: s.startTs, pay_period_id: ppRow?.id ?? null });
        if (s.endTs) rows.push({ ...base, event_type: 'clock_out', server_ts: s.endTs, employee_ts: s.endTs, pay_period_id: ppRow?.id ?? null });
      }
      if (rows.length) { const { error: e } = await admin.from('punch_events').insert(rows); if (e) return error(500, 'db_error', e.message); inserted += rows.length; }
      touched.push(d.date);
    }
    await admin.from('audit_logs').insert({ actor_label: `self:${employee.first_name}`, action: 'self_timecard_entry', entity: 'punch_events', entity_id: empId, after_value: { days: touched, punches: inserted, reason }, is_security_event: false });
    return json({ ok: true, daysApplied: touched.length, punchesInserted: inserted });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] me-timecard error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/me-timecard' };
