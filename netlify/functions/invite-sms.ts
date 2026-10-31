import { requireEmployee, isAdmin } from './_shared/auth';
import { json, error, readJson, requireMethod } from './_shared/http';
import { inviteSmsText, asLang } from './_shared/invite-text';

// Admin-only: text an employee their setup link via Twilio. Twilio credentials
// live ONLY in Netlify env vars (never in code, logs, or the browser):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
// If a phone is supplied it is also saved to the employee record for next time.
// `lang` ('en' | 'es') picks the message language (admin chooses per person).

interface Body { employeeId: string; phone?: string; lang?: string }

const APP_URL = process.env.APP_URL ?? 'https://timeclock.example.com';

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { admin, roles } = await requireEmployee(req);
    if (!isAdmin(roles)) return error(403, 'forbidden', 'Administrator access required.');

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) return error(400, 'twilio_not_configured', 'Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER in Netlify.');

    const body = await readJson<Body>(req);
    const { data: emp } = await admin.from('employees').select('id, first_name, phone, timekeeping_access').eq('id', body.employeeId).maybeSingle();
    if (!emp) return error(404, 'no_employee', 'Employee not found.');
    if (emp.timekeeping_access !== 'enabled') return error(409, 'not_enabled', 'Enable this employee before inviting them.');

    const phone = normalizePhone(body.phone || emp.phone || '');
    if (!phone) return error(400, 'no_phone', 'A phone number is required.');

    if (body.phone && normalizePhone(body.phone) !== normalizePhone(emp.phone || '')) {
      await admin.from('employees').update({ phone }).eq('id', emp.id);
    }

    // English stays plain GSM-7 (cheapest); Spanish uses proper accents (Unicode,
    // a few more segments — fine for an invite). See _shared/invite-text.ts.
    const lang = asLang(body.lang);
    const text = inviteSmsText(emp.first_name, APP_URL, lang);

    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: from, Body: text }).toString(),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[otc] twilio error', result?.code, result?.message);
      return error(502, 'sms_failed', `Twilio: ${result?.message ?? 'send failed'}`);
    }

    await admin.from('audit_logs').insert({ action: 'invite_sms', entity: 'employees', entity_id: emp.id, after_value: { to_last4: phone.slice(-4), lang } });
    return json({ ok: true, sid: result?.sid ?? null });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] invite-sms error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

// US-centric E.164 normalization: 10 digits -> +1XXXXXXXXXX; passes through +...
function normalizePhone(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

export const config = { path: '/api/invite-sms' };
