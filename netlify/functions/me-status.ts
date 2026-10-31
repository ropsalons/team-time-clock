import { requireEmployee } from './_shared/auth';
import { json, error, requireMethod } from './_shared/http';
import { rateLimit, getDailyHours, sumWeek, addDays } from './_shared/employee-api';
import { deriveClockState, type StoredEvent } from '../../src/lib/domain/punch';
import { weekStartKey } from '../../src/lib/domain/segments';
import { payPeriodFor } from '../../src/lib/time';

// Read-only "my current status" for the Team Team App. Scoped to the AUTHENTICATED
// caller only (identity comes from the validated JWT, never the request), so an
// employee can only ever read their own hours. No clock actions, no dollars.
//   GET /api/me/status   (Authorization: Bearer <supabase access token>)
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET');
    const { admin, employee } = await requireEmployee(req);
    if (!(await rateLimit(admin, employee.id, 'me/status')))
      return error(429, 'rate_limited', 'Too many requests. Poll at most a few times per hour.');

    const now = new Date();
    const thisWeekStart = weekStartKey(now);          // Sunday of the current workweek (ET)
    const lastWeekStart = addDays(thisWeekStart, -7);
    const pp = payPeriodFor(now);

    // Current clock state from the app's own live punches (newest 20 is plenty).
    const { data: recent } = await admin.from('punch_events')
      .select('id, event_type, location_id, department_id, server_ts, note')
      .eq('employee_id', employee.id).is('voided_at', null)
      .order('server_ts', { ascending: false }).limit(20);
    const state = deriveClockState((recent as StoredEvent[]) ?? []);

    // Hours across this + last week.
    const map = await getDailyHours(admin, employee.id, lastWeekStart, addDays(thisWeekStart, 6));

    return json({
      employee_id: employee.id,
      is_clocked_in: state.isClockedIn,
      clocked_in_at: state.startedAt ?? null,           // ISO 8601, null if not clocked in
      hours_this_week: sumWeek(map, thisWeekStart),     // null when unknown — NEVER a false 0
      hours_last_week: sumWeek(map, lastWeekStart),     // null when unknown
      week_start: thisWeekStart,                        // YYYY-MM-DD (Sunday, ET)
      pay_period_end: pp.end ?? null,                   // YYYY-MM-DD, nullable
      last_updated: new Date().toISOString(),           // REQUIRED staleness stamp (ISO 8601)
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] me-status error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/me/status' };
