import { requireEmployee } from './_shared/auth';
import { json, error, requireMethod } from './_shared/http';
import { rateLimit, getDailyHours, getDayEdits, sumWeek, addDays } from './_shared/employee-api';
import { deriveClockState, type StoredEvent } from '../../src/lib/domain/punch';
import { weekStartKey } from '../../src/lib/domain/segments';
import { payPeriodFor } from '../../src/lib/time';

// Read-only "My Hours" for EVERY employee — see your own totals in Team Time Clock.
// Scoped to the authenticated caller (identity from the token, never the body),
// so a person can only see their own hours. Numbers come from the same punches
// payroll uses, so they match the paycheck. No dollars, no clock actions.
//   GET /api/me/hours   (Authorization: Bearer <token>)

const weekdayOf = (date: string) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }); };

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET');
    const { admin, employee } = await requireEmployee(req);
    if (employee.timekeeping_access !== 'enabled') return error(403, 'not_enabled', 'Your time-clock access is not enabled.');
    if (!(await rateLimit(admin, employee.id, 'me/hours', 30))) return error(429, 'rate_limited', 'Too many requests — try again in a bit.');

    const now = new Date();
    const curPp = payPeriodFor(now);

    // Selected pay period: ?start=YYYY-MM-DD&end=YYYY-MM-DD lets staff look back at
    // previous/older periods. Defaults to the CURRENT period. Capped to a sane
    // span so a client can never request an unbounded range. Own-data only
    // (identity from the token), so this exposes nothing new.
    const url = new URL(req.url);
    const qpStart = url.searchParams.get('start') ?? '';
    const qpEnd = url.searchParams.get('end') ?? '';
    const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    let selStart = curPp.start, selEnd = curPp.end;
    if (isYmd(qpStart) && isYmd(qpEnd) && qpStart <= qpEnd) {
      selStart = qpStart;
      selEnd = addDays(selStart, 31) < qpEnd ? addDays(selStart, 31) : qpEnd;
    }
    const isCurrent = selStart === curPp.start && selEnd === curPp.end;

    const thisWeekStart = weekStartKey(now);
    const lastWeekStart = addDays(thisWeekStart, -7);
    const thisWeekEnd = addDays(thisWeekStart, 6);

    const [{ data: recent }, selMap, weekMap, edits] = await Promise.all([
      admin.from('punch_events').select('event_type, location_id, department_id, server_ts').eq('employee_id', employee.id).is('voided_at', null).order('server_ts', { ascending: false }).limit(20),
      getDailyHours(admin, employee.id, selStart, selEnd),
      getDailyHours(admin, employee.id, lastWeekStart, thisWeekEnd),
      getDayEdits(admin, employee.id, selStart, selEnd),
    ]);
    const state = deriveClockState((recent as StoredEvent[]) ?? []);

    // Day-by-day list for the SELECTED period (only days with a record).
    const days: Array<Record<string, unknown>> = [];
    let periodTotal = 0; let any = false;
    let d = selStart;
    while (d <= selEnd) {
      const v = selMap.get(d);
      if (v) {
        const total = v.total ?? (v.reg + v.ot);
        const open = v.total == null && v.source === 'live';
        // Only send the per-interval breakdown when a day has more than one (a
        // split shift / lunch); a normal single shift keeps the plain in–out line.
        const segments = v.segments && v.segments.length > 1 ? v.segments : undefined;
        days.push({ date: d, weekday: weekdayOf(d), in: v.in, out: v.out, total: open ? null : total, open, source: v.source, segments, edits: edits.get(d) });
        if (!open) { periodTotal += total; any = true; }
      }
      d = addDays(d, 1);
    }
    days.reverse(); // most recent first

    return json({
      employee_id: employee.id,
      is_clocked_in: state.isClockedIn,
      clocked_in_at: state.startedAt ?? null,
      period_start: selStart,
      period_end: selEnd,
      is_current_period: isCurrent,
      hours_this_period: any ? Math.round(periodTotal * 100) / 100 : null,
      // Week totals are "now" context — only meaningful on the current period.
      hours_this_week: isCurrent ? sumWeek(weekMap, thisWeekStart) : null,
      hours_last_week: isCurrent ? sumWeek(weekMap, lastWeekStart) : null,
      days,
      last_updated: new Date().toISOString(),
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] me-hours error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/me/hours' };
