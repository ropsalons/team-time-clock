import { adminClient } from './_shared/supabase';
import { json, error } from './_shared/http';
import { deriveSegments, type Segment } from '../../src/lib/domain/segments';
import type { StoredEvent } from '../../src/lib/domain/punch';

// Read-only timekeeping API for an external app (e.g. a payroll app). Full READ
// access to all timekeeping records, machine-to-machine auth via the x-api-key
// header (TIMEKEEPING_API_KEY). Writes are intentionally NOT exposed — punches
// must only be created/edited inside the time-clock app to protect integrity.
//
//   GET /api/timekeeping?resource=<resource>[&start=YYYY-MM-DD&end=YYYY-MM-DD][&employee=<id|email>]
//   resources: now | employees | locations | departments | pay_periods | punches | segments | corrections
//   (daily hours summaries live at the sibling endpoint GET /api/hours)
//
// NOTE on scope: Team Time Clock records ACTUAL clock in/out only. It has no shift
// SCHEDULE, no phone/front-desk roster, no separate break/lunch punches (a break
// is just the gap between a clock-out and the next clock-in), and no time-off
// (that lives in Gusto). "role" = the person's department.

async function pageAll(build: (from: number) => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: e } = await build(from);
    if (e || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

export default async (req: Request): Promise<Response> => {
  try {
    // Accept the shared timekeeping key, the dedicated Team Chat key, or the
    // KPI Sentinel key — each can be rotated/revoked independently of the others.
    const keys = [process.env.TIMEKEEPING_API_KEY, process.env.TEAM_CHAT_API_KEY, process.env.KPI_SENTINEL_API_KEY].filter(Boolean);
    if (!keys.length) return error(503, 'not_configured', 'No API key is set on the server.');
    const provided = req.headers.get('x-api-key');
    if (!provided || !keys.includes(provided)) return error(401, 'unauthorized', 'Missing or invalid x-api-key.');

    const url = new URL(req.url);
    const resource = url.searchParams.get('resource') ?? 'employees';
    const admin = adminClient();

    // --- master / reference data (no date range) ---
    if (resource === 'employees') {
      const { data } = await admin.from('employees')
        .select('id, first_name, last_name, email, phone, gusto_employee_uuid, gusto_company_uuid, timekeeping_access, is_manual, primary_job_title, gusto_department_name, home_location_id, home_department_id, hire_date, termination_date')
        .order('last_name');
      return json({ ok: true, resource, count: data?.length ?? 0, rows: data ?? [] });
    }
    if (resource === 'locations') {
      const { data } = await admin.from('locations').select('id, short_name, display_name, address, is_active, sort_order').order('sort_order');
      return json({ ok: true, resource, count: data?.length ?? 0, rows: data ?? [] });
    }
    if (resource === 'departments') {
      const { data } = await admin.from('departments').select('id, title, gusto_job_title, is_active, sort_order').order('sort_order');
      return json({ ok: true, resource, count: data?.length ?? 0, rows: data ?? [] });
    }
    if (resource === 'pay_periods') {
      const { data } = await admin.from('pay_periods').select('id, start_date, end_date').order('start_date', { ascending: false });
      return json({ ok: true, resource, count: data?.length ?? 0, rows: data ?? [] });
    }

    // --- LIVE: who is clocked in right now (name, location, role, since) ---
    // A person is "on" when their most recent non-voided punch is a clock_in.
    // We look back 48h (shifts are not expected to run overnight) to find each person's last
    // event cheaply. Names/location/role are resolved so no extra lookups needed.
    if (resource === 'now') {
      const sinceTs = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const events = await pageAll((from) => admin.from('punch_events')
        .select('employee_id, event_type, location_id, department_id, server_ts')
        .is('voided_at', null).gte('server_ts', sinceTs)
        .order('server_ts', { ascending: true }).range(from, from + 999));
      const latest = new Map<string, any>();
      for (const ev of events) latest.set(ev.employee_id, ev); // asc order → last write wins
      const [{ data: emps }, { data: locs }, { data: depts }] = await Promise.all([
        admin.from('employees').select('id, first_name, last_name, preferred_first_name'),
        admin.from('locations').select('id, short_name'),
        admin.from('departments').select('id, title'),
      ]);
      const empMap = new Map((emps ?? []).map((e: any) => [e.id, e]));
      const locMap = new Map((locs ?? []).map((l: any) => [l.id, l.short_name]));
      const deptMap = new Map((depts ?? []).map((d: any) => [d.id, d.title]));
      const rows = [...latest.values()]
        .filter((e: any) => e.event_type === 'clock_in')
        .map((e: any) => {
          const emp = empMap.get(e.employee_id);
          const secs = Math.max(0, Math.floor((Date.now() - Date.parse(e.server_ts)) / 1000));
          return {
            employee_id: e.employee_id,
            name: emp ? `${emp.preferred_first_name || emp.first_name} ${emp.last_name}` : null,
            location_id: e.location_id, location: e.location_id ? (locMap.get(e.location_id) ?? null) : null,
            department_id: e.department_id, role: e.department_id ? (deptMap.get(e.department_id) ?? null) : null,
            clocked_in_at: e.server_ts, on_for_hours: Math.round((secs / 3600) * 100) / 100,
          };
        })
        .sort((a, b) => (a.location ?? '').localeCompare(b.location ?? '') || (a.name ?? '').localeCompare(b.name ?? ''));
      return json({ ok: true, resource: 'now', as_of: new Date().toISOString(), count: rows.length, rows });
    }

    // --- record data (needs a date range) ---
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!start || !end) return error(400, 'missing_range', 'start and end (YYYY-MM-DD) are required for this resource.');
    const startTs = `${start}T00:00:00-05:00`;
    const endTs = `${end}T23:59:59-04:00`;

    const employeeFilter = url.searchParams.get('employee'); // employee id or email
    let onlyId: string | null = null;
    if (employeeFilter) {
      const { data: emps } = await admin.from('employees').select('id, email');
      const f = (emps ?? []).find((e: any) => e.id === employeeFilter || (e.email ?? '').toLowerCase() === employeeFilter.toLowerCase());
      if (!f) return json({ ok: true, resource, range: { start, end }, count: 0, rows: [] });
      onlyId = f.id;
    }

    if (resource === 'punches') {
      const rows = await pageAll((from) => {
        let q = admin.from('punch_events')
          .select('id, employee_id, gusto_employee_uuid, event_type, server_ts, employee_ts, location_id, department_id, note, source, approval, pay_period_id, voided_at, original_event_id, correction_reason')
          .gte('server_ts', startTs).lte('server_ts', endTs)
          .order('server_ts', { ascending: true }).range(from, from + 999);
        if (onlyId) q = q.eq('employee_id', onlyId);
        return q;
      });
      return json({ ok: true, resource, range: { start, end }, count: rows.length, rows });
    }

    if (resource === 'segments') {
      // Paired worked shifts (clock-in → clock-out) with durations in hours.
      const events = await pageAll((from) => {
        let q = admin.from('punch_events')
          .select('employee_id, event_type, location_id, department_id, server_ts')
          .is('voided_at', null).gte('server_ts', startTs).lte('server_ts', endTs)
          .order('server_ts', { ascending: true }).range(from, from + 999);
        if (onlyId) q = q.eq('employee_id', onlyId);
        return q;
      });
      const byEmp = new Map<string, StoredEvent[]>();
      for (const ev of events) { const a = byEmp.get(ev.employee_id) ?? []; a.push(ev as StoredEvent); byEmp.set(ev.employee_id, a); }
      const rows: any[] = [];
      for (const [empId, evs] of byEmp) {
        for (const s of deriveSegments(evs) as Segment[]) {
          if (s.endedAt == null || s.durationSeconds == null) continue; // skip still-open shifts
          rows.push({
            employee_id: empId,
            location_id: s.locationId, department_id: s.departmentId,
            started_at: s.startedAt, ended_at: s.endedAt,
            hours: Math.round((s.durationSeconds / 3600) * 100) / 100,
          });
        }
      }
      rows.sort((a, b) => a.started_at.localeCompare(b.started_at));
      return json({ ok: true, resource, range: { start, end }, count: rows.length, rows });
    }

    if (resource === 'corrections') {
      // Employee-submitted fixes: missed clock-in/out, wrong time/location/role.
      // Shows status (pending/approved/rejected) and what was applied — i.e. the
      // "edited or missed punches" trail. Filtered by when the request was made.
      const rows = await pageAll((from) => {
        let q = admin.from('correction_requests')
          .select('id, employee_id, kind, requested_ts, requested_location_id, requested_department_id, target_event_id, explanation, status, created_at, decided_at, applied_ts, applied_source')
          .gte('created_at', startTs).lte('created_at', endTs)
          .order('created_at', { ascending: false }).range(from, from + 999);
        if (onlyId) q = q.eq('employee_id', onlyId);
        return q;
      });
      return json({ ok: true, resource, range: { start, end }, count: rows.length, rows });
    }

    return error(400, 'bad_resource', 'Unknown resource. Use: now, employees, locations, departments, pay_periods, punches, segments, or corrections.');
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] timekeeping-api error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/timekeeping' };
