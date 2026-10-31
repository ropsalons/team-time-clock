import { adminClient } from './_shared/supabase';
import { json, error, readJson, requireMethod } from './_shared/http';

// First-time activation: an ENABLED employee sets their own password. Creates
// (or password-resets, if the auth user already exists) and links the account.
// Only works for employees an admin has already enabled — being in the roster
// is not enough. (A future hardening step adds admin-issued activation codes to
// remove the small pre-activation takeover window.)

interface Body { email: string; password: string }

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { email, password } = await readJson<Body>(req);
    if (!email || !/.+@.+/.test(email)) return error(400, 'bad_email', 'A valid email is required.');
    if (!password || password.length < 8) return error(400, 'weak_password', 'Password must be at least 8 characters.');
    const lower = email.toLowerCase();

    const admin = adminClient();

    // Must map to an enabled employee.
    const { data: emp } = await admin.from('employees')
      .select('id, first_name, timekeeping_access, auth_user_id')
      .ilike('email', lower).maybeSingle();
    if (!emp) return json({ ok: false, status: 'no_match' });
    if (emp.timekeeping_access !== 'enabled') return json({ ok: false, status: 'not_enabled' });

    // Find an existing auth user with this email (e.g. created by a prior magic link).
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const existing = list?.users?.find((u) => (u.email ?? '').toLowerCase() === lower);

    let userId: string;
    if (existing) {
      const { error: uErr } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
      if (uErr) return error(500, 'auth_error', uErr.message);
      userId = existing.id;
    } else {
      const { data: created, error: cErr } = await admin.auth.admin.createUser({ email: lower, password, email_confirm: true });
      if (cErr || !created?.user) return error(500, 'auth_error', cErr?.message ?? 'Could not create account.');
      userId = created.user.id;
    }

    // Link + roles (idempotent).
    await admin.from('employees').update({ auth_user_id: userId, last_login_at: new Date().toISOString() })
      .eq('id', emp.id);

    const { data: s } = await admin.from('app_settings').select('value').eq('key', 'bootstrap_admin_emails').maybeSingle();
    const bootstrap: string[] = Array.isArray(s?.value) ? (s!.value as string[]).map((x) => String(x).toLowerCase()) : [];
    await admin.from('user_roles').upsert(
      { auth_user_id: userId, role: 'employee', location_id: null }, { onConflict: 'auth_user_id,role,location_id', ignoreDuplicates: true });
    if (bootstrap.includes(lower)) {
      await admin.from('user_roles').upsert(
        { auth_user_id: userId, role: 'system_admin', location_id: null }, { onConflict: 'auth_user_id,role,location_id', ignoreDuplicates: true });
    }
    await admin.from('audit_logs').insert({ actor_label: `employee:${emp.first_name}`, action: 'password_activated', entity: 'employees', entity_id: emp.id, is_security_event: true });

    return json({ ok: true, status: 'activated' });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] set-password error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/set-password' };
