import { requireEmployee, isAdmin } from './_shared/auth';
import { json, error, readJson, requireMethod } from './_shared/http';
import { payPeriodFor, localDateKey, secondsToDecimalHours } from '../../src/lib/time';
import { runGustoSync } from './_shared/gusto';
import { deriveSegments } from '../../src/lib/domain/segments';
import type { StoredEvent } from '../../src/lib/domain/punch';
import { resolveCorrection, etDateStr } from '../../src/lib/domain/correction';

// Admin/manager action dispatcher. Every action re-checks authorization
// server-side. Admins (payroll_admin/system_admin) have full reach; location
// managers are scoped to employees at the locations they manage.

const ACCESS = ['pending_review', 'enabled', 'suspended', 'disabled', 'terminated_in_gusto', 'sync_conflict'];
const ASSIGNABLE_ROLES = ['employee', 'location_manager', 'payroll_admin', 'system_admin'];

type Scope = 'all' | string[];

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { admin, roles, employee, authUserId } = await requireEmployee(req);
    const staff = isAdmin(roles) || roles.includes('location_manager');
    if (!staff) return error(403, 'forbidden', 'Staff access required.');

    const body = await readJson<{ type: string; [k: string]: unknown }>(req);
    const actorLabel = `${isAdmin(roles) ? 'admin' : 'manager'}:${employee.first_name}`;
    const scope = await managedScope(admin, authUserId, roles);

    const ppIdFor = async (isoTs: string): Promise<string | null> => {
      const pp = payPeriodFor(new Date(isoTs));
      await admin.from('pay_periods').upsert({ start_date: pp.start, end_date: pp.end }, { onConflict: 'start_date,end_date', ignoreDuplicates: true });
      const { data } = await admin.from('pay_periods').select('id').eq('start_date', pp.start).eq('end_date', pp.end).maybeSingle();
      return data?.id ?? null;
    };

    switch (body.type) {
      // ---- access / assignments (from before) ----
      case 'set_access': {
        const employeeId = String(body.employeeId); const access = String(body.access);
        if (!ACCESS.includes(access)) return error(400, 'bad_access', 'Unknown access value.');
        if (!(await canManage(admin, scope, employeeId))) return error(403, 'out_of_scope', 'That employee is outside your locations.');
        const { data: before } = await admin.from('employees').select('timekeeping_access').eq('id', employeeId).maybeSingle();
        const { error: e } = await admin.from('employees').update({ timekeeping_access: access }).eq('id', employeeId);
        if (e) return error(500, 'db_error', e.message);
        await audit(admin, actorLabel, 'set_access', 'employees', employeeId, before, { timekeeping_access: access }, true);
        return json({ ok: true });
      }

      // ---- grant/revoke a trusted person's self-service time-card access ----
      case 'set_self_manage': {
        const employeeId = String(body.employeeId); const enabled = body.enabled === true;
        if (!(await canManage(admin, scope, employeeId))) return error(403, 'out_of_scope', 'That employee is outside your locations.');
        const { error: e } = await admin.from('employees').update({ can_manage_own_time: enabled }).eq('id', employeeId);
        if (e) return error(500, 'db_error', e.message);
        await audit(admin, actorLabel, 'set_self_manage', 'employees', employeeId, null, { can_manage_own_time: enabled }, true);
        return json({ ok: true });
      }

      // ---- pull the latest roster from Gusto on demand ----
      case 'sync_gusto': {
        if (!isAdmin(roles)) return error(403, 'forbidden', 'Only an administrator can sync with Gusto.');
        const result = await runGustoSync(admin);
        await audit(admin, actorLabel, 'gusto_sync_manual', 'employees', null, null, result, true);
        if (result.error) return error(502, 'gusto_error', result.error);
        return json({ ok: true, result });
      }

      // ---- roles (system_admin only) ----
      case 'set_roles': {
        if (!roles.includes('system_admin')) return error(403, 'forbidden', 'Only a system administrator can manage roles.');
        const employeeId = String(body.employeeId);
        const desired = (body.roles as Array<{ role: string; locationId?: string | null }>) ?? [];
        for (const r of desired) if (!ASSIGNABLE_ROLES.includes(r.role)) return error(400, 'bad_role', `Unknown role ${r.role}.`);
        const { data: emp } = await admin.from('employees').select('auth_user_id, first_name').eq('id', employeeId).maybeSingle();
        if (!emp?.auth_user_id) return error(409, 'not_activated', 'That employee has not logged in yet, so roles cannot be assigned.');
        await admin.from('user_roles').delete().eq('auth_user_id', emp.auth_user_id);
        const rows = [{ role: 'employee', locationId: null }, ...desired].map((r) => ({ auth_user_id: emp.auth_user_id, role: r.role, location_id: r.locationId ?? null }));
        // de-dupe
        const seen = new Set<string>(); const dedup = rows.filter((r) => { const k = `${r.role}|${r.location_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
        const { error: e } = await admin.from('user_roles').insert(dedup);
        if (e) return error(500, 'db_error', e.message);
        await audit(admin, actorLabel, 'set_roles', 'employees', employeeId, null, { roles: desired }, true);
        return json({ ok: true });
      }

      // ---- manual punch (add a missing clock-in/out at a chosen time) ----
      case 'manual_punch': {
        const employeeId = String(body.employeeId);
        const eventType = String(body.eventType); // clock_in | clock_out
        if (!['clock_in', 'clock_out'].includes(eventType)) return error(400, 'bad_type', 'eventType must be clock_in or clock_out.');
        if (!(await canManage(admin, scope, employeeId))) return error(403, 'out_of_scope', 'That employee is outside your locations.');
        const effectiveTs = String(body.effectiveTs);
        if (Number.isNaN(Date.parse(effectiveTs))) return error(400, 'bad_ts', 'effectiveTs must be a valid timestamp.');
        const { data: emp } = await admin.from('employees').select('gusto_employee_uuid').eq('id', employeeId).maybeSingle();
        if (!emp) return error(404, 'no_employee', 'Employee not found.');
        const { data: ins, error: e } = await admin.from('punch_events').insert({
          employee_id: employeeId, gusto_employee_uuid: emp.gusto_employee_uuid, event_type: eventType,
          server_ts: effectiveTs, employee_ts: effectiveTs, location_id: body.locationId ?? null, department_id: body.departmentId ?? null,
          note: body.note ?? null, source: 'administrator', created_by_auth_id: authUserId,
          correction_reason: body.reason ?? 'manual entry', pay_period_id: await ppIdFor(effectiveTs),
        }).select('id').maybeSingle();
        if (e) return error(500, 'db_error', e.message);
        await audit(admin, actorLabel, 'manual_punch', 'punch_events', ins?.id ?? null, null, { eventType, effectiveTs }, false);
        return json({ ok: true, id: ins?.id });
      }

      // ---- edit a punch: void original, insert corrected (append-only) ----
      case 'edit_punch': {
        const eventId = String(body.eventId);
        const { data: orig } = await admin.from('punch_events').select('*').eq('id', eventId).is('voided_at', null).maybeSingle();
        if (!orig) return error(404, 'no_event', 'Punch not found (or already superseded).');
        if (!(await canManage(admin, scope, orig.employee_id))) return error(403, 'out_of_scope', 'That punch is outside your locations.');
        // A reason is optional — if the admin doesn't type one we record a
        // generic label so the audit trail still shows who/when/what changed.
        const reason = (String(body.reason ?? '').trim() || 'admin adjustment').slice(0, 200);
        const newTs = body.newTs ? String(body.newTs) : orig.server_ts;
        if (Number.isNaN(Date.parse(newTs))) return error(400, 'bad_ts', 'newTs must be a valid timestamp.');
        await admin.from('punch_events').update({ voided_at: new Date().toISOString(), voided_by_auth_id: authUserId, void_reason: reason }).eq('id', eventId);
        const { data: ins, error: e } = await admin.from('punch_events').insert({
          employee_id: orig.employee_id, gusto_employee_uuid: orig.gusto_employee_uuid, event_type: orig.event_type,
          server_ts: newTs, employee_ts: orig.employee_ts, location_id: body.locationId ?? orig.location_id,
          department_id: body.departmentId ?? orig.department_id, note: orig.note, source: 'administrator',
          created_by_auth_id: authUserId, original_event_id: eventId, correction_reason: reason, pay_period_id: await ppIdFor(newTs),
        }).select('id').maybeSingle();
        if (e) return error(500, 'db_error', e.message);
        await audit(admin, actorLabel, 'edit_punch', 'punch_events', eventId,
          { server_ts: orig.server_ts, location_id: orig.location_id, department_id: orig.department_id },
          { server_ts: newTs, location_id: body.locationId ?? orig.location_id, department_id: body.departmentId ?? orig.department_id, reason, new_id: ins?.id }, false);
        return json({ ok: true, id: ins?.id });
      }

      // ---- void a punch (e.g. accidental duplicate) ----
      case 'void_punch': {
        const eventId = String(body.eventId);
        // Reason optional (defaults to a generic label so the audit log still records the change).
        const reason = (String(body.reason ?? '').trim() || 'admin adjustment').slice(0, 200);
        const { data: orig } = await admin.from('punch_events').select('employee_id, server_ts').eq('id', eventId).is('voided_at', null).maybeSingle();
        if (!orig) return error(404, 'no_event', 'Punch not found (or already voided).');
        if (!(await canManage(admin, scope, orig.employee_id))) return error(403, 'out_of_scope', 'That punch is outside your locations.');
        await admin.from('punch_events').update({ voided_at: new Date().toISOString(), voided_by_auth_id: authUserId, void_reason: reason }).eq('id', eventId);
        await audit(admin, actorLabel, 'void_punch', 'punch_events', eventId, { server_ts: orig.server_ts }, { reason }, false);
        return json({ ok: true });
      }

      // ---- end / cancel a live open shift (someone stuck clocked in) ----
      case 'end_open_shift': {
        const employeeId = String(body.employeeId);
        const mode = String(body.mode); // 'clock_out' | 'cancel'
        if (!['clock_out', 'cancel'].includes(mode)) return error(400, 'bad_mode', 'mode must be clock_out or cancel.');
        if (!(await canManage(admin, scope, employeeId))) return error(403, 'out_of_scope', 'That employee is outside your locations.');
        const { data: evs } = await admin.from('punch_events')
          .select('id, event_type, location_id, department_id, server_ts')
          .eq('employee_id', employeeId).is('voided_at', null)
          .order('server_ts', { ascending: true }).limit(200);
        const ordered = evs ?? [];
        // the open shift = events at/after the most recent clock_in with no clock_out after it
        let shiftStart: string | null = null;
        for (const e of ordered) {
          if (e.event_type === 'clock_in') shiftStart = e.server_ts as string;
          else if (e.event_type === 'clock_out') shiftStart = null;
        }
        if (!shiftStart) return error(409, 'not_clocked_in', 'That person is not currently clocked in.');
        const openEvents = ordered.filter((e) => (e.server_ts as string) >= shiftStart!);

        if (mode === 'cancel') {
          const reason = String(body.reason ?? '').trim() || 'admin cancelled open shift';
          const ids = openEvents.map((e) => e.id);
          await admin.from('punch_events').update({ voided_at: new Date().toISOString(), voided_by_auth_id: authUserId, void_reason: reason }).in('id', ids);
          await audit(admin, actorLabel, 'cancel_open_shift', 'punch_events', employeeId, { voided: ids, shiftStart }, { reason }, false);
          return json({ ok: true, mode, voided: ids.length });
        }

        const effectiveTs = body.effectiveTs ? String(body.effectiveTs) : new Date().toISOString();
        if (Number.isNaN(Date.parse(effectiveTs))) return error(400, 'bad_ts', 'effectiveTs must be a valid timestamp.');
        if (Date.parse(effectiveTs) <= Date.parse(shiftStart)) return error(400, 'bad_ts', 'Clock-out time must be after the clock-in.');
        const current = openEvents[openEvents.length - 1]; // current segment's salon/role
        const { data: emp } = await admin.from('employees').select('gusto_employee_uuid').eq('id', employeeId).maybeSingle();
        const { data: ins, error: e2 } = await admin.from('punch_events').insert({
          employee_id: employeeId, gusto_employee_uuid: emp?.gusto_employee_uuid ?? null, event_type: 'clock_out',
          server_ts: effectiveTs, employee_ts: effectiveTs,
          location_id: current?.location_id ?? null, department_id: current?.department_id ?? null,
          source: 'administrator', created_by_auth_id: authUserId,
          correction_reason: String(body.reason ?? 'admin clock-out'), pay_period_id: await ppIdFor(effectiveTs),
        }).select('id').maybeSingle();
        if (e2) return error(500, 'db_error', e2.message);
        await audit(admin, actorLabel, 'force_clock_out', 'punch_events', ins?.id ?? null, null, { employeeId, effectiveTs }, false);
        return json({ ok: true, mode, id: ins?.id });
      }

      // ---- labor detail for a day: who worked, salon, in/out, hours ----
      case 'labor_detail': {
        const date = String(body.date ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return error(400, 'bad_date', 'date must be YYYY-MM-DD.');
        const [{ data: locs }, { data: depts }, { data: es }] = await Promise.all([
          admin.from('locations').select('id, short_name'),
          admin.from('departments').select('id, title'),
          admin.from('employees').select('id, first_name, last_name, home_location_id, home_department_id'),
        ]);
        const locName = new Map((locs ?? []).map((l: any) => [l.id, l.short_name]));
        const deptName = new Map((depts ?? []).map((d: any) => [d.id, d.title]));
        const empById = new Map((es ?? []).map((e: any) => [e.id, e]));
        const fmt = (ts: string | null) => ts ? new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : null;
        const nf = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
        const rows: any[] = [];
        const push = (e: any, locId: string | null, deptId: string | null, hours: number, inT: string | null, outT: string | null, src: string) =>
          rows.push({ name: `${e.last_name}, ${e.first_name}`, location_id: locId, location: locId ? (locName.get(locId) ?? '') : '', department: deptId ? (deptName.get(deptId) ?? '') : '', in_time: inT, out_time: outT, hours: nf(hours), source: src });

        // Live punches for the day.
        const startTs = `${date}T00:00:00-05:00`, endTs = `${date}T23:59:59-04:00`;
        const { data: pev } = await admin.from('punch_events').select('employee_id, event_type, location_id, department_id, server_ts')
          .is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs).order('server_ts', { ascending: true });
        const byEmp = new Map<string, any[]>();
        for (const ev of pev ?? []) { const a = byEmp.get(ev.employee_id) ?? []; a.push(ev); byEmp.set(ev.employee_id, a); }
        // Live Team Time Clock punches — everyone who has them.
        for (const [empId, evs] of byEmp) {
          const e = empById.get(empId); if (!e) continue;
          const byLoc = new Map<string, { locId: string | null; deptId: string | null; secs: number; inTs: string; outTs: string | null; open: boolean }>();
          for (const s of deriveSegments(evs as StoredEvent[])) {
            const k = s.locationId ?? '';
            const cur = byLoc.get(k) ?? { locId: s.locationId, deptId: s.departmentId, secs: 0, inTs: s.startedAt, outTs: null, open: false };
            if (s.durationSeconds != null && s.endedAt != null) { cur.secs += s.durationSeconds; if (!cur.outTs || s.endedAt > cur.outTs) cur.outTs = s.endedAt; } else cur.open = true;
            if (s.startedAt < cur.inTs) cur.inTs = s.startedAt;
            byLoc.set(k, cur);
          }
          for (const v of byLoc.values()) push(e, v.locId, v.deptId, v.secs / 3600, fmt(v.inTs), v.open ? null : fmt(v.outTs), 'live');
        }
        rows.sort((a, b) => (a.location || '~~').localeCompare(b.location || '~~') || a.name.localeCompare(b.name));
        const totalHours = Math.round(rows.reduce((s, r) => s + r.hours, 0) * 100) / 100;
        return json({ ok: true, date, totalHours, rows });
      }

      // ---- guest counts per location (optional add-on, not included) ----
      case 'guest_counts': {
        const date = String(body.date ?? '');
        return json({ ok: true, date, configured: false, byLocation: {}, total: 0 });
      }

      // ---- timecard approve / lock / reopen ----
      case 'approve_timecard':
      case 'lock_timecard':
      case 'reopen_timecard': {
        const employeeId = String(body.employeeId); const payPeriodId = String(body.payPeriodId);
        if (!(await canManage(admin, scope, employeeId))) return error(403, 'out_of_scope', 'That employee is outside your locations.');
        const now = new Date().toISOString();
        const base = { employee_id: employeeId, pay_period_id: payPeriodId };
        let patch: Record<string, unknown> = {};
        if (body.type === 'approve_timecard') patch = { state: 'approved', approved_by_auth_id: authUserId, approved_at: now };
        if (body.type === 'lock_timecard') {
          if (!isAdmin(roles)) return error(403, 'forbidden', 'Only payroll admins can lock timecards.');
          patch = { state: 'locked', locked_by_auth_id: authUserId, locked_at: now };
        }
        if (body.type === 'reopen_timecard') {
          if (!isAdmin(roles)) return error(403, 'forbidden', 'Only payroll admins can reopen timecards.');
          const reason = String(body.reason ?? '');
          if (reason.trim().length < 3) return error(400, 'reason_required', 'A reason is required to reopen.');
          patch = { state: 'reopened', reopened_by_auth_id: authUserId, reopened_at: now, reopen_reason: reason };
        }
        const { error: e } = await admin.from('timecard_approvals').upsert({ ...base, ...patch }, { onConflict: 'employee_id,pay_period_id' });
        if (e) return error(500, 'db_error', e.message);
        await audit(admin, actorLabel, body.type, 'timecard_approvals', employeeId, null, { payPeriodId, ...patch }, true);
        return json({ ok: true });
      }

      case 'resolve_correction': {
        const correctionId = String(body.correctionId); const decision = String(body.decision);
        if (!['approved', 'rejected'].includes(decision)) return error(400, 'bad_decision', 'decision must be approved or rejected.');
        const { data: cr } = await admin.from('correction_requests').select('employee_id').eq('id', correctionId).maybeSingle();
        if (!cr) return error(404, 'no_request', 'Correction request not found.');
        if (!(await canManage(admin, scope, cr.employee_id))) return error(403, 'out_of_scope', 'Outside your locations.');
        const { error: e } = await admin.from('correction_requests').update({ status: decision, decision_note: body.note ?? null, decided_by_auth_id: authUserId, decided_at: new Date().toISOString() }).eq('id', correctionId);
        if (e) return error(500, 'db_error', e.message);
        await audit(admin, actorLabel, 'resolve_correction', 'correction_requests', correctionId, null, { decision }, false);
        return json({ ok: true });
      }

      // ---- payroll review: every employee's daily clock in/out for a whole
      //      pay period at once. A read-only "review everyone" grid. ----
      case 'period_review': {
        const start = String(body.start ?? ''), end = String(body.end ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return error(400, 'bad_range', 'start/end must be YYYY-MM-DD.');
        const startTs = `${start}T00:00:00-05:00`, endTs = `${end}T23:59:59-04:00`;
        const [{ data: es }, { data: pev }] = await Promise.all([
          admin.from('employees').select('id, first_name, last_name'),
          admin.from('punch_events').select('employee_id, event_type, location_id, department_id, server_ts').is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs).order('server_ts', { ascending: true }),
        ]);
        const empById = new Map((es ?? []).map((e: any) => [e.id, e]));
        const r2 = (n: number) => Math.round(n * 100) / 100;
        const fmt = (ts: string | null) => ts ? new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : null;
        const etDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
        const wd = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }); };

        const byEmp = new Map<string, any[]>();
        for (const ev of pev ?? []) { const a = byEmp.get(ev.employee_id) ?? []; a.push(ev); byEmp.set(ev.employee_id, a); }
        const liveDay = new Map<string, { inTs: string; outTs: string | null; secs: number; open: boolean }>();
        for (const [empId, evs] of byEmp) {
          for (const s of deriveSegments(evs as StoredEvent[])) {
            const day = etDay(s.startedAt); const k = `${empId}|${day}`;
            const cur = liveDay.get(k) ?? { inTs: s.startedAt, outTs: null, secs: 0, open: false };
            if (s.startedAt < cur.inTs) cur.inTs = s.startedAt;
            if (s.durationSeconds != null && s.endedAt != null) { cur.secs += s.durationSeconds; if (!cur.outTs || s.endedAt > cur.outTs) cur.outTs = s.endedAt; } else cur.open = true;
            liveDay.set(k, cur);
          }
        }
        // Late clock-out flag: a clock-out at 8:30 PM ET or later (requested by
        // the owner to spot possible forgotten/late punches during review).
        const LATE_CUTOFF = 20 * 60 + 30; // 20:30 ET, in minutes
        const lateOut = (iso: string | null): boolean => {
          if (!iso) return false;
          const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
          const h = Number(p.find((x) => x.type === 'hour')?.value ?? '0') % 24;
          const m = Number(p.find((x) => x.type === 'minute')?.value ?? '0');
          return h * 60 + m >= LATE_CUTOFF;
        };
        const rows: any[] = [];
        const push = (emp: any, date: string, inT: string | null, outT: string | null, hours: number, source: string, open = false, outLate = false) =>
          rows.push({ employee_id: emp.id, last_name: emp.last_name, first_name: emp.first_name, date, weekday: wd(date), in_time: inT, out_time: outT, hours: r2(hours), source, open, out_late: outLate });
        for (const [k, v] of liveDay) { const [empId, day] = k.split('|'); const emp = empById.get(empId); if (!emp) continue; push(emp, day, fmt(v.inTs), v.open ? null : fmt(v.outTs), v.secs / 3600, 'Team Time Clock', v.open, !v.open && lateOut(v.outTs)); }
        rows.sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name) || a.date.localeCompare(b.date));
        const totalHours = r2(rows.reduce((s, r) => s + r.hours, 0));
        return json({ ok: true, start, end, count: rows.length, totalHours, rows });
      }

      // ---- ADMIN TIMESHEET: load a whole pay period for one employee as a
      //      day-by-day grid (existing Team Time Clock segments prefilled). ----
      case 'timesheet_load': {
        const employeeId = String(body.employeeId);
        const start = String(body.start ?? ''), end = String(body.end ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return error(400, 'bad_range', 'start/end must be YYYY-MM-DD.');
        if (!(await canManage(admin, scope, employeeId))) return error(403, 'out_of_scope', 'That employee is outside your locations.');
        const startTs = `${start}T00:00:00-05:00`, endTs = `${end}T23:59:59-04:00`;
        const [{ data: pev }, { data: emp }] = await Promise.all([
          admin.from('punch_events').select('event_type, location_id, department_id, server_ts, source, created_by_auth_id, correction_reason').eq('employee_id', employeeId).is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs).order('server_ts', { ascending: true }),
          admin.from('employees').select('home_location_id, home_department_id').eq('id', employeeId).maybeSingle(),
        ]);
        const etDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
        const toLocal = (iso: string) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)); const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00'; return `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`; };
        const byDay = new Map<string, any[]>();
        for (const s of deriveSegments((pev ?? []) as StoredEvent[])) { const d = etDay(s.startedAt); const a = byDay.get(d) ?? []; a.push(s); byDay.set(d, a); }
        // Raw events grouped by day too — so we can show WHO entered each day
        // (admin who batch-entered it, or the employee who clocked in themselves).
        const rawByDay = new Map<string, any[]>();
        for (const ev of pev ?? []) { const d = etDay(ev.server_ts); const a = rawByDay.get(d) ?? []; a.push(ev); rawByDay.set(d, a); }
        const authIds = [...new Set((pev ?? []).filter((e: any) => e.source === 'administrator' && e.created_by_auth_id).map((e: any) => e.created_by_auth_id))];
        const nameByAuth = new Map<string, string>();
        if (authIds.length) {
          const { data: admins } = await admin.from('employees').select('auth_user_id, first_name, last_name').in('auth_user_id', authIds as string[]);
          for (const a of admins ?? []) nameByAuth.set(a.auth_user_id, `${a.first_name} ${a.last_name}`);
        }
        const days: any[] = [];
        const [sy, sm, sd] = start.split('-').map(Number); const [ey, em, ed] = end.split('-').map(Number);
        let cur = Date.UTC(sy, sm - 1, sd); const lastMs = Date.UTC(ey, em - 1, ed);
        while (cur <= lastMs) {
          const d = new Date(cur);
          const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
          const daySegs = (byDay.get(date) ?? []).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
          const segments = daySegs.map((s) => ({
            startLocal: toLocal(s.startedAt), endLocal: s.endedAt ? toLocal(s.endedAt) : null,
            locationId: s.locationId ?? null, departmentId: s.departmentId ?? null,
            hours: s.durationSeconds != null ? Math.round(s.durationSeconds / 3600 * 100) / 100 : null, open: s.endedAt == null,
          }));
          // Who entered/last-touched this day's punches.
          let entry: { by: string | null; source: string | null; reason: string | null } | null = null;
          const raw = rawByDay.get(date) ?? [];
          if (raw.length) {
            const adminEv = [...raw].reverse().find((e) => e.source === 'administrator' && e.created_by_auth_id);
            if (adminEv) entry = { by: nameByAuth.get(adminEv.created_by_auth_id) ?? 'an admin', source: 'administrator', reason: adminEv.correction_reason ?? null };
            else entry = { by: null, source: raw[raw.length - 1].source ?? null, reason: null };
          }
          days.push({ date, weekday: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }), segments, entry });
          cur += 86400000;
        }
        return json({ ok: true, start, end, home: { locationId: emp?.home_location_id ?? null, departmentId: emp?.home_department_id ?? null }, days });
      }

      // ---- ADMIN TIMESHEET: batch-write a whole week/period for one employee.
      //      "Replace day" semantics: each day sent voids that day's existing
      //      live punches and writes the given in/out pairs (empty = clear day).
      //      No reason required — trusted admins — but every punch records the
      //      acting admin (created_by_auth_id) plus one audit row. ----
      case 'batch_day_entry': {
        const employeeId = String(body.employeeId);
        if (!(await canManage(admin, scope, employeeId))) return error(403, 'out_of_scope', 'That employee is outside your locations.');
        const daysIn = Array.isArray(body.days) ? (body.days as Array<{ date: string; segments: Array<{ startTs: string; endTs?: string | null; locationId?: string | null; departmentId?: string | null }> }>) : [];
        if (!daysIn.length) return error(400, 'nothing', 'No days to save.');
        const { data: emp } = await admin.from('employees').select('gusto_employee_uuid, home_location_id, home_department_id').eq('id', employeeId).maybeSingle();
        if (!emp) return error(404, 'no_employee', 'Employee not found.');
        const reason = (String(body.reason ?? '').trim() || 'admin timesheet entry').slice(0, 200);
        for (const d of daysIn) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return error(400, 'bad_date', `Bad date ${d.date}.`);
          for (const s of d.segments ?? []) {
            if (Number.isNaN(Date.parse(s.startTs))) return error(400, 'bad_ts', `Bad start time on ${d.date}.`);
            if (s.endTs) { // end optional — a start-only entry is an open clock-in
              if (Number.isNaN(Date.parse(s.endTs))) return error(400, 'bad_ts', `Bad end time on ${d.date}.`);
              if (Date.parse(s.endTs) <= Date.parse(s.startTs)) return error(400, 'bad_range', `Clock-out must be after clock-in on ${d.date}.`);
              if (Date.parse(s.endTs) - Date.parse(s.startTs) > 20 * 3600 * 1000) return error(400, 'too_long', `Over 20 hours on ${d.date}.`);
            }
          }
        }
        let inserted = 0; const touched: string[] = [];
        for (const d of daysIn) {
          const startTs = `${d.date}T00:00:00-05:00`, endTs = `${d.date}T23:59:59-04:00`;
          const { data: existing } = await admin.from('punch_events').select('id').eq('employee_id', employeeId).is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs);
          const ids = (existing ?? []).map((e: any) => e.id);
          if (ids.length) await admin.from('punch_events').update({ voided_at: new Date().toISOString(), voided_by_auth_id: authUserId, void_reason: reason }).in('id', ids);
          const rows: any[] = [];
          for (const s of d.segments ?? []) {
            const locId = s.locationId ?? emp.home_location_id ?? null;
            const deptId = s.departmentId ?? emp.home_department_id ?? null;
            const base = { employee_id: employeeId, gusto_employee_uuid: emp.gusto_employee_uuid, location_id: locId, department_id: deptId, source: 'administrator', created_by_auth_id: authUserId, correction_reason: reason };
            rows.push({ ...base, event_type: 'clock_in', server_ts: s.startTs, employee_ts: s.startTs, pay_period_id: await ppIdFor(s.startTs) });
            if (s.endTs) rows.push({ ...base, event_type: 'clock_out', server_ts: s.endTs, employee_ts: s.endTs, pay_period_id: await ppIdFor(s.endTs) });
          }
          if (rows.length) { const { error: e } = await admin.from('punch_events').insert(rows); if (e) return error(500, 'db_error', e.message); inserted += rows.length; }
          touched.push(d.date);
        }
        await audit(admin, actorLabel, 'batch_day_entry', 'punch_events', employeeId, null, { days: touched, punches: inserted, reason }, false);
        return json({ ok: true, daysApplied: touched.length, punchesInserted: inserted });
      }

      // ---- migration status: who's invited / registered / clocked in on Team Time Clock ----
      case 'migration_status': {
        const [{ data: es }, { data: audits }, { data: pev }] = await Promise.all([
          admin.from('employees').select('id, first_name, last_name, timekeeping_access, chat_user_id, auth_user_id, last_login_at').neq('timekeeping_access', 'disabled').neq('timekeeping_access', 'terminated_in_gusto'),
          admin.from('audit_logs').select('entity_id, action').in('action', ['invite_sms', 'invite_email', 'invite_teamchat']),
          admin.from('punch_events').select('employee_id').eq('source', 'employee_mobile').is('voided_at', null),
        ]);
        const invited = new Set((audits ?? []).map((a: any) => a.entity_id).filter(Boolean));
        const clocked = new Set((pev ?? []).map((p: any) => p.employee_id));
        const rows = (es ?? []).map((e: any) => ({
          employee_id: e.id, name: `${e.last_name}, ${e.first_name}`,
          enabled: e.timekeeping_access === 'enabled',
          invited: invited.has(e.id),
          registered: !!(e.chat_user_id || e.auth_user_id),
          last_login_at: e.last_login_at ?? null,
          clocked_in_here: clocked.has(e.id),
        }));
        // Not-done first (needs attention), then by name.
        rows.sort((a: any, b: any) => Number(a.clocked_in_here) - Number(b.clocked_in_here) || Number(a.registered) - Number(b.registered) || a.name.localeCompare(b.name));
        const summary = { total: rows.length, invited: rows.filter((r: any) => r.invited).length, registered: rows.filter((r: any) => r.registered).length, clocked: rows.filter((r: any) => r.clocked_in_here).length };
        return json({ ok: true, summary, rows });
      }

      // ---- approve AND auto-apply a correction in one click ----
      // Reads what the employee asked for and makes the exact change (edit a
      // punch's time/location/role, or add a missing punch), then marks the
      // request approved. Admins no longer approve here then re-edit in Timecards.
      case 'apply_correction': {
        const correctionId = String(body.correctionId);
        const { data: cr } = await admin.from('correction_requests')
          .select('employee_id, kind, target_event_id, requested_ts, requested_location_id, requested_department_id, explanation, status, created_at')
          .eq('id', correctionId).maybeSingle();
        if (!cr) return error(404, 'no_request', 'Correction request not found.');
        if (!(await canManage(admin, scope, cr.employee_id))) return error(403, 'out_of_scope', 'Outside your locations.');
        if (cr.status !== 'pending') return error(409, 'already_resolved', 'This request was already handled.');

        const reason = `Approved correction: ${(cr.explanation || '').slice(0, 140)}`.trim();
        // `force` = a single, explicit "Approve & fix" click: the admin has
        // reviewed this one request, so trust and apply the time they're looking
        // at instead of letting the safety engine bail to "needs review" (that
        // engine is only for the bulk "Approve & fix all safe" button).
        // overrideTs/Loc/Dept = the admin typed values inline (used when the
        // request itself carried no time/salon/role).
        const force = body.force === true;
        const overrideTs = body.overrideTs ? String(body.overrideTs) : null;
        if (overrideTs && Number.isNaN(Date.parse(overrideTs))) return error(400, 'bad_ts', 'The time you entered is invalid.');
        const hasOverLoc = 'overrideLocationId' in body;
        const hasOverDept = 'overrideDepartmentId' in body;
        const adminEntered = !!(overrideTs || hasOverLoc || hasOverDept);
        const reqTs = overrideTs ?? (cr.requested_ts && !Number.isNaN(Date.parse(cr.requested_ts)) ? cr.requested_ts : null);
        const reqLoc = hasOverLoc ? ((body.overrideLocationId as string) || null) : cr.requested_location_id;
        const reqDept = hasOverDept ? ((body.overrideDepartmentId as string) || null) : cr.requested_department_id;

        // Edit an existing punch (append-only: void original, insert corrected).
        const editEvent = async (patch: { newTs?: string; locationId?: string | null; departmentId?: string | null }) => {
          const { data: orig } = await admin.from('punch_events').select('*').eq('id', cr.target_event_id).is('voided_at', null).maybeSingle();
          if (!orig) throw error(409, 'punch_changed', 'The punch this request points to has since changed — open Timecards to fix it by hand.');
          const newTs = patch.newTs ?? orig.server_ts;
          await admin.from('punch_events').update({ voided_at: new Date().toISOString(), voided_by_auth_id: authUserId, void_reason: reason }).eq('id', cr.target_event_id);
          await admin.from('punch_events').insert({
            employee_id: orig.employee_id, gusto_employee_uuid: orig.gusto_employee_uuid, event_type: orig.event_type,
            server_ts: newTs, employee_ts: orig.employee_ts,
            location_id: patch.locationId !== undefined ? patch.locationId : orig.location_id,
            department_id: patch.departmentId !== undefined ? patch.departmentId : orig.department_id,
            note: orig.note, source: 'administrator', created_by_auth_id: authUserId,
            original_event_id: cr.target_event_id, correction_reason: reason, pay_period_id: await ppIdFor(newTs),
          });
        };

        let applied = false;
        let appliedTs: string | null = null;
        let appliedSource: string | null = null;
        if (cr.kind === 'incorrect_time' && cr.target_event_id && reqTs) {
          await editEvent({ newTs: reqTs, locationId: hasOverLoc ? reqLoc : undefined, departmentId: hasOverDept ? reqDept : undefined });
          applied = true; appliedTs = reqTs; appliedSource = overrideTs ? 'admin_entered' : 'requested_time';
        } else if (cr.kind === 'wrong_location' && cr.target_event_id && reqLoc) {
          await editEvent({ locationId: reqLoc }); applied = true; appliedSource = hasOverLoc ? 'admin_entered' : 'requested_location';
        } else if (cr.kind === 'wrong_department' && cr.target_event_id && reqDept) {
          await editEvent({ departmentId: reqDept }); applied = true; appliedSource = hasOverDept ? 'admin_entered' : 'requested_department';
        } else if (cr.kind === 'missed_clock_in' || cr.kind === 'missed_clock_out') {
          let chosenTs: string | null = null;
          let chosenSource = 'requested_time';
          if ((force || adminEntered) && reqTs) {
            // Explicit single approve (or an inline-entered time): apply as reviewed.
            chosenTs = reqTs; chosenSource = overrideTs ? 'admin_entered' : 'requested_time';
          } else {
            // Bulk "Approve & fix all safe": the engine decides the time (exact
            // offline punch > explicit stated time > non-default picker time),
            // validates it, and REFUSES rather than guessing when confidence is low.
            const targetDate = cr.requested_ts && !Number.isNaN(Date.parse(cr.requested_ts)) ? etDateStr(cr.requested_ts) : null;
            let dayPunches: Array<{ event_type: string; server_ts: string }> = [];
            if (targetDate) {
              const dStart = `${targetDate}T00:00:00-05:00`, dEnd = `${targetDate}T23:59:59-04:00`;
              const { data: dp } = await admin.from('punch_events').select('event_type, server_ts').eq('employee_id', cr.employee_id).is('voided_at', null).gte('server_ts', dStart).lte('server_ts', dEnd);
              dayPunches = (dp ?? []) as Array<{ event_type: string; server_ts: string }>;
            }
            const decision = resolveCorrection({ kind: cr.kind, explanation: cr.explanation ?? '', requestedTs: cr.requested_ts, createdAt: cr.created_at, dayPunches });
            if (decision.decision !== 'apply') {
              const why = decision.decision === 'review' ? decision.reason : 'not enough detail to apply automatically';
              await audit(admin, actorLabel, 'apply_correction_deferred', 'correction_requests', correctionId, null, { kind: cr.kind, reason: why }, false);
              return json({ ok: true, applied: false, needsManual: true, message: `Needs a time — ${why}. Enter the time right here and apply.` });
            }
            chosenTs = decision.ts; chosenSource = decision.source;
          }
          if (!chosenTs) return json({ ok: true, applied: false, needsManual: true, message: 'Enter the time right here and apply.' });
          const { data: emp } = await admin.from('employees').select('gusto_employee_uuid, home_location_id, home_department_id').eq('id', cr.employee_id).maybeSingle();
          const eventType = cr.kind === 'missed_clock_in' ? 'clock_in' : 'clock_out';
          await admin.from('punch_events').insert({
            employee_id: cr.employee_id, gusto_employee_uuid: emp?.gusto_employee_uuid, event_type: eventType,
            server_ts: chosenTs, employee_ts: chosenTs,
            location_id: reqLoc ?? emp?.home_location_id ?? null,
            department_id: reqDept ?? emp?.home_department_id ?? null,
            source: 'administrator', created_by_auth_id: authUserId, correction_reason: `${reason} [${chosenSource}]`, pay_period_id: await ppIdFor(chosenTs),
          });
          applied = true; appliedTs = chosenTs; appliedSource = chosenSource;
        }

        // Nothing to apply yet (e.g. "other", or no time/salon/role given) — let
        // the admin enter the details inline and apply, or open Timecards.
        if (!applied) return json({ ok: true, applied: false, needsManual: true, message: 'Enter the correct time/salon/role here and apply — or open Timecards for a hands-on fix.' });

        await admin.from('correction_requests').update({ status: 'approved', decided_by_auth_id: authUserId, decided_at: new Date().toISOString(), applied_ts: appliedTs, applied_source: appliedSource }).eq('id', correctionId);
        await audit(admin, actorLabel, 'apply_correction', 'correction_requests', correctionId, null, { kind: cr.kind, applied: true, applied_ts: appliedTs, source: appliedSource, force, adminEntered }, false);
        return json({ ok: true, applied: true });
      }

      // ---- edit an existing employee's phone / home location / home department ----
      case 'update_employee': {
        const employeeId = String(body.employeeId);
        if (!(await canManage(admin, scope, employeeId))) return error(403, 'out_of_scope', 'That employee is outside your locations.');
        const patch: Record<string, unknown> = {};
        if ('phone' in body) patch.phone = normPhone(String(body.phone ?? '')) || null;
        if ('homeLocationId' in body) patch.home_location_id = body.homeLocationId || null;
        if ('homeDepartmentId' in body) patch.home_department_id = body.homeDepartmentId || null;
        if (Object.keys(patch).length === 0) return error(400, 'nothing', 'No changes provided.');
        const { data: before } = await admin.from('employees').select('phone, home_location_id, home_department_id').eq('id', employeeId).maybeSingle();
        const { error: e } = await admin.from('employees').update(patch).eq('id', employeeId);
        if (e) return error(500, 'db_error', e.message);
        // Keep the home location/department in the permitted-assignment lists.
        if (patch.home_location_id) await admin.from('employee_location_assignments').upsert({ employee_id: employeeId, location_id: patch.home_location_id, is_home: true }, { onConflict: 'employee_id,location_id', ignoreDuplicates: true });
        if (patch.home_department_id) await admin.from('employee_department_assignments').upsert({ employee_id: employeeId, department_id: patch.home_department_id, is_default: true }, { onConflict: 'employee_id,department_id', ignoreDuplicates: true });
        await audit(admin, actorLabel, 'update_employee', 'employees', employeeId, before, patch, false);
        return json({ ok: true });
      }

      // ---- manually create an employee (before they're in Gusto) ----
      case 'create_employee': {
        if (!isAdmin(roles)) return error(403, 'forbidden', 'Administrator access required.');
        const first = String(body.firstName ?? '').trim(), last = String(body.lastName ?? '').trim(), email = String(body.email ?? '').trim().toLowerCase();
        if (!first || !last || !/.+@.+/.test(email)) return error(400, 'bad_input', 'First name, last name and a valid email are required.');
        const { data: dup } = await admin.from('employees').select('id').ilike('email', email).maybeSingle();
        if (dup) return error(409, 'email_exists', 'An employee with that email already exists.');
        const { data: co } = await admin.from('employees').select('gusto_company_uuid').not('gusto_company_uuid', 'is', null).limit(1).maybeSingle();
        const { data: ins, error: e } = await admin.from('employees').insert({
          gusto_company_uuid: co?.gusto_company_uuid ?? null, gusto_employee_uuid: null, is_manual: true,
          first_name: first, last_name: last, email, phone: normPhone(String(body.phone ?? '')) || null,
          timekeeping_access: ['enabled', 'pending_review'].includes(String(body.access)) ? String(body.access) : 'pending_review',
          home_location_id: body.homeLocationId ?? null, home_department_id: body.homeDepartmentId ?? null,
          created_by_auth_id: authUserId,
        }).select('id').maybeSingle();
        if (e) return error(500, 'db_error', e.message);
        if (body.homeLocationId) await admin.from('employee_location_assignments').insert({ employee_id: ins!.id, location_id: body.homeLocationId, is_home: true });
        if (body.homeDepartmentId) await admin.from('employee_department_assignments').insert({ employee_id: ins!.id, department_id: body.homeDepartmentId, is_default: true });
        await audit(admin, actorLabel, 'create_employee', 'employees', ins?.id ?? null, null, { email, is_manual: true }, false);
        return json({ ok: true, id: ins?.id });
      }

      // ---- match a manual employee to their Gusto record (Gusto = spelling authority) ----
      case 'match_gusto': {
        if (!isAdmin(roles)) return error(403, 'forbidden', 'Administrator access required.');
        const employeeId = String(body.employeeId); const gustoUuid = String(body.gustoEmployeeUuid);
        if (!/^[0-9a-f-]{36}$/i.test(gustoUuid)) return error(400, 'bad_uuid', 'A valid Gusto employee UUID is required.');
        const { data: clash } = await admin.from('employees').select('id').eq('gusto_employee_uuid', gustoUuid).maybeSingle();
        if (clash && clash.id !== employeeId) return error(409, 'uuid_taken', 'That Gusto employee is already linked to someone else.');
        const patch: Record<string, unknown> = { gusto_employee_uuid: gustoUuid, is_manual: false };
        if (body.firstName) patch.first_name = String(body.firstName); // Gusto spelling wins
        if (body.lastName) patch.last_name = String(body.lastName);
        const { error: e } = await admin.from('employees').update(patch).eq('id', employeeId);
        if (e) return error(500, 'db_error', e.message);
        // backfill the denormalized uuid onto that employee's punches
        await admin.from('punch_events').update({ gusto_employee_uuid: gustoUuid }).eq('employee_id', employeeId).is('gusto_employee_uuid', null);
        await audit(admin, actorLabel, 'match_gusto', 'employees', employeeId, null, { gustoUuid }, true);
        return json({ ok: true });
      }

      // ---- locations / departments config ----
      case 'upsert_location': {
        if (!isAdmin(roles)) return error(403, 'forbidden', 'Administrator access required.');
        const row: Record<string, unknown> = {
          display_name: String(body.displayName ?? '').trim(), short_name: String(body.shortName ?? '').trim(),
          address: body.address ?? null, punch_policy: body.punchPolicy ?? 'none',
          is_active: body.isActive ?? true, sort_order: body.sortOrder ?? 50,
        };
        if (!row.display_name || !row.short_name) return error(400, 'bad_input', 'Display name and short name are required.');
        const q = body.id ? admin.from('locations').update(row).eq('id', String(body.id)) : admin.from('locations').insert(row);
        const { error: e } = await q;
        if (e) return error(500, 'db_error', e.message);
        await audit(admin, actorLabel, body.id ? 'edit_location' : 'add_location', 'locations', (body.id as string) ?? null, null, row, false);
        return json({ ok: true });
      }
      case 'upsert_department': {
        if (!isAdmin(roles)) return error(403, 'forbidden', 'Administrator access required.');
        const row: Record<string, unknown> = { title: String(body.title ?? '').trim(), is_active: body.isActive ?? true, sort_order: body.sortOrder ?? 50 };
        if ('gustoJobTitle' in body) row.gusto_job_title = body.gustoJobTitle ? String(body.gustoJobTitle).trim() : null;
        if (!row.title) return error(400, 'bad_input', 'A title is required.');
        const q = body.id ? admin.from('departments').update(row).eq('id', String(body.id)) : admin.from('departments').insert(row);
        const { error: e } = await q;
        if (e) return error(500, 'db_error', e.message);
        await audit(admin, actorLabel, body.id ? 'edit_department' : 'add_department', 'departments', (body.id as string) ?? null, null, row, false);
        return json({ ok: true });
      }

      // ---- toggle/adjust an app setting (whitelisted) ----
      case 'set_setting': {
        if (!roles.includes('system_admin')) return error(403, 'forbidden', 'Only a system administrator can change settings.');
        const key = String(body.key);
        const ALLOWED = ['clockout_reminder_enabled', 'clockout_reminder_hours', 'require_location', 'require_department', 'allow_location_transfers', 'allow_department_transfers', 'long_shift_alert_hours', 'max_shift_hours'];
        if (!ALLOWED.includes(key)) return error(400, 'bad_key', 'That setting cannot be changed here.');
        const { error: e } = await admin.from('app_settings').upsert({ key, value: body.value }, { onConflict: 'key' });
        if (e) return error(500, 'db_error', e.message);
        await audit(admin, actorLabel, 'set_setting', 'app_settings', null, { key }, { value: body.value }, false);
        return json({ ok: true });
      }

      // ---- ADMIN read-through: the admin screens (Employees, Timecards,
      //      Timesheet) used to read the DB directly, which only works under an
      //      email (native) login. Under Phone+PIN (Central/chat token) those
      //      RLS-gated reads return nothing. These service-role endpoints work
      //      for ANY staff token, so the admin panel works on any machine. ----
      case 'admin_bootstrap': {
        const [{ data: emps }, { data: ur }, { data: l }, { data: d }] = await Promise.all([
          admin.from('employees').select('id, first_name, last_name, email, phone, primary_job_title, gusto_department_name, timekeeping_access, auth_user_id, chat_user_id, last_login_at, home_location_id, home_department_id, gusto_employee_uuid, is_manual, can_manage_own_time').order('last_name'),
          admin.from('user_roles').select('auth_user_id, role'),
          admin.from('locations').select('id, short_name').eq('is_active', true).order('sort_order'),
          admin.from('departments').select('id, title').eq('is_active', true).order('sort_order'),
        ]);
        return json({ ok: true, employees: emps ?? [], userRoles: ur ?? [], locations: l ?? [], departments: d ?? [] });
      }

      case 'timecard_detail': {
        const employeeId = String(body.employeeId);
        const start = String(body.start ?? ''), end = String(body.end ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return error(400, 'bad_range', 'start/end must be YYYY-MM-DD.');
        if (!(await canManage(admin, scope, employeeId))) return error(403, 'out_of_scope', 'That employee is outside your locations.');
        const startTs = `${start}T00:00:00-05:00`, endTs = `${end}T23:59:59-04:00`;
        const { data: ev } = await admin.from('punch_events')
          .select('id, event_type, server_ts, location_id, department_id, source, correction_reason')
          .eq('employee_id', employeeId).is('voided_at', null)
          .gte('server_ts', startTs).lte('server_ts', endTs).order('server_ts', { ascending: true });
        const { data: ppRow } = await admin.from('pay_periods').select('id').eq('start_date', start).eq('end_date', end).maybeSingle();
        const payPeriodId = ppRow?.id ?? null;
        let approval: { state: string } | null = null;
        if (payPeriodId) {
          const { data: ap } = await admin.from('timecard_approvals').select('state').eq('employee_id', employeeId).eq('pay_period_id', payPeriodId).maybeSingle();
          approval = ap ?? null;
        }
        return json({ ok: true, events: ev ?? [], approval, payPeriodId });
      }

      case 'live_status': {
        // "Working now" = every employee whose most recent (non-voided) punch is
        // NOT a clock_out. Computed here with the service-role client rather than
        // the otc.live_status() RPC: that RPC guards on otc.is_staff()/auth.uid(),
        // which is null under this service-role dispatcher, so it raised and the
        // screen silently showed 0 even mid-shift. This endpoint is already
        // authorized above (staff check), so the guard is redundant here.
        // A 14-day window comfortably covers anyone currently on the clock while
        // keeping the read small (shifts are not expected to run overnight; long-open shifts
        // are surfaced separately by the overnight/16h flags).
        const sinceIso = new Date(Date.now() - 14 * 86400_000).toISOString();
        const [{ data: evs }, { data: emps }, { data: l }, { data: d }] = await Promise.all([
          admin.from('punch_events').select('employee_id, event_type, location_id, department_id, server_ts')
            .is('voided_at', null).gte('server_ts', sinceIso).order('server_ts', { ascending: true }),
          admin.from('employees').select('id, first_name, last_name'),
          admin.from('locations').select('id, short_name'),
          admin.from('departments').select('id, title'),
        ]);
        const empName = new Map((emps ?? []).map((x: any) => [x.id, x]));
        const locName = new Map((l ?? []).map((x: any) => [x.id, x.short_name]));
        const deptName = new Map((d ?? []).map((x: any) => [x.id, x.title]));
        // Walk events in order: last event per person = their current state; also
        // remember their latest clock_in as the shift start ("since").
        const latest = new Map<string, any>();
        const lastClockIn = new Map<string, string>();
        for (const e of (evs ?? []) as any[]) {
          latest.set(e.employee_id, e);
          if (e.event_type === 'clock_in') lastClockIn.set(e.employee_id, e.server_ts);
        }
        const rows = [] as Array<{ employeeId: string; employee: string; location: string; department: string; since: string }>;
        for (const [empId, ev] of latest) {
          if (ev.event_type === 'clock_out') continue; // shift ended -> not working
          const emp = empName.get(empId);
          if (!emp) continue;
          rows.push({
            employeeId: empId,
            employee: `${emp.first_name} ${emp.last_name}`,
            location: locName.get(ev.location_id) ?? '—',
            department: deptName.get(ev.department_id) ?? '—',
            since: lastClockIn.get(empId) ?? ev.server_ts,
          });
        }
        rows.sort((a, b) => a.employee.localeCompare(b.employee));
        return json({ ok: true, rows });
      }

      case 'corrections_list': {
        const [{ data: reqs }, { data: l }, { data: d }] = await Promise.all([
          admin.from('correction_requests').select('id, employee_id, kind, requested_ts, requested_location_id, requested_department_id, target_event_id, explanation, status, created_at, applied_ts, applied_source').order('created_at', { ascending: false }).limit(100),
          admin.from('locations').select('id, short_name').order('sort_order'),
          admin.from('departments').select('id, title').order('sort_order'),
        ]);
        const ids = [...new Set((reqs ?? []).map((r: any) => r.employee_id))];
        const names: Record<string, string> = {};
        // nameSort: a "lastname\u0000firstname" key (lowercased) so the Corrections
        // list can sort alphabetically by last name, then first — robust against
        // multi-word names (requested by the owner).
        const nameSort: Record<string, string> = {};
        if (ids.length) {
          const { data: emps } = await admin.from('employees').select('id, first_name, last_name').in('id', ids as string[]);
          for (const e of emps ?? []) {
            const first = String((e as any).first_name ?? ''), last = String((e as any).last_name ?? '');
            names[(e as any).id] = `${first} ${last}`.trim();
            nameSort[(e as any).id] = `${last}\u0000${first}`.toLowerCase();
          }
        }
        return json({ ok: true, requests: reqs ?? [], names, nameSort, locations: l ?? [], departments: d ?? [] });
      }

      // ---- Setup screen: locations/departments config + status settings ----
      case 'setup_load': {
        const KEYS = ['gusto_last_sync', 'clockout_reminder_enabled', 'clockout_reminder_hours'];
        const [{ data: l }, { data: d }, { data: settings }] = await Promise.all([
          admin.from('locations').select('id, display_name, short_name, address, is_active, sort_order').order('sort_order'),
          admin.from('departments').select('id, title, is_active, sort_order, gusto_job_title').order('sort_order'),
          admin.from('app_settings').select('key, value').in('key', KEYS),
        ]);
        const s: Record<string, unknown> = {};
        for (const r of settings ?? []) s[(r as any).key] = (r as any).value;
        return json({ ok: true, locations: l ?? [], departments: d ?? [], settings: s });
      }

      // ---- Reports: hours from Team Time Clock punches.
      //      Computed server-side so it works under any login and full years
      //      stay exact regardless of row count. ----
      case 'reports_hours': {
        const start = String(body.start ?? ''), end = String(body.end ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return error(400, 'bad_range', 'start/end must be YYYY-MM-DD.');
        const employeeId = body.employeeId ? String(body.employeeId) : '';
        const startTs = `${start}T00:00:00-05:00`, endTs = `${end}T23:59:59-04:00`;
        const { data: es } = await admin.from('employees').select('id, first_name, last_name, email, gusto_employee_uuid');
        const dir = new Map((es ?? []).map((e: any) => [e.id, e]));

        if (employeeId) {
          if (!(await canManage(admin, scope, employeeId))) return error(403, 'out_of_scope', 'That employee is outside your locations.');
          const e = dir.get(employeeId); const name = e ? `${e.first_name} ${e.last_name}` : '—';
          const [{ data: events }] = await Promise.all([
            admin.from('punch_events').select('event_type, location_id, department_id, server_ts').eq('employee_id', employeeId).is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs).order('server_ts', { ascending: true }),
          ]);
          const liveSecs = new Map<string, number>();
          for (const s of deriveSegments((events as StoredEvent[]) ?? [])) { if (s.durationSeconds == null || s.endedAt == null) continue; const d = localDateKey(new Date(s.startedAt)); liveSecs.set(d, (liveSecs.get(d) ?? 0) + s.durationSeconds); }
          const detail: any[] = []; let days = 0, reg = 0, ot = 0, tot = 0;
          for (const [d, secs] of liveSecs) { const h = secondsToDecimalHours(secs); detail.push({ date: d, employee_name: name, email: e?.email ?? null, gusto_employee_uuid: e?.gusto_employee_uuid ?? null, source: 'live', total_hours: h, regular_hours: h, overtime_hours: 0 }); days++; reg += h; tot += h; }
          detail.sort((a, b) => a.date.localeCompare(b.date));
          return json({ ok: true, summary: [{ key: employeeId, name, former: false, days, regular: reg, overtime: ot, total: tot }], detail });
        }

        // All employees, from live punches. Restricted to admins (a manager's scoped
        // view would need per-location filtering; they can still run per-person).
        if (!isAdmin(roles)) return error(403, 'forbidden', 'Only an administrator can run the all-employees report. Pick a specific employee.');
        const sum = new Map<string, any>();
        const { data: events } = await admin.from('punch_events').select('employee_id, event_type, location_id, department_id, server_ts').is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs).order('server_ts', { ascending: true }).limit(50000);
        const byEmp = new Map<string, StoredEvent[]>();
        for (const ev of events ?? []) { const a = byEmp.get((ev as any).employee_id) ?? []; a.push(ev as StoredEvent); byEmp.set((ev as any).employee_id, a); }
        for (const [id, evs] of byEmp) {
          const e = dir.get(id); if (!e) continue;
          const perDay = new Map<string, number>();
          for (const s of deriveSegments(evs)) { if (s.durationSeconds == null || s.endedAt == null) continue; const d = localDateKey(new Date(s.startedAt)); perDay.set(d, (perDay.get(d) ?? 0) + s.durationSeconds); }
          let addDays = 0, addHrs = 0;
          for (const secs of perDay.values()) { addDays++; addHrs += secondsToDecimalHours(secs); }
          if (addDays === 0) continue;
          const r = sum.get(id) ?? { key: id, name: `${e.first_name} ${e.last_name}`, former: false, days: 0, regular: 0, overtime: 0, total: 0 };
          r.days += addDays; r.regular += addHrs; r.total += addHrs;
          sum.set(id, r);
        }
        const summary = [...sum.values()].sort((a, b) => a.name.localeCompare(b.name));
        return json({ ok: true, summary, detail: [] });
      }

      // ---- pre-payroll safety: overnight spans (clock-in one ET day, clock-out
      //      the next). Team never works overnight, so these are always a forgotten
      //      clock-out. They're excluded from hour totals until fixed; this lists
      //      them so a human can correct each one. ----
      case 'overnight_spans': {
        const start = String(body.start ?? ''), end = String(body.end ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return error(400, 'bad_range', 'start/end must be YYYY-MM-DD.');
        const startTs = `${start}T00:00:00-05:00`, endTs = `${end}T23:59:59-04:00`;
        const [{ data: pev }, { data: es }] = await Promise.all([
          admin.from('punch_events').select('employee_id, event_type, location_id, department_id, server_ts').is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs).order('server_ts', { ascending: true }),
          admin.from('employees').select('id, first_name, last_name'),
        ]);
        const nameById = new Map((es ?? []).map((e: any) => [e.id, `${e.first_name} ${e.last_name}`]));
        const etDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
        const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const byEmp = new Map<string, any[]>();
        for (const ev of pev ?? []) { const a = byEmp.get(ev.employee_id) ?? []; a.push(ev); byEmp.set(ev.employee_id, a); }
        const rows: any[] = [];
        for (const [empId, evs] of byEmp) {
          for (const s of deriveSegments(evs as StoredEvent[])) {
            if (s.crossesMidnight && s.endedAt && s.durationSeconds != null) {
              rows.push({ employee_id: empId, name: nameById.get(empId) ?? 'Employee', in_ts: s.startedAt, out_ts: s.endedAt, in_label: fmt(s.startedAt), out_label: fmt(s.endedAt), in_day: etDay(s.startedAt), out_day: etDay(s.endedAt), hours: Math.round(s.durationSeconds / 3600 * 100) / 100 });
            }
          }
        }
        rows.sort((a, b) => a.in_ts.localeCompare(b.in_ts));
        return json({ ok: true, count: rows.length, rows });
      }

      default:
        return error(400, 'bad_action', 'Unknown action.');
    }
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] admin error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

// ---- helpers ----
async function managedScope(admin: ReturnType<typeof import('./_shared/supabase').adminClient>, authUserId: string, roles: string[]): Promise<Scope> {
  if (isAdmin(roles)) return 'all';
  const { data } = await admin.from('user_roles').select('location_id').eq('auth_user_id', authUserId).eq('role', 'location_manager');
  if (!data?.length) return [];
  if (data.some((r: { location_id: string | null }) => r.location_id === null)) return 'all';
  return data.map((r: { location_id: string }) => r.location_id);
}

async function canManage(admin: ReturnType<typeof import('./_shared/supabase').adminClient>, scope: Scope, employeeId: string): Promise<boolean> {
  if (scope === 'all') return true;
  if (!scope.length) return false;
  const { data } = await admin.from('employee_location_assignments').select('location_id').eq('employee_id', employeeId);
  return (data ?? []).some((a: { location_id: string }) => (scope as string[]).includes(a.location_id));
}

async function audit(admin: ReturnType<typeof import('./_shared/supabase').adminClient>, actorLabel: string, action: string, entity: string, entityId: string | null, before: unknown, after: unknown, security: boolean) {
  await admin.from('audit_logs').insert({ actor_label: actorLabel, action, entity, entity_id: entityId, before_value: before ?? null, after_value: after ?? null, is_security_event: security });
}

function normPhone(raw: string): string {
  const s = (raw || '').trim(); if (!s) return '';
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : '';
}

export const config = { path: '/api/admin' };
