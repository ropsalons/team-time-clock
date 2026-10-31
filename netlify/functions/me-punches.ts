import { requireEmployee } from './_shared/auth';
import { json, error, requireMethod } from './_shared/http';
import { rateLimit, getDailyHours, addDays } from './_shared/employee-api';
import { localDateKey } from '../../src/lib/time';

// Read-only "my recent punches" for the Team Team App. Own record only. Returns
// one row per worked day over the last 14 days: date, in, out, total (hours).
// in/out/total are null when unknown (e.g. an in-progress day) — never a false 0.
//   GET /api/me/punches   (Authorization: Bearer <supabase access token>)
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'GET');
    const { admin, employee } = await requireEmployee(req);
    if (!(await rateLimit(admin, employee.id, 'me/punches')))
      return error(429, 'rate_limited', 'Too many requests. Poll at most a few times per hour.');

    const today = localDateKey(new Date());   // ET calendar date
    const start = addDays(today, -13);         // 14 days inclusive
    const map = await getDailyHours(admin, employee.id, start, today);

    const punches = [...map.values()]
      .sort((a, b) => b.date.localeCompare(a.date))   // most recent first
      .map((d) => ({
        date: d.date,     // YYYY-MM-DD (ET)
        in: d.in,         // ISO 8601 or null
        out: d.out,       // ISO 8601 or null (null while still on the clock)
        total: d.total,   // decimal hours or null (unknown / in progress)
      }));

    return json({
      employee_id: employee.id,
      window_days: 14,
      range: { start, end: today },
      punches,
      last_updated: new Date().toISOString(),
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] me-punches error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/me/punches' };
