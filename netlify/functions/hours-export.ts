import { adminClient } from './_shared/supabase';
import { json, error } from './_shared/http';
import { buildHoursCsv } from '../../src/lib/gusto/csv';
import { deriveSegments, type Segment } from '../../src/lib/domain/segments';
import { localDateKey } from '../../src/lib/time';
import type { StoredEvent } from '../../src/lib/domain/punch';

// Read-only hours feed for OTHER Team dashboards (like reading Gusto). Returns
// daily hours per employee from live punches. Machine-to-machine auth via the x-api-key header (HOURS_API_KEY).
//   GET /api/hours?start=YYYY-MM-DD&end=YYYY-MM-DD[&employee=<email>][&format=csv]

interface DailyRow {
  date: string;
  employee_id: string | null;
  employee_name: string;
  email: string | null;
  gusto_employee_uuid: string | null;
  source: 'live';
  total_hours: number;
  regular_hours: number;
  overtime_hours: number;
}

export default async (req: Request): Promise<Response> => {
  try {
    // Accept either the legacy hours key or the shared timekeeping API key, so a
    // consumer (e.g. the payroll app) can use one key across /api/hours and /api/timekeeping.
    const keys = [process.env.HOURS_API_KEY, process.env.TIMEKEEPING_API_KEY, process.env.TEAM_CHAT_API_KEY].filter(Boolean);
    if (!keys.length) return error(503, 'not_configured', 'No API key is set on the server.');
    const provided = req.headers.get('x-api-key');
    if (!provided || !keys.includes(provided)) return error(401, 'unauthorized', 'Missing or invalid x-api-key.');

    const url = new URL(req.url);
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!start || !end) return error(400, 'missing_range', 'start and end (YYYY-MM-DD) are required.');
    const employeeFilter = url.searchParams.get('employee'); // email or employee id
    const format = url.searchParams.get('format') ?? 'json';
    // by=job|location|department -> split each day by the salon+role actually worked
    // (from the live-punch location and role). Otherwise the
    // default per-employee-per-day feed.
    const byJob = ['job', 'location', 'department'].includes(url.searchParams.get('by') ?? '');

    const admin = adminClient();

    // employee directory (for names/emails/uuids, home job, and optional filter)
    const { data: emps } = await admin.from('employees').select('id, first_name, last_name, email, gusto_employee_uuid, home_location_id, home_department_id');
    const dir = new Map((emps ?? []).map((e: any) => [e.id, e]));
    let onlyId: string | null = null;
    if (employeeFilter) {
      const found = (emps ?? []).find((e: any) => e.id === employeeFilter || (e.email ?? '').toLowerCase() === employeeFilter.toLowerCase());
      if (!found) return json({ ok: true, rows: [] });
      onlyId = found.id;
    }

    // Live punches -> daily totals (this app's own records)
    const startTs = `${start}T00:00:00-05:00`, endTs = `${end}T23:59:59-04:00`;
    const events: any[] = [];
    for (let from = 0; ; from += 1000) {
      let pq = admin.from('punch_events')
        .select('employee_id, event_type, location_id, department_id, server_ts')
        .is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs)
        .order('server_ts', { ascending: true }).range(from, from + 999);
      if (onlyId) pq = pq.eq('employee_id', onlyId);
      const { data, error: pErr } = await pq;
      if (pErr || !data) break;
      events.push(...data);
      if (data.length < 1000) break;
    }
    const byEmp = new Map<string, StoredEvent[]>();
    for (const ev of events ?? []) {
      const arr = byEmp.get(ev.employee_id) ?? [];
      arr.push(ev as StoredEvent); byEmp.set(ev.employee_id, arr);
    }

    const rows: DailyRow[] = [];

    // ---- by=job: split each day by salon + role actually worked -----------------
    if (byJob) {
      const [{ data: locs }, { data: depts }] = await Promise.all([
        admin.from('locations').select('id, short_name'),
        admin.from('departments').select('id, title'),
      ]);
      const locName = new Map((locs ?? []).map((l: any) => [l.id, l.short_name]));
      const deptName = new Map((depts ?? []).map((d: any) => [d.id, d.title]));
      interface JobRow { date: string; employee_id: string | null; employee_name: string; email: string | null; gusto_employee_uuid: string | null; location_id: string | null; location: string; department_id: string | null; department: string; source: 'live'; total_hours: number; regular_hours: number; overtime_hours: number; }
      const jobRows: JobRow[] = [];
      const pushJob = (b: DailyRow, locId: string | null, deptId: string | null, tot: number, reg: number, ot: number, src: 'live') => {
        jobRows.push({ date: b.date, employee_id: b.employee_id, employee_name: b.employee_name, email: b.email, gusto_employee_uuid: b.gusto_employee_uuid,
          location_id: locId, location: locId ? (locName.get(locId) ?? '') : '', department_id: deptId, department: deptId ? (deptName.get(deptId) ?? '') : '',
          source: src, total_hours: r2(tot), regular_hours: r2(reg), overtime_hours: r2(ot) });
      };

      // Live punches -> per (day, salon, role).
      for (const [empId, evs] of byEmp) {
        const perJobDay = new Map<string, { locId: string | null; deptId: string | null; day: string; secs: number }>();
        for (const s of deriveSegments(evs) as Segment[]) {
          if (s.durationSeconds == null || s.endedAt == null) continue;
          const day = localDateKey(new Date(s.startedAt));
          const k = `${day}|${s.locationId ?? ''}|${s.departmentId ?? ''}`;
          const cur = perJobDay.get(k) ?? { locId: s.locationId, deptId: s.departmentId, day, secs: 0 };
          cur.secs += s.durationSeconds; perJobDay.set(k, cur);
        }
        const e = dir.get(empId);
        const base: DailyRow = { date: '', employee_id: empId, employee_name: e ? `${e.first_name} ${e.last_name}` : '', email: e?.email ?? null, gusto_employee_uuid: e?.gusto_employee_uuid ?? null, source: 'live', total_hours: 0, regular_hours: 0, overtime_hours: 0 };
        for (const v of perJobDay.values()) { const hrs = v.secs / 3600; pushJob({ ...base, date: v.day }, v.locId, v.deptId, hrs, hrs, 0, 'live'); }
      }

      jobRows.sort((a, b) => a.date.localeCompare(b.date) || a.employee_name.localeCompare(b.employee_name) || a.location.localeCompare(b.location));
      return json({ ok: true, range: { start, end }, by: 'job', count: jobRows.length, rows: jobRows });
    }

    for (const [empId, evs] of byEmp) {
      const perDay = new Map<string, number>();
      for (const s of deriveSegments(evs) as Segment[]) {
        if (s.durationSeconds == null || s.endedAt == null) continue;
        const day = localDateKey(new Date(s.startedAt));
        perDay.set(day, (perDay.get(day) ?? 0) + s.durationSeconds);
      }
      const e = dir.get(empId);
      for (const [day, secs] of perDay) {
        const hrs = Math.round(secs / 3600 * 100) / 100;
        rows.push({
          date: day, employee_id: empId,
          employee_name: e ? `${e.first_name} ${e.last_name}` : '', email: e?.email ?? null,
          gusto_employee_uuid: e?.gusto_employee_uuid ?? null, source: 'live',
          total_hours: hrs, regular_hours: hrs, overtime_hours: 0, // OT is a pay-period calc, not daily
        });
      }
    }

    rows.sort((a, b) => a.date.localeCompare(b.date) || a.employee_name.localeCompare(b.employee_name));

    if (format === 'csv') {
      return new Response(buildHoursCsv(rows), {
        headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="brand-hours-${start}_to_${end}.csv"` },
      });
    }
    return json({ ok: true, range: { start, end }, count: rows.length, rows });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] hours-export error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

function r2(n: number): number { return Math.round(n * 100) / 100; }

export const config = { path: '/api/hours' };
