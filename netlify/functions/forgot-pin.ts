import { adminClient } from './_shared/supabase';
import { json, error, readJson, requireMethod } from './_shared/http';
import { normalizePhone, makeResetCode, hashResetCode } from './_shared/pin';

// Staff forgot-PIN: texts a 6-digit reset code to the mobile number on file.
// Always returns ok (no account enumeration). Code is valid 15 minutes.

interface Body { phone: string }
const CODE_TTL_MS = 15 * 60 * 1000;

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { phone } = await readJson<Body>(req);
    const e164 = normalizePhone(phone);
    if (!e164) return error(400, 'bad_phone', 'A valid mobile number is required.');

    const admin = adminClient();
    const { data: candidates } = await admin.from('employees').select('id, first_name, phone, timekeeping_access');
    const emp = (candidates ?? []).find((e: any) => normalizePhone(e.phone || '') === e164);

    // Only actually send when it maps to an enabled employee; response is identical either way.
    if (emp && emp.timekeeping_access === 'enabled') {
      const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM_NUMBER;
      if (sid && token && from) {
        const code = makeResetCode();
        await admin.from('pin_reset_codes').insert({ employee_id: emp.id, code_hash: hashResetCode(code), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
        const body = `Team Time Clock: your PIN reset code is ${code}. It expires in 15 minutes. If you didn't ask for this, ignore this text.`;
        const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: e164, From: from, Body: body }).toString(),
        });
        if (!resp.ok) { const r = await resp.json().catch(() => ({})); console.error('[otc] forgot-pin twilio', r?.code, r?.message); }
        await admin.from('audit_logs').insert({ actor_label: `employee:${emp.first_name}`, action: 'pin_reset_code_sent', entity: 'employees', entity_id: emp.id, is_security_event: true, after_value: { phone_last4: e164.slice(-4) } });
      } else {
        console.error('[otc] forgot-pin: Twilio not configured');
      }
    }
    return json({ ok: true });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] forgot-pin error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/forgot-pin' };
