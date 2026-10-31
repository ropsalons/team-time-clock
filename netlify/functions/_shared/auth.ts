import { adminClient, anonClient } from './supabase';
import { error } from './http';
import { verifyChatJwt, last10, type ChatClaims } from './chat-jwt';

const EMP_SELECT = 'id, gusto_employee_uuid, first_name, timekeeping_access, can_transfer_location, can_transfer_department, can_manage_own_time, auth_user_id, chat_user_id, phone, email, home_location_id, home_department_id';

export interface AuthedEmployee {
  admin: ReturnType<typeof adminClient>;
  authUserId: string;
  employee: {
    id: string;
    gusto_employee_uuid: string;
    first_name: string;
    timekeeping_access: string;
    can_transfer_location: boolean;
    can_transfer_department: boolean;
    can_manage_own_time: boolean;
    home_location_id: string | null;
    home_department_id: string | null;
  };
  roles: string[];
}

function bearer(req: Request): string {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) throw error(401, 'unauthenticated', 'Missing bearer token.');
  return m[1];
}

/**
 * Verify the caller's Supabase JWT and load their employee row. The employee
 * identity comes ONLY from the validated token — never from the request body —
 * so a caller cannot punch/act as someone else by editing the payload.
 */
export async function requireEmployee(req: Request): Promise<AuthedEmployee> {
  const token = bearer(req);
  const admin = adminClient();

  // 1) Canonical path — a JWT from your central login app (shared Team identity).
  //    We trust WHO it is (verified signature/issuer/aud); WHAT they can see
  //    still comes from our own otc.user_roles.
  const chat = await verifyChatJwt(token);
  if (chat) {
    const emp = await resolveEmployeeFromChat(admin, chat);
    if (!emp) throw error(403, 'not_linked', 'No employee matches this login yet. Ask an administrator to confirm your mobile number is on file.');
    // Roles may be keyed by the legacy auth_user_id (existing staff) or by the
    // chat sub (new phone-only staff) — resolve under either.
    const keys = [emp.auth_user_id, chat.sub].filter(Boolean) as string[];
    const { data: roleRows } = await admin.from('user_roles').select('role').in('auth_user_id', keys);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    return { admin, authUserId: chat.sub, employee: emp as AuthedEmployee['employee'], roles };
  }

  // 2) Legacy path — this project's own Supabase session (email admins /
  //    pre-cutover). Kept so nothing breaks during the transition.
  const { data: userData, error: uErr } = await anonClient().auth.getUser(token);
  if (uErr || !userData?.user) throw error(401, 'unauthenticated', 'Invalid or expired session.');
  const authUserId = userData.user.id;
  const { data: emp, error: eErr } = await admin.from('employees').select(EMP_SELECT).eq('auth_user_id', authUserId).maybeSingle();
  if (eErr) throw error(500, 'db_error', 'Could not load employee.');
  if (!emp) throw error(403, 'not_linked', 'This account is not linked to an employee.');
  const { data: roleRows } = await admin.from('user_roles').select('role').eq('auth_user_id', authUserId);
  const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
  return { admin, authUserId, employee: emp as AuthedEmployee['employee'], roles };
}

// Map a verified chat identity to our employee: fast by stored chat_user_id,
// else by last-10 phone, else by email (admins). On first match we record
// chat_user_id and ensure the base 'employee' role, so it's a one-time linkage.
async function resolveEmployeeFromChat(admin: ReturnType<typeof adminClient>, chat: ChatClaims): Promise<Record<string, unknown> | null> {
  const byChat = await admin.from('employees').select(EMP_SELECT).eq('chat_user_id', chat.sub).maybeSingle();
  if (byChat.data) return byChat.data;

  let found: Record<string, unknown> | null = null;
  const p10 = last10(chat.phone);
  if (p10) {
    const { data: all } = await admin.from('employees').select(EMP_SELECT);
    found = (all ?? []).find((e: any) => last10(e.phone) === p10) ?? null;
  }
  if (!found && chat.email) {
    const { data: byEmail } = await admin.from('employees').select(EMP_SELECT).ilike('email', chat.email).maybeSingle();
    found = byEmail ?? null;
  }
  if (!found) return null;

  await admin.from('employees').update({ chat_user_id: chat.sub, last_login_at: new Date().toISOString() }).eq('id', found.id as string);
  await admin.from('user_roles').upsert(
    { auth_user_id: (found.auth_user_id as string) ?? chat.sub, role: 'employee', location_id: null },
    { onConflict: 'auth_user_id,role,location_id', ignoreDuplicates: true },
  );
  return { ...found, chat_user_id: chat.sub };
}

export function isAdmin(roles: string[]): boolean {
  return roles.includes('payroll_admin') || roles.includes('system_admin');
}
