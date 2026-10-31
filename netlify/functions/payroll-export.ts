import { requireEmployee, isAdmin } from './_shared/auth';
import { json, error, requireMethod } from './_shared/http';
import { deriveSegments, computePayrollByJob } from '../../src/lib/domain/segments';
import { partsInTz, APP_TZ } from '../../src/lib/time';
import type { StoredEvent } from '../../src/lib/domain/punch';

// Eastern (salon) calendar date of an ISO instant.
const etDate = (iso: string): string => {
  const p = partsInTz(new Date(iso), APP_TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

import { buildPayrollCsv, jobTitle, type ExportRow } from '../../src/lib/gusto/csv';
import { mergeExtras, extrasKey, type GustoEarning } from '../../src/lib/gusto/extras';

// Admin-only payroll preview + CSV for a pay period. GET /api/payroll-export?start=&end=
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET');
    const { admin, roles } = await requireEmployee(req);
    if (!isAdmin(roles)) return error(403, 'forbidden', 'Administrator access required.');

    const url = new URL(req.url);
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!start || !end) return error(400, 'missing_range', 'start and end (YYYY-MM-DD) are required.');
    const startTs = `${start}T00:00:00-04:00`;
    const endTs = `${end}T23:59:59-04:00`;

    // location/department id -> name maps
    const [{ data: locs }, { data: depts }] = await Promise.all([
      admin.from('locations').select('id, short_name'),
      admin.from('departments').select('id, title, gusto_job_title'),
    ]);
    const locName = new Map((locs ?? []).map((l: { id: string; short_name: string }) => [l.id, l.short_name]));
    const deptName = new Map((depts ?? []).map((d: { id: string; title: string }) => [d.id, d.title]));
    const deptGusto = new Map((depts ?? []).map((d: { id: string; gusto_job_title: string | null }) => [d.id, d.gusto_job_title]));
    const empSet = new Set<string>();

    // enabled employees + their events in range
    const { data: emps } = await admin.from('employees')
      .select('id, gusto_employee_uuid, first_name, last_name, email, home_location_id, home_department_id')
      .neq('timekeeping_access', 'disabled');

    // Exact Gusto job identity + rate per (employee, role, salon), seeded from
    // Gusto into otc.employee_jobs. This lets the export emit each person's REAL
    // Gusto job title — so Smart Import matches even when the title isn't the
    // "{Department} {Location}" convention — and cost hours at the right per-role
    // rate. Location-less roles (Nails, Marketing, Education) are keyed by role only.
    const { data: ejRows } = await admin.from('employee_jobs')
      .select('employee_id, gusto_title, department_id, location_id, rate');
    const jobExact = new Map<string, { title: string; rate: number | null }>();
    const jobDeptOnly = new Map<string, { title: string; rate: number | null }>();
    const empHasJobs = new Set<string>();
    for (const r of (ejRows ?? []) as Array<{ employee_id: string; gusto_title: string; department_id: string | null; location_id: string | null; rate: number | string | null }>) {
      empHasJobs.add(r.employee_id);
      const rate = r.rate == null ? null : Number(r.rate);
      if (r.location_id) jobExact.set(`${r.employee_id}:${r.department_id}:${r.location_id}`, { title: r.gusto_title, rate });
      else if (r.department_id) jobDeptOnly.set(`${r.employee_id}:${r.department_id}`, { title: r.gusto_title, rate });
    }
    const resolveJob = (empId: string, deptId: string | null, locId: string | null): { title: string; rate: number | null } | null => {
      if (deptId && locId) { const x = jobExact.get(`${empId}:${deptId}:${locId}`); if (x) return x; }
      if (deptId) { const d = jobDeptOnly.get(`${empId}:${deptId}`); if (d) return d; }
      return null;
    };
    // Estimated gross for on-screen costing: OT paid at 1.5×. Gusto still does the
    // authoritative pay run; this is a preview so the report shows dollars.
    const costOf = (rate: number | null, regSec: number, otSec: number): number | null =>
      rate == null ? null : Math.round((regSec / 3600 * rate + otSec / 3600 * rate * 1.5) * 100) / 100;

    // Which half of the pay period a date falls in: Week 1 = first 7 days,
    // Week 2 = the rest. This matches the two weeks Gusto shows for a bi-weekly
    // period, so OT lands in the week it was earned instead of being split evenly.
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const weekHalf = (dateStr: string): 1 | 2 => (Date.parse(`${dateStr}T00:00:00Z`) - startMs) < 7 * 86400000 ? 1 : 2;
    // Per merged row (employee|job title) -> per-week regular/overtime seconds.
    const weeklyByKey = new Map<string, { w1r: number; w1o: number; w2r: number; w2o: number }>();
    const addWeekly = (key: string, wk: 1 | 2, regSec: number, otSec: number) => {
      const w = weeklyByKey.get(key) ?? { w1r: 0, w1o: 0, w2r: 0, w2o: 0 };
      if (wk === 1) { w.w1r += regSec; w.w1o += otSec; } else { w.w2r += regSec; w.w2o += otSec; }
      weeklyByKey.set(key, w);
    };

    const rows: ExportRow[] = [];
    let totRegular = 0, totOt = 0, exceptions = 0, excludedNonGusto = 0, unmatchedJobs = 0, estCost = 0;

    for (const e of emps ?? []) {
      // People not in Gusto (e.g. paid another way) never go in the Gusto CSV.
      if (!e.gusto_employee_uuid) { excludedNonGusto += 1; continue; }

      // Bill this person's live Team Time Clock punches for the period.
      const { data: events } = await admin.from('punch_events')
        .select('event_type, location_id, department_id, server_ts')
        .eq('employee_id', e.id)
        .is('voided_at', null)
        .gte('server_ts', startTs).lte('server_ts', endTs)
        .order('server_ts', { ascending: true });
      const segments = (events && events.length) ? deriveSegments(events as StoredEvent[]) : [];
      if (segments.length === 0) continue;
      const hasOpen = segments.some((s) => s.endedAt == null);
      const jobs = computePayrollByJob(segments);
      const worked = jobs.filter((j) => j.regularSeconds > 0 || j.overtimeSeconds > 0);
      if (worked.length === 0 && !hasOpen) continue;
      if (hasOpen) exceptions += 1;

      // One row per job (department+location) so Gusto can map each to its job title.
      for (const j of worked) {
        const loc = j.locationId ? locName.get(j.locationId) ?? '' : '';
        const dept = j.departmentId ? deptName.get(j.departmentId) ?? '' : '';
        const ej = resolveJob(e.id, j.departmentId, j.locationId);
        // Prefer the employee's EXACT Gusto job title (guarantees Smart Import
        // matches). Fall back to the per-role override, then "{Department} {Location}".
        const override = j.departmentId ? deptGusto.get(j.departmentId) : null;
        const title = ej?.title || override || jobTitle(dept, loc);
        const rate = ej?.rate ?? null;
        const amount = costOf(rate, j.regularSeconds, j.overtimeSeconds);
        // A "managed" person (has Gusto jobs on file) who clocked a role+salon
        // with no matching Gusto job → flag it rather than silently misfiling.
        const unmatched = empHasJobs.has(e.id) && !ej;
        if (unmatched) unmatchedJobs += 1;
        if (amount != null) estCost += amount;
        totRegular += j.regularSeconds; totOt += j.overtimeSeconds;
        empSet.add(e.id);
        rows.push({
          gusto_employee_uuid: e.gusto_employee_uuid ?? '',
          employee_name: `${e.first_name} ${e.last_name}`, first_name: e.first_name, last_name: e.last_name,
          email: e.email,
          pay_period_start: start, pay_period_end: end,
          job_title: title,
          location: loc, department: dept,
          regular_seconds: j.regularSeconds,
          overtime_seconds: j.overtimeSeconds,
          double_ot_seconds: 0,
          rate, amount, title_source: ej ? 'gusto' : 'constructed',
          exceptions: unmatched ? 'NO_GUSTO_JOB' : (hasOpen ? 'OPEN_SHIFT' : ''),
        });
      }

      // ---- per-week split (Week 1 / Week 2 CSV columns) ----
      // Unify this employee's worked days into hours-per-day-per-job, then apply
      // 40h weekly OT WITHIN each half of the pay period, crediting OT to the job
      // worked when that week crosses 40. Does not change the period totals above.
      const resolveTitle = (locId: string | null, deptId: string | null): string => {
        const loc = locId ? locName.get(locId) ?? '' : '';
        const dept = deptId ? deptName.get(deptId) ?? '' : '';
        const ej = resolveJob(e.id, deptId, locId);
        const ovrT = deptId ? deptGusto.get(deptId) : null;
        return ej?.title || ovrT || jobTitle(dept, loc);
      };
      const wkAllocs: Array<{ date: string; title: string; hours: number }> = [];
      for (const s of segments) if (s.endedAt != null && s.durationSeconds != null) wkAllocs.push({ date: etDate(s.startedAt), title: resolveTitle(s.locationId, s.departmentId), hours: s.durationSeconds / 3600 });
      for (const wk of [1, 2] as const) {
        const days = wkAllocs.filter((a) => weekHalf(a.date) === wk).sort((a, b) => a.date.localeCompare(b.date));
        let cum = 0;
        for (const a of days) {
          const reg = Math.max(0, Math.min(a.hours, 40 - cum));
          const ot = a.hours - reg;
          cum += a.hours;
          addWeekly(`${e.gusto_employee_uuid}|${a.title}`, wk, Math.round(reg * 3600), Math.round(ot * 3600));
        }
      }
    }

    // Collapse duplicate (employee, job-title) rows into ONE line. Two jobs that
    // map to the same Gusto title would otherwise export as two identical-title
    // lines, and a Gusto import could mishandle that (sum, keep-last, or error). Gusto matches
    // on job title, so we combine the hours ourselves and hand it exactly one line
    // per job. Regular/OT are independent buckets, so summing each is correct.
    const mergedMap = new Map<string, ExportRow>();
    for (const r of rows) {
      const key = `${r.gusto_employee_uuid}|${r.job_title}`;
      const ex = mergedMap.get(key);
      if (!ex) { mergedMap.set(key, { ...r }); continue; }
      ex.regular_seconds += r.regular_seconds;
      ex.overtime_seconds += r.overtime_seconds;
      ex.double_ot_seconds += r.double_ot_seconds;
      if (r.amount != null) ex.amount = (ex.amount ?? 0) + r.amount;
      if (r.exceptions && ex.exceptions !== r.exceptions) ex.exceptions = [ex.exceptions, r.exceptions].filter(Boolean).join(';');
    }
    const outRows = [...mergedMap.values()].sort((a, b) => a.employee_name.localeCompare(b.employee_name));
    // Attach the per-week split to each merged row.
    for (const r of outRows) {
      const w = weeklyByKey.get(`${r.gusto_employee_uuid}|${r.job_title}`);
      if (w) { r.w1_regular_seconds = w.w1r; r.w1_overtime_seconds = w.w1o; r.w2_regular_seconds = w.w2r; r.w2_overtime_seconds = w.w2o; }
    }
    // ---- dollar extras from the Team Payroll Performance dashboard ----
    // Boulevard credit-card tips + bonus/commission adjustments live in the same
    // Supabase project (public.pp_runs / public.pp_run_adjustments). Attach each
    // person's extras to their PRIMARY job row (the one with the most hours) so
    // one Smart Import file carries hours AND dollars. Someone with extras but
    // no punches this period (e.g. tips for a non-puncher) gets a zero-hours row.
    // Failures degrade to the old hours-only file — never block the export.
    let extras: { total: number; totalsByEarning: Partial<Record<GustoEarning, number>>; people: number; unmatched: string[]; manualOnly: Array<{ person: string; category: string; amount: number }>; excludedPaid: Array<{ person: string; category: string; amount: number; reason: string }> } | null = null;
    try {
      const pub = admin.schema('public');
      const [runRes, adjRes] = await Promise.all([
        pub.from('pp_runs').select('data').eq('id', end).maybeSingle(),
        pub.from('pp_run_adjustments').select('person, category, amount, kind, excluded, excluded_reason').eq('period_start', start),
      ]);
      const runRows = (runRes.data?.data as { rows?: unknown[] } | null)?.rows ?? [];
      const adjRows = adjRes.data ?? [];
      if (runRows.length || adjRows.length) {
        const merged = mergeExtras(runRows as never[], adjRows as never[]);
        const rowsByKey = new Map<string, ExportRow[]>();
        for (const r of outRows) {
          const k = extrasKey(r.employee_name);
          const arr = rowsByKey.get(k) ?? [];
          arr.push(r); rowsByKey.set(k, arr);
        }
        const empByKey = new Map((emps ?? []).map((e: { gusto_employee_uuid: string | null; first_name: string; last_name: string; email: string; home_location_id: string | null; home_department_id: string | null; id: string }) => [extrasKey(`${e.first_name} ${e.last_name}`), e]));
        extras = { total: 0, totalsByEarning: {}, people: 0, unmatched: [], manualOnly: merged.skipped, excludedPaid: merged.excludedPaid };
        for (const [key, x] of merged.byKey) {
          let target = (rowsByKey.get(key) ?? []).sort((a, b) => (b.regular_seconds + b.overtime_seconds) - (a.regular_seconds + a.overtime_seconds))[0];
          if (!target) {
            const e = empByKey.get(key);
            if (!e || !e.gusto_employee_uuid) { extras.unmatched.push(x.name); continue; }
            const loc = e.home_location_id ? locName.get(e.home_location_id) ?? '' : '';
            const dept = e.home_department_id ? deptName.get(e.home_department_id) ?? '' : '';
            const ej = resolveJob(e.id, e.home_department_id, e.home_location_id);
            target = {
              gusto_employee_uuid: e.gusto_employee_uuid,
              employee_name: `${e.first_name} ${e.last_name}`, first_name: e.first_name, last_name: e.last_name,
              email: e.email,
              pay_period_start: start, pay_period_end: end,
              job_title: ej?.title || jobTitle(dept, loc), location: loc, department: dept,
              regular_seconds: 0, overtime_seconds: 0, double_ot_seconds: 0,
              title_source: ej ? 'gusto' : 'constructed',
              exceptions: 'EXTRAS_ONLY',
            };
            outRows.push(target);
          }
          target.extras = x.earnings;
          target.paycheck_tips = x.earnings['Paycheck Tips'] || null;
          let other = 0;
          for (const [earning, amount] of Object.entries(x.earnings) as Array<[GustoEarning, number]>) {
            extras.totalsByEarning[earning] = Math.round(((extras.totalsByEarning[earning] ?? 0) + amount) * 100) / 100;
            extras.total = Math.round((extras.total + amount) * 100) / 100;
            if (earning !== 'Paycheck Tips') other += amount;
          }
          target.extras_other = other ? Math.round(other * 100) / 100 : null;
          extras.people += 1;
        }
        outRows.sort((a, b) => a.employee_name.localeCompare(b.employee_name));
      }
    } catch (e) {
      console.error('[otc] payroll extras unavailable — exporting hours-only', e);
    }

    const csv = buildPayrollCsv(outRows);
    // Privacy: pay RATES and gross estimates live in Gusto, not here — strip them
    // from the browser response. The dashboard-calculated extras (tips/bonus/
    // commission) stay: they're the point of the export and this endpoint is
    // admin-only.
    const publicRows = outRows.map(({ rate, amount, ...r }) => r);
    return json({
      ok: true,
      preview: { employees: empSet.size, jobLines: outRows.length, regularHours: totRegular / 3600, overtimeHours: totOt / 3600, exceptions, unmatchedJobs, excludedNonGusto, extras },
      rows: publicRows,
      csv,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] payroll-export error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/payroll-export' };
