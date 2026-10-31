import crypto from 'node:crypto';
import { anonClient, adminClient } from './supabase';

// Phone + 4-digit PIN login for salon staff who don't use email.
//
// Design: we DON'T touch Supabase's auth provider config. Each phone maps to a
// synthetic, non-routable internal email used only as the Supabase identity —
// staff never see or type it. The Supabase password is derived from the PIN via
// HMAC(APP_PIN_SECRET, phone:pin), so:
//   - the stored/at-rest secret is a 64-char hash, not 4 digits;
//   - we never store the PIN anywhere;
//   - email login keeps working unchanged (this is purely additive).
// The employee's REAL phone stays on the employees row; only the auth identity
// is synthetic.

// US-centric E.164: 10 digits -> +1XXXXXXXXXX; passes through +...
export function normalizePhone(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

// Synthetic auth email for a phone. Never emailed, never shown to the user.
export function syntheticEmail(e164: string): string {
  return `${e164.replace(/\D/g, '')}@pin.example.com`;
}

export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin || '');
}

// Deterministic Supabase password from the PIN. Stable for the life of the
// app: if APP_PIN_SECRET ever changes, every PIN stops working.
export function derivePinPassword(e164: string, pin: string): string {
  const secret = process.env.APP_PIN_SECRET;
  if (!secret) throw new Error('APP_PIN_SECRET is not configured');
  return crypto.createHmac('sha256', secret).update(`${e164}:${pin}`, 'utf8').digest('hex');
}

export interface SessionTokens { access_token: string; refresh_token: string }

// Sign in by phone+PIN via the synthetic email identity; returns session tokens
// for the client to adopt with supabase.auth.setSession(). Null on bad creds.
export async function signInPhonePin(e164: string, pin: string): Promise<SessionTokens | null> {
  const { data, error } = await anonClient().auth.signInWithPassword({
    email: syntheticEmail(e164),
    password: derivePinPassword(e164, pin),
  });
  if (error || !data?.session) return null;
  return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
}

export interface EmpRow { id: string; first_name: string; email: string | null; auth_user_id: string | null; timekeeping_access: string }

// Create-or-update the Supabase auth user for a phone+PIN identity, link it to
// the employee, and ensure the base 'employee' role. Idempotent. Returns the
// auth user id. Caller must have already checked the employee is enabled.
export async function provisionPinUser(admin: ReturnType<typeof adminClient>, emp: EmpRow, e164: string, pin: string): Promise<string> {
  const synth = syntheticEmail(e164);
  const password = derivePinPassword(e164, pin);

  // Prefer the already-linked auth user; else find one by synthetic email; else create.
  let userId = emp.auth_user_id ?? '';
  if (userId) {
    await admin.auth.admin.updateUserById(userId, { password, phone: undefined });
  } else {
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const existing = list?.users?.find((u) => (u.email ?? '').toLowerCase() === synth);
    if (existing) {
      await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
      userId = existing.id;
    } else {
      const { data: created, error: cErr } = await admin.auth.admin.createUser({ email: synth, password, email_confirm: true });
      if (cErr || !created?.user) throw new Error(cErr?.message ?? 'Could not create account.');
      userId = created.user.id;
    }
  }

  await admin.from('employees').update({ auth_user_id: userId, last_login_at: new Date().toISOString() }).eq('id', emp.id);
  await admin.from('user_roles').upsert(
    { auth_user_id: userId, role: 'employee', location_id: null },
    { onConflict: 'auth_user_id,role,location_id', ignoreDuplicates: true },
  );
  return userId;
}

// Six-digit numeric reset code (leading zeros preserved).
export function makeResetCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}
export function hashResetCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}
