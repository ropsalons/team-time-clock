import { verifyChatJwt, last10 } from './_shared/chat-jwt';
import { adminClient } from './_shared/supabase';
import { json, error, readJson, requireMethod } from './_shared/http';
import { postChannel } from './_shared/teamchat';

// "Who am I" for Central Login (your central login app). The chat JWT's `phone`
// claim is blank, so on the FIRST call the client passes the phone from the
// login response (`profile.phone`); we match the employee by last-10 phone (or
// email) and record chat_user_id = sub. After that, every request resolves by
// sub from the token alone — no phone hint needed.

interface Body { phone?: string }
const SEL = 'id, first_name, last_name, auth_user_id, chat_user_id, phone, email, home_location_id, home_department_id, timekeeping_access, can_manage_own_time';

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
    if (!m) return error(401, 'unauthenticated', 'Missing bearer token.');
    const chat = await verifyChatJwt(m[1]);
    if (!chat) return error(401, 'unauthenticated', 'Invalid or expired session.');
    const body = await readJson<Body>(req).catch(() => ({} as Body));

    const admin = adminClient();
    let emp: any = (await admin.from('employees').select(SEL).eq('chat_user_id', chat.sub).maybeSingle()).data;

    if (!emp) {
      const p10 = last10(body.phone || chat.phone);
      if (p10) {
        const { data: all } = await admin.from('employees').select(SEL);
        emp = (all ?? []).find((e: any) => last10(e.phone) === p10) ?? null;
      }
      if (!emp && chat.email) {
        emp = (await admin.from('employees').select(SEL).ilike('email', chat.email).maybeSingle()).data ?? null;
      }
      if (emp) {
        await admin.from('employees').update({ chat_user_id: chat.sub, last_login_at: new Date().toISOString() }).eq('id', emp.id);
        await admin.from('user_roles').upsert(
          { auth_user_id: emp.auth_user_id ?? chat.sub, role: 'employee', location_id: null },
          { onConflict: 'auth_user_id,role,location_id', ignoreDuplicates: true },
        );
        await admin.from('audit_logs').insert({ actor_label: `employee:${emp.first_name}`, action: 'central_identity_linked', entity: 'employees', entity_id: emp.id, is_security_event: true, after_value: { chat_sub: chat.sub } });
        // Announce the new registration in Team Chat (best-effort — never blocks login).
        const who = `${emp.first_name} ${emp.last_name ?? ''}`.trim();
        try { await postChannel('brand-time', `✅ ${who} just set up Team Time Clock and signed in. They're now on the new time clock.`); } catch { /* best-effort */ }
      }
    }

    if (!emp) return json({ ok: false, status: 'no_match' });
    if (emp.timekeeping_access !== 'enabled') return json({ ok: false, status: 'not_enabled' });

    const keys = [emp.auth_user_id, chat.sub].filter(Boolean) as string[];
    const { data: rr } = await admin.from('user_roles').select('role').in('auth_user_id', keys);
    const roles = (rr ?? []).map((r: { role: string }) => r.role);
    return json({ ok: true, employee: { id: emp.id, first_name: emp.first_name, home_location_id: emp.home_location_id, home_department_id: emp.home_department_id, can_manage_own_time: !!emp.can_manage_own_time }, roles });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] whoami error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/whoami' };
