import { adminClient } from './_shared/supabase';
import { json, error, readJson, requireMethod } from './_shared/http';
import { normalizePhone, isValidPin, provisionPinUser, signInPhonePin, type EmpRow } from './_shared/pin';

// First-time activation for phone staff: an ENABLED employee sets their own
// 4-digit PIN using the mobile number on file. Creates/links their account and
// signs them in (returns session tokens). Additive to email login.

interface Body { phone: string; pin: string }

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { phone, pin } = await readJson<Body>(req);
    const e164 = normalizePhone(phone);
    if (!e164) return error(400, 'bad_phone', 'A valid mobile number is required.');
    if (!isValidPin(pin)) return error(400, 'bad_pin', 'PIN must be exactly 4 digits.');

    const admin = adminClient();
    // Match an employee by the phone on file. Compare on normalized digits.
    const { data: candidates } = await admin.from('employees')
      .select('id, first_name, email, phone, auth_user_id, timekeeping_access');
    const emp = (candidates ?? []).find((e: any) => normalizePhone(e.phone || '') === e164) as EmpRow | undefined;
    if (!emp) return json({ ok: false, status: 'no_match' });
    if (emp.timekeeping_access !== 'enabled') return json({ ok: false, status: 'not_enabled' });

    await provisionPinUser(admin, emp, e164, pin);
    await admin.from('audit_logs').insert({ actor_label: `employee:${emp.first_name}`, action: 'pin_activated', entity: 'employees', entity_id: emp.id, is_security_event: true, after_value: { phone_last4: e164.slice(-4) } });

    const tokens = await signInPhonePin(e164, pin);
    if (!tokens) return error(500, 'auth_error', 'PIN set but sign-in failed; try signing in.');
    return json({ ok: true, status: 'activated', ...tokens });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] set-pin error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/set-pin' };
