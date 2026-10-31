// Derive shift segments and payroll totals from the immutable event log.
// Pure and tested. Gusto remains the payroll authority; these are Team's
// reviewable preview classifications.

import { durationSeconds, APP_TZ, partsInTz, localDateKey } from '../time';
import type { StoredEvent } from './punch';

export interface Segment {
  locationId: string | null;
  departmentId: string | null;
  startedAt: string;         // ISO
  endedAt: string | null;    // ISO, null while open
  durationSeconds: number | null;
  crossesMidnight?: boolean; // clock-in and clock-out fall on different ET days (never a real Team shift)
}

/**
 * Replay events into segments. A clock_in opens a segment; a location/department
 * transfer closes the current segment and opens a new one at the same instant
 * (preserving per-location/department allocation); a clock_out closes it.
 */
export function deriveSegments(events: StoredEvent[]): Segment[] {
  const ordered = [...events].sort((a, b) => a.server_ts.localeCompare(b.server_ts));
  const segments: Segment[] = [];
  let open: Segment | null = null;

  const close = (at: string) => {
    if (!open) return;
    open.endedAt = at;
    open.durationSeconds = durationSeconds(new Date(open.startedAt), new Date(at));
    // Shifts are not expected to run overnight, so a clock-in and clock-out on different
    // ET days is always a missed punch (someone forgot to clock out). Flag it so
    // the hours math can exclude it until a human fixes it.
    open.crossesMidnight = localDateKey(new Date(open.startedAt)) !== localDateKey(new Date(at));
    segments.push(open);
    open = null;
  };

  for (const e of ordered) {
    switch (e.event_type) {
      case 'clock_in':
        if (open) close(e.server_ts); // defensive: unexpected re-open
        open = { locationId: e.location_id, departmentId: e.department_id, startedAt: e.server_ts, endedAt: null, durationSeconds: null };
        break;
      case 'location_transfer':
        if (open) { const loc: string | null = e.location_id; const dept: string | null = open.departmentId; close(e.server_ts); open = { locationId: loc, departmentId: dept, startedAt: e.server_ts, endedAt: null, durationSeconds: null }; }
        break;
      case 'department_transfer':
        if (open) { const dept: string | null = e.department_id; const loc: string | null = open.locationId; close(e.server_ts); open = { locationId: loc, departmentId: dept, startedAt: e.server_ts, endedAt: null, durationSeconds: null }; }
        break;
      case 'clock_out':
        close(e.server_ts);
        break;
      default:
        break;
    }
  }
  if (open) segments.push(open); // still-open segment retained (duration null)
  return segments;
}

/** Sunday-anchored workweek key (YYYY-MM-DD of that week's Sunday) in Team tz. */
export function weekStartKey(instant: Date, tz: string = APP_TZ): string {
  const p = partsInTz(instant, tz);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0=Sun
  const sundayNum = Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000) - dow;
  const d = new Date(sundayNum * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export interface PayrollTotals {
  regularSeconds: number;
  overtimeSeconds: number;
  doubleOtSeconds: number; // Federal: no daily double-time -> always 0 here
  byLocation: Record<string, number>;
  byDepartment: Record<string, number>;
  hasOpenSegment: boolean;
  hasOvernightSpan: boolean; // an in/out crossed midnight -> excluded from totals until fixed
}

const WEEK_OT_THRESHOLD_SECONDS = 40 * 3600;

/**
 * Federal weekly overtime: hours over 40 in a Sunday–Saturday workweek are OT.
 * Segments are attributed to the workweek of their start. Open segments are
 * excluded from totals but flagged.
 */
export function computePayrollTotals(segments: Segment[], weekOtSeconds = WEEK_OT_THRESHOLD_SECONDS): PayrollTotals {
  const byWeek: Record<string, number> = {};
  const byLocation: Record<string, number> = {};
  const byDepartment: Record<string, number> = {};
  let hasOpenSegment = false;
  let hasOvernightSpan = false;

  for (const s of segments) {
    if (s.durationSeconds == null || s.endedAt == null) { hasOpenSegment = true; continue; }
    if (s.crossesMidnight) { hasOvernightSpan = true; continue; } // never count an overnight span until fixed
    const wk = weekStartKey(new Date(s.startedAt));
    byWeek[wk] = (byWeek[wk] ?? 0) + s.durationSeconds;
    if (s.locationId) byLocation[s.locationId] = (byLocation[s.locationId] ?? 0) + s.durationSeconds;
    if (s.departmentId) byDepartment[s.departmentId] = (byDepartment[s.departmentId] ?? 0) + s.durationSeconds;
  }

  let regularSeconds = 0, overtimeSeconds = 0;
  for (const total of Object.values(byWeek)) {
    regularSeconds += Math.min(total, weekOtSeconds);
    overtimeSeconds += Math.max(0, total - weekOtSeconds);
  }
  return { regularSeconds, overtimeSeconds, doubleOtSeconds: 0, byLocation, byDepartment, hasOpenSegment, hasOvernightSpan };
}

export interface JobBucket {
  locationId: string | null;
  departmentId: string | null;
  regularSeconds: number;
  overtimeSeconds: number;
}

/**
 * Per-job (location+department) hours with CORRECT overtime attribution for
 * multi-department weeks: within each Sun–Sat workweek, segments are walked in
 * chronological order; hours up to 40 are regular, hours beyond 40 are overtime
 * — and each is credited to the job the employee was actually working at that
 * moment. This is what Gusto needs so a person who works two departments shows
 * the right regular/OT split per job title.
 */
export function computePayrollByJob(segments: Segment[], weekOtSeconds = WEEK_OT_THRESHOLD_SECONDS): JobBucket[] {
  const weeks: Record<string, Segment[]> = {};
  for (const s of segments) {
    if (s.durationSeconds == null || s.endedAt == null || s.crossesMidnight) continue; // exclude open + overnight spans
    (weeks[weekStartKey(new Date(s.startedAt))] ??= []).push(s);
  }
  const buckets = new Map<string, JobBucket>();
  const keyOf = (loc: string | null, dep: string | null) => `${loc ?? ''}|${dep ?? ''}`;

  for (const segs of Object.values(weeks)) {
    segs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    let cum = 0;
    for (const s of segs) {
      const dur = s.durationSeconds as number;
      const reg = Math.max(0, Math.min(dur, weekOtSeconds - cum));
      const ot = dur - reg;
      cum += dur;
      const k = keyOf(s.locationId, s.departmentId);
      const b = buckets.get(k) ?? { locationId: s.locationId, departmentId: s.departmentId, regularSeconds: 0, overtimeSeconds: 0 };
      b.regularSeconds += reg; b.overtimeSeconds += ot;
      buckets.set(k, b);
    }
  }
  return [...buckets.values()];
}
