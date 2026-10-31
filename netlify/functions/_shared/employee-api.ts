// Shared logic for the read-only, employee-facing hours API (Team Team App).
// Everything is scoped to a single employee_id (the authenticated caller).
import { deriveSegments } from '../../../src/lib/domain/segments';
import { secondsToDecimalHours, localDateKey } from '../../../src/lib/time';
import type { StoredEvent } from '../../../src/lib/domain/punch';

type Admin = ReturnType<typeof import('./supabase').adminClient>;


/** Add days to a YYYY-MM-DD date (UTC-safe, no tz drift). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Conservative per-employee rate limit. The consumer polls <= 4x/hour; we allow
 * headroom for a couple of endpoints + retries. Returns true if allowed.
 */
export async function rateLimit(admin: Admin, employeeId: string, endpoint: string, maxPerHour = 20): Promise<boolean> {
  const sinceHour = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from('api_access_log').select('id', { count: 'exact', head: true })
    .eq('employee_id', employeeId).gte('at', sinceHour);
  if ((count ?? 0) >= maxPerHour) return false;
  await admin.from('api_access_log').insert({ employee_id: employeeId, endpoint });
  // opportunistic cleanup so the log never grows unbounded
  await admin.from('api_access_log').delete().lt('at', new Date(Date.now() - 2 * 3600_000).toISOString());
  return true;
}

export interface DayHours { date: string; reg: number; ot: number; total: number | null; in: string | null; out: string | null; source: 'live'; segments?: Array<{ in: string; out: string | null }> }

// One manager edit/add to a punch, surfaced on the employee's own history so
// they can confirm a missed/incorrect punch was fixed before payday.
export interface PunchEdit {
  field: 'in' | 'out';
  kind: 'edited' | 'added';
  from: string | null; // original punch time (ISO) when it was an edit; null for an add
  to: string;          // the current punch time (ISO)
  by: string;          // name of the manager/owner who made the change
  at: string;          // when the change was made (ISO)
}

/**
 * Manager edits/adds to a single employee's punches in [startDate, endDate],
 * grouped by local day. Append-only model: an edit voids the original and inserts
 * a corrected event (`original_event_id` → the voided one); a manual add is an
 * admin-sourced event with no original. Read-only; scoped to one employee.
 */
export async function getDayEdits(admin: Admin, employeeId: string, startDate: string, endDate: string): Promise<Map<string, PunchEdit[]>> {
  const { data: evs } = await admin.from('punch_events')
    .select('id, event_type, server_ts, voided_at, original_event_id, created_by_auth_id, created_at, source')
    .eq('employee_id', employeeId)
    .gte('server_ts', `${startDate}T00:00:00-05:00`).lte('server_ts', `${endDate}T23:59:59-04:00`);
  const all = (evs ?? []) as Array<Record<string, any>>;
  if (!all.length) return new Map();
  const byId = new Map(all.map((e) => [e.id, e]));

  // An edit's ORIGINAL punch may sit outside the queried window (e.g. the fix
  // moved the time across midnight) — fetch any originals we don't already have.
  const missing = all.filter((e) => !e.voided_at && e.original_event_id && !byId.has(e.original_event_id)).map((e) => e.original_event_id);
  if (missing.length) {
    const { data: origs } = await admin.from('punch_events').select('id, server_ts').in('id', [...new Set(missing)]);
    for (const o of origs ?? []) byId.set((o as any).id, o);
  }

  // Resolve the editors' names (manager/owner auth ids → "First Last").
  const editorIds = [...new Set(all.filter((e) => !e.voided_at && e.created_by_auth_id).map((e) => e.created_by_auth_id))];
  const nameByAuth = new Map<string, string>();
  if (editorIds.length) {
    const { data: emps } = await admin.from('employees').select('auth_user_id, first_name, last_name').in('auth_user_id', editorIds as string[]);
    for (const e of emps ?? []) nameByAuth.set((e as any).auth_user_id, `${(e as any).first_name} ${(e as any).last_name}`.trim());
  }

  const out = new Map<string, PunchEdit[]>();
  for (const e of all) {
    if (e.voided_at) continue; // the superseded originals are referenced via `from`, not shown on their own
    const managerTouched = e.source === 'administrator' || !!e.original_event_id;
    if (!managerTouched) continue;
    const field: 'in' | 'out' | null = e.event_type === 'clock_in' ? 'in' : e.event_type === 'clock_out' ? 'out' : null;
    if (!field) continue;
    const dateKey = localDateKey(new Date(e.server_ts));
    if (dateKey < startDate || dateKey > endDate) continue;
    const orig = e.original_event_id ? byId.get(e.original_event_id) : null;
    const edit: PunchEdit = {
      field,
      kind: e.original_event_id ? 'edited' : 'added',
      from: orig?.server_ts ?? null,
      to: e.server_ts,
      by: (e.created_by_auth_id && nameByAuth.get(e.created_by_auth_id)) || 'a manager',
      at: e.created_at ?? e.server_ts,
    };
    const list = out.get(dateKey); if (list) list.push(edit); else out.set(dateKey, [edit]);
  }
  return out;
}

// Collapse contiguous worked intervals (a location/department transfer splits a
// shift into adjacent segments with no gap — merge those back) while keeping real
// breaks apart, so a split shift / lunch reads as separate in–out pairs.
function mergeContiguous(segs: Array<{ in: string; out: string | null }>): Array<{ in: string; out: string | null }> {
  const sorted = [...segs].sort((a, b) => a.in.localeCompare(b.in));
  const out: Array<{ in: string; out: string | null }> = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last.out && last.out === s.in) last.out = s.out; // touching -> one interval
    else out.push({ in: s.in, out: s.out });
  }
  return out;
}

/**
 * Per-day hours for one employee across [startDate, endDate], from Team Time
 * Clock punches. Returns a Map keyed by YYYY-MM-DD; a missing key means "no
 * record for that day".
 */
export async function getDailyHours(admin: Admin, employeeId: string, startDate: string, endDate: string): Promise<Map<string, DayHours>> {
  const [{ data: events }] = await Promise.all([
    admin.from('punch_events').select('event_type, location_id, department_id, server_ts')
      .eq('employee_id', employeeId).is('voided_at', null)
      .gte('server_ts', `${startDate}T00:00:00-05:00`).lte('server_ts', `${endDate}T23:59:59-04:00`)
      .order('server_ts', { ascending: true }),
  ]);

  const map = new Map<string, DayHours>();
  // Live punches -> per-day first-in / last-out / summed hours.
  const perDay = new Map<string, { secs: number; in: string; out: string | null; open: boolean; segs: Array<{ in: string; out: string | null }> }>();
  for (const s of deriveSegments((events as StoredEvent[]) ?? [])) {
    const d = localDateKey(new Date(s.startedAt));
    const e = perDay.get(d) ?? { secs: 0, in: s.startedAt, out: null, open: false, segs: [] };
    if (s.durationSeconds != null && s.endedAt != null) { e.secs += s.durationSeconds; if (!e.out || s.endedAt > e.out) e.out = s.endedAt; }
    else e.open = true;
    if (s.startedAt < e.in) e.in = s.startedAt;
    e.segs.push({ in: s.startedAt, out: s.endedAt });
    perDay.set(d, e);
  }
  for (const [d, e] of perDay) {
    if (d < startDate || d > endDate) continue;
    map.set(d, { date: d, reg: secondsToDecimalHours(e.secs), ot: 0, total: e.open ? null : secondsToDecimalHours(e.secs), in: e.in, out: e.open ? null : e.out, source: 'live', segments: mergeContiguous(e.segs) });
  }
  return map;
}

/**
 * Total hours worked in the Sunday-week starting weekStart. Returns null when
 * the employee has NO record for that week (never a false 0 — the Team App shows
 * these as headline numbers, so "unknown" must be null, not zero).
 */
export function sumWeek(map: Map<string, DayHours>, weekStart: string): number | null {
  const weekEnd = addDays(weekStart, 6);
  let sum = 0, any = false;
  for (const [d, v] of map) {
    if (d < weekStart || d > weekEnd) continue;
    any = true;
    sum += v.total ?? v.reg + v.ot;
  }
  return any ? Math.round(sum * 100) / 100 : null;
}
