import { requireEmployee } from './_shared/auth';
import { json, error, requireMethod } from './_shared/http';

// Everything the clock screen needs in one authenticated call, so it never
// reads the database directly from the browser. This is what lets phone+PIN
// staff (whose session is a chat token my project's RLS won't accept) use the
// clock screen: the token is verified here and data comes back via service role.
// Works for legacy sessions too (requireEmployee accepts both).

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { admin, employee } = await requireEmployee(req);
    const empId = employee.id;

    const [{ data: locs }, { data: depts }, { data: locA }, { data: deptA }, { data: events }] = await Promise.all([
      admin.from('locations').select('id, short_name').eq('is_active', true).order('sort_order'),
      admin.from('departments').select('id, title').eq('is_active', true).order('sort_order'),
      admin.from('employee_location_assignments').select('location_id').eq('employee_id', empId),
      admin.from('employee_department_assignments').select('department_id').eq('employee_id', empId),
      admin.from('punch_events')
        .select('id, event_type, server_ts, location_id, department_id, note')
        .eq('employee_id', empId).is('voided_at', null)
        .order('server_ts', { ascending: false }).limit(20),
    ]);

    return json({
      ok: true,
      locations: (locs ?? []).map((l: any) => ({ id: l.id, name: l.short_name })),
      departments: (depts ?? []).map((d: any) => ({ id: d.id, name: d.title })),
      myLocationIds: (locA ?? []).map((a: any) => a.location_id),
      myDepartmentIds: (deptA ?? []).map((a: any) => a.department_id),
      events: events ?? [],
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] clock-bootstrap error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/clock-bootstrap' };
