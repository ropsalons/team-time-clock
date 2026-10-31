import { anonClient, adminClient } from './_shared/supabase';
import { json, error, requireMethod } from './_shared/http';

// First-login linking: match the authenticated user's email to a Gusto-sourced
// employee row and bind auth_user_id. Only links employees whose timekeeping
// access an admin has already ENABLED — being in the roster is not enough.

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const token = (/^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '') ?? [])[1];
    if (!token) return error(401, 'unauthenticated', 'Missing bearer token.');

    const { data: userData, error: uErr } = await anonClient().auth.getUser(token);
    if (uErr || !userData?.user?.email) return error(401, 'unauthenticated', 'Invalid session.');
    const authUserId = userData.user.id;
    const email = userData.user.email.toLowerCase();

    const admin = adminClient();

    // Grant system_admin for bootstrap admin emails (idempotent).
    const grantBootstrapAdmin = async () => {
      const { data: s } = await admin.from('app_settings').select('value').eq('key', 'bootstrap_admin_emails').maybeSingle();
      const list: string[] = Array.isArray(s?.value) ? (s!.value as string[]).map((x) => String(x).toLowerCase()) : [];
      if (list.includes(email)) {
        await admin.from('user_roles').upsert(
          { auth_user_id: authUserId, role: 'system_admin', location_id: null },
          { onConflict: 'auth_user_id,role,location_id', ignoreDuplicates: true },
        );
      }
    };
    const roles = async (): Promise<string[]> => {
      const { data } = await admin.from('user_roles').select('role').eq('auth_user_id', authUserId);
      return (data ?? []).map((r: { role: string }) => r.role);
    };

    // Already linked?
    const { data: linked } = await admin.from('employees')
      .select('id, first_name, timekeeping_access, home_location_id, home_department_id, can_manage_own_time').eq('auth_user_id', authUserId).maybeSingle();
    if (linked) { await grantBootstrapAdmin(); return json({ ok: true, status: 'already_linked', employee: linked, roles: await roles() }); }

    // Find an unlinked employee with this email.
    const { data: match } = await admin.from('employees')
      .select('id, first_name, timekeeping_access, auth_user_id, home_location_id, home_department_id, can_manage_own_time')
      .ilike('email', email).is('auth_user_id', null).maybeSingle();

    if (!match) return json({ ok: false, status: 'no_match' });
    if (match.timekeeping_access !== 'enabled')
      return json({ ok: false, status: 'not_enabled' }); // admin hasn't granted access yet

    const { error: updErr } = await admin.from('employees')
      .update({ auth_user_id: authUserId, last_login_at: new Date().toISOString() })
      .eq('id', match.id).is('auth_user_id', null);
    if (updErr) return error(500, 'db_error', 'Could not link account.');

    await admin.from('user_roles').upsert(
      { auth_user_id: authUserId, role: 'employee', location_id: null },
      { onConflict: 'auth_user_id,role,location_id', ignoreDuplicates: true },
    );
    await grantBootstrapAdmin();
    await admin.from('audit_logs').insert({
      actor_label: `employee:${match.first_name}`, action: 'account_linked',
      entity: 'employees', entity_id: match.id, is_security_event: true,
    });

    return json({ ok: true, status: 'linked', employee: { id: match.id, first_name: match.first_name, home_location_id: match.home_location_id, home_department_id: match.home_department_id, can_manage_own_time: !!match.can_manage_own_time }, roles: await roles() });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] link-account error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/link-account' };
