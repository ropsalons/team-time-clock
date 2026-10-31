import { requireEmployee, isAdmin } from './_shared/auth';
import { json, error, readJson, requireMethod } from './_shared/http';
import { sendEmail } from './_shared/notify';
import { inviteEmailSubject, inviteEmailText, asLang } from './_shared/invite-text';

// Admin-only: email an employee their setup link (uses the email already on file).
// `lang` ('en' | 'es') picks the message language (admin chooses per person).
interface Body { employeeId: string; lang?: string }
const APP_URL = process.env.APP_URL ?? 'https://timeclock.example.com';

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { admin, roles } = await requireEmployee(req);
    if (!isAdmin(roles)) return error(403, 'forbidden', 'Administrator access required.');

    const body = await readJson<Body>(req);
    const employeeId = body.employeeId;
    const lang = asLang(body.lang);
    const { data: emp } = await admin.from('employees').select('id, first_name, email, timekeeping_access').eq('id', employeeId).maybeSingle();
    if (!emp) return error(404, 'no_employee', 'Employee not found.');
    if (!emp.email) return error(400, 'no_email', 'No email on file for this employee.');
    if (emp.timekeeping_access !== 'enabled') return error(409, 'not_enabled', 'Enable this employee before inviting them.');

    const r = await sendEmail({
      to: [emp.email],
      subject: inviteEmailSubject(lang),
      text: inviteEmailText(emp.first_name, APP_URL, lang),
    });
    if (!r.ok) return error(502, 'email_failed', `Email failed: ${r.error}`);
    await admin.from('audit_logs').insert({ action: 'invite_email', entity: 'employees', entity_id: emp.id, after_value: { email: emp.email, lang } });
    return json({ ok: true });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] invite-email error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/invite-email' };
