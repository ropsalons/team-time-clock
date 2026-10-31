// Time & duration math. All authoritative instants are UTC (Date / epoch ms).
// Display timezone for Team is America/New_York. We never round raw punches.

export const APP_TZ = 'America/New_York';

/** Seconds between two instants. Correct across DST and overnight because it
 *  operates on absolute epoch time, not wall-clock fields. */
export function durationSeconds(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 1000);
}

/** Exact decimal-hours from integer seconds, rounded to `dp` places (default 2)
 *  using half-up on integer math to avoid binary float drift. */
export function secondsToDecimalHours(seconds: number, dp = 2): number {
  if (!Number.isFinite(seconds)) throw new Error('seconds must be finite');
  const factor = 10 ** dp;
  // Integer-math half-up: compute (seconds * factor) / 3600 rounded, then scale
  // back. Operating on integers avoids binary-float drift (e.g. 0.1 + 0.2).
  return Math.round((seconds * factor) / 3600) / factor;
}

/** Format seconds as H:MM:SS for elapsed displays. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Wall-clock parts of an instant in a given IANA timezone. */
export function partsInTz(instant: Date, tz: string = APP_TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  // Intl can emit hour "24" at midnight; normalise to "00".
  if (p.hour === '24') p.hour = '00';
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
  };
}

/** Local calendar date (YYYY-MM-DD) of an instant in Team timezone.
 *  Used to bucket punches into the correct business day even across midnight. */
export function localDateKey(instant: Date, tz: string = APP_TZ): string {
  const { year, month, day } = partsInTz(instant, tz);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** True if the two instants fall on different Team-local calendar days
 *  (i.e. the shift crosses midnight). */
export function crossesMidnight(start: Date, end: Date, tz: string = APP_TZ): boolean {
  return localDateKey(start, tz) !== localDateKey(end, tz);
}

/**
 * Biweekly pay period containing `instant`, given an anchor period-end date.
 * Team: anchor_end_of_pay_period = 2020-04-26 (a Sunday period end), 14-day cycle.
 * Returns {start, end} as YYYY-MM-DD local date strings (inclusive dates).
 */
export function payPeriodFor(
  instant: Date,
  anchorEnd = '2020-04-26',
  lengthDays = 14,
  tz: string = APP_TZ,
): { start: string; end: string } {
  const dayNum = dateToDayNumber(localDateKey(instant, tz));
  const anchorNum = dateToDayNumber(anchorEnd);
  // The period end is the first date in the 14-day sequence on or after `day`.
  // A day landing exactly on a period end belongs to that (ending) period.
  const k = Math.ceil((dayNum - anchorNum) / lengthDays);
  const endNum = anchorNum + k * lengthDays;
  const startNum = endNum - (lengthDays - 1);
  return { start: dayNumberToDate(startNum), end: dayNumberToDate(endNum) };
}

/** Shift a pay period by n whole periods (n<0 = earlier). */
export function shiftPayPeriod(p: { start: string; end: string }, n: number, lengthDays = 14): { start: string; end: string } {
  return {
    start: dayNumberToDate(dateToDayNumber(p.start) + n * lengthDays),
    end: dayNumberToDate(dateToDayNumber(p.end) + n * lengthDays),
  };
}

/** Current pay period plus `back` previous and `forward` upcoming, oldest→newest. */
export function listPayPeriods(now: Date, back = 6, forward = 1, anchorEnd = '2020-04-26', lengthDays = 14, tz: string = APP_TZ): Array<{ start: string; end: string; isCurrent: boolean }> {
  const current = payPeriodFor(now, anchorEnd, lengthDays, tz);
  const out: Array<{ start: string; end: string; isCurrent: boolean }> = [];
  for (let n = -back; n <= forward; n++) {
    const p = shiftPayPeriod(current, n, lengthDays);
    out.push({ ...p, isCurrent: n === 0 });
  }
  return out;
}

/** Short label like "Jun 29 – Jul 12". */
export function payPeriodLabel(p: { start: string; end: string }): string {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${f(p.start)} – ${f(p.end)}`;
}

// --- integer day-number helpers (proleptic Gregorian, tz-independent) --------
function dateToDayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function dayNumberToDate(n: number): string {
  const dt = new Date(n * 86400000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
