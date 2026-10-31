import { requireEmployee, isAdmin } from './_shared/auth';
import { json, error, readJson, requireMethod } from './_shared/http';
import { sendDM } from './_shared/teamchat';

// Admin-only: DM an employee their setup link inside Team Chat (to the email on
// file). Only reaches people who have a Team Chat account with that email.
interface Body { employeeId: string }
const APP_URL = process.env.APP_URL ?? 'https://timeclock.example.com';

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { admin, roles } = await requireEmployee(req);
    if (!isAdmin(roles)) return error(403, 'forbidden', 'Administrator access required.');

    const { employeeId } = await readJson<Body>(req);
    const { data: emp } = await admin.from('employees').select('id, first_name, email, timekeeping_access').eq('id', employeeId).maybeSingle();
    if (!emp) return error(404, 'no_employee', 'Employee not found.');
    if (!emp.email) return error(400, 'no_email', 'No email on file for this employee.');
    if (emp.timekeeping_access !== 'enabled') return error(409, 'not_enabled', 'Enable this employee before inviting them.');

    const msg = `Hi ${emp.first_name} — set up the Team time clock here: ${APP_URL}\n` +
      `Tap "First time here? Set up your account," enter this email (${emp.email}), and choose a password. ` +
      `After that you just tap the big green button to clock in and out.`;

    const r = await sendDM(emp.email, msg);
    if (!r.ok) {
      const reason = r.error === 'team_chat_not_configured'
        ? 'Team Chat is not configured.'
        : `Could not reach them in Team Chat — they may not have a Team Chat account with ${emp.email}. (${r.error})`;
      return error(502, 'dm_failed', reason);
    }

    await admin.from('audit_logs').insert({ action: 'invite_teamchat', entity: 'employees', entity_id: emp.id, after_value: { email: emp.email, message_id: r.messageId ?? null } });
    return json({ ok: true });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] invite-teamchat error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/invite-teamchat' };
