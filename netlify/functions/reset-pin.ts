import { adminClient } from './_shared/supabase';
import { json, error, readJson, requireMethod } from './_shared/http';
import { normalizePhone, isValidPin, hashResetCode, provisionPinUser, signInPhonePin, type EmpRow } from './_shared/pin';

// Complete a forgot-PIN: verify the texted code, set the new PIN, sign in.
// Codes are single-use, 15-minute, max 5 attempts.

interface Body { phone: string; code: string; pin: string }
const MAX_ATTEMPTS = 5;

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { phone, code, pin } = await readJson<Body>(req);
    const e164 = normalizePhone(phone);
    if (!e164) return error(400, 'bad_phone', 'A valid mobile number is required.');
    if (!/^\d{6}$/.test(code || '')) return error(400, 'bad_code', 'Enter the 6-digit code from your text.');
    if (!isValidPin(pin)) return error(400, 'bad_pin', 'PIN must be exactly 4 digits.');

    const admin = adminClient();
    const { data: candidates } = await admin.from('employees').select('id, first_name, email, phone, auth_user_id, timekeeping_access');
    const emp = (candidates ?? []).find((e: any) => normalizePhone(e.phone || '') === e164) as EmpRow | undefined;
    if (!emp || emp.timekeeping_access !== 'enabled') return error(400, 'invalid_code', 'That code is invalid or expired.');

    // Newest unused, unexpired code for this employee.
    const { data: rows } = await admin.from('pin_reset_codes')
      .select('id, code_hash, expires_at, used_at, attempts')
      .eq('employee_id', emp.id).is('used_at', null)
      .order('created_at', { ascending: false }).limit(1);
    const rec = rows?.[0];
    if (!rec || new Date(rec.expires_at).getTime() < Date.now()) return error(400, 'invalid_code', 'That code is invalid or expired.');
    if (rec.attempts >= MAX_ATTEMPTS) return error(429, 'too_many', 'Too many attempts. Request a new code.');

    if (rec.code_hash !== hashResetCode(code)) {
      await admin.from('pin_reset_codes').update({ attempts: rec.attempts + 1 }).eq('id', rec.id);
      return error(400, 'invalid_code', 'That code is invalid or expired.');
    }

    await admin.from('pin_reset_codes').update({ used_at: new Date().toISOString() }).eq('id', rec.id);
    await provisionPinUser(admin, emp, e164, pin);
    await admin.from('audit_logs').insert({ actor_label: `employee:${emp.first_name}`, action: 'pin_reset', entity: 'employees', entity_id: emp.id, is_security_event: true, after_value: { phone_last4: e164.slice(-4) } });

    const tokens = await signInPhonePin(e164, pin);
    if (!tokens) return error(500, 'auth_error', 'PIN reset but sign-in failed; try signing in.');
    return json({ ok: true, ...tokens });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] reset-pin error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/reset-pin' };
