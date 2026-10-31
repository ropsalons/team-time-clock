import { requireEmployee } from './_shared/auth';
import { json, error, readJson, requireMethod } from './_shared/http';
import { decidePunch, deriveClockState, punchIdempotencyKey, type PunchAction, type StoredEvent } from '../../src/lib/domain/punch';
import { payPeriodFor } from '../../src/lib/time';

interface PunchBody {
  action: PunchAction;
  locationId?: string | null;
  departmentId?: string | null;
  note?: string | null;
  clientNonce: string;      // stable per intended action -> idempotency
  employeeTs?: string | null;
  offline?: boolean;        // true => punch was queued offline; employeeTs is the real tap time
  geolocation?: { latitude: number; longitude: number } | null;
}

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { admin, employee } = await requireEmployee(req);

    if (employee.timekeeping_access !== 'enabled') {
      return error(403, 'access_disabled', 'Your timekeeping access is not enabled. Contact an administrator.');
    }

    const body = await readJson<PunchBody>(req);
    if (!body.clientNonce) return error(400, 'missing_nonce', 'clientNonce is required.');
    if (body.action === 'location_transfer' && !employee.can_transfer_location)
      return error(403, 'transfer_not_allowed', 'Location transfers are not enabled for you.');
    if (body.action === 'department_transfer' && !employee.can_transfer_department)
      return error(403, 'transfer_not_allowed', 'Department transfers are not enabled for you.');

    // settings
    const { data: settingRows } = await admin.from('app_settings').select('key,value')
      .in('key', ['require_location', 'require_department']);
    const settings = Object.fromEntries((settingRows ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
    const requireLocation = settings['require_location'] !== false;
    const requireDepartment = settings['require_department'] !== false;

    // Derive current state from this employee's recent event log.
    const { data: recent, error: rErr } = await admin
      .from('punch_events')
      .select('event_type, location_id, department_id, server_ts')
      .eq('employee_id', employee.id)
      .is('voided_at', null)
      .order('server_ts', { ascending: false })
      .limit(100);
    if (rErr) return error(500, 'db_error', 'Could not read punch history.');
    const state = deriveClockState((recent ?? []) as StoredEvent[]);

    const decision = decidePunch(state, {
      action: body.action,
      locationId: body.locationId ?? null,
      departmentId: body.departmentId ?? null,
      requireLocation,
      requireDepartment,
    });
    if (!decision.ok) return error(409, decision.code, decision.message);

    // Offline punch: the moment the employee TAPPED is authoritative (they had
    // no signal then). Trust employeeTs as the punch time, but only within a
    // sane window (not in the future, not absurdly old) so a bad/garbage clock
    // can't backdate a shift by weeks. Outside the window we fall back to now().
    const now = Date.now();
    const tapMs = body.employeeTs ? Date.parse(body.employeeTs) : NaN;
    const offline = body.offline === true
      && Number.isFinite(tapMs)
      && tapMs <= now + 5 * 60 * 1000            // at most 5 min ahead (clock skew)
      && tapMs >= now - 30 * 24 * 60 * 60 * 1000; // at most 30 days old
    const effectiveTs = offline ? new Date(tapMs).toISOString() : null;

    // Ensure the containing pay period exists; get its id.
    const pp = payPeriodFor(offline ? new Date(tapMs) : new Date());
    await admin.from('pay_periods').upsert(
      { start_date: pp.start, end_date: pp.end }, { onConflict: 'start_date,end_date', ignoreDuplicates: true },
    );
    const { data: ppRow } = await admin.from('pay_periods').select('id')
      .eq('start_date', pp.start).eq('end_date', pp.end).maybeSingle();

    const idempotency_key = punchIdempotencyKey(employee.id, body.action, body.clientNonce);

    // Carry forward location/department for the event being written.
    const eventLocation = body.action === 'department_transfer' ? state.locationId : (body.locationId ?? state.locationId);
    const eventDepartment = body.action === 'location_transfer' ? state.departmentId : (body.departmentId ?? state.departmentId);

    const row = {
      employee_id: employee.id,
      gusto_employee_uuid: employee.gusto_employee_uuid,
      event_type: decision.eventType,
      // Online: server_ts left to DB default now() (authoritative). Offline:
      // stamp it at the captured tap time so the queued punch has the real time.
      ...(offline ? { server_ts: effectiveTs } : {}),
      employee_ts: body.employeeTs ?? null,
      location_id: eventLocation,
      department_id: eventDepartment,
      note: body.note ?? null,
      source: offline ? 'employee_mobile_offline' : 'employee_mobile',
      latitude: body.geolocation?.latitude ?? null,
      longitude: body.geolocation?.longitude ?? null,
      pay_period_id: ppRow?.id ?? null,
      idempotency_key,
    };

    // Idempotent insert: a double-tap/retry with the same nonce collapses to one row.
    const { data: inserted, error: iErr } = await admin
      .from('punch_events')
      .upsert(row, { onConflict: 'idempotency_key', ignoreDuplicates: true })
      .select('id, event_type, server_ts, location_id, department_id')
      .maybeSingle();
    if (iErr) return error(500, 'db_error', `Could not record punch: ${iErr.message}`);

    let event = inserted;
    if (!event) {
      // Duplicate suppressed — return the existing event so the client sees success.
      const { data: existing } = await admin.from('punch_events')
        .select('id, event_type, server_ts, location_id, department_id')
        .eq('idempotency_key', idempotency_key).maybeSingle();
      event = existing ?? null;
    }

    const newState = deriveClockState([
      ...((recent ?? []) as StoredEvent[]),
      { event_type: decision.eventType, location_id: eventLocation, department_id: eventDepartment,
        server_ts: event?.server_ts ?? new Date().toISOString() },
    ]);

    return json({ ok: true, event, status: newState });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] punch error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/punch' };
