import { createClient, type Session } from '@supabase/supabase-js';

// Central Login — your central login app (Supabase project YOUR-PROJECT)
// is the canonical identity provider. Everything here is PUBLIC by design:
// the pin-auth endpoint takes no key, and the anon key below is the project's
// public anon key (safe to ship in the browser — that's its purpose). No
// secrets, no env vars, per the Central Login spec.

const CHAT_URL = ((import.meta.env.VITE_CENTRAL_AUTH_URL ?? import.meta.env.VITE_SUPABASE_URL ?? 'http://localhost') as string);
const CHAT_ANON_KEY =
  ((import.meta.env.VITE_CENTRAL_AUTH_ANON_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'anon') as string);
const PIN_AUTH_URL = `${CHAT_URL}/functions/v1/pin-auth`;

// A dedicated Supabase client bound to the identity project. Used ONLY for
// session lifecycle (persist + silent refresh) — never for data. Its own
// storage key keeps it from clashing with the legacy per-app auth client.
export const chatAuth = createClient(CHAT_URL, CHAT_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'central-auth',
  },
});

export interface ChatProfile { id: string; full_name: string | null; phone: string | null; email: string | null }
export interface PinAuthResult { ok: boolean; session?: Session; profile?: ChatProfile; error?: string }

type PinAction = 'login' | 'setup' | 'forgot' | 'reset';

// Call the public pin-auth endpoint. It returns app-level errors with a non-2xx
// HTTP status (e.g. 404 for "not found"), so we trust the `ok` field, not the
// HTTP code.
async function pinAuth(action: PinAction, body: Record<string, unknown>): Promise<PinAuthResult> {
  let data: PinAuthResult;
  try {
    const res = await fetch(PIN_AUTH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    data = (await res.json().catch(() => ({ ok: false, error: 'Bad response from login service.' }))) as PinAuthResult;
  } catch {
    return { ok: false, error: 'Could not reach the login service. Check your connection.' };
  }
  return data;
}

// The most recent login profile. The chat JWT's phone claim is blank, so we
// keep profile.phone here to hand to /api/whoami on the first call so it can
// link this identity to our employee row (by last-10 phone).
let lastProfile: ChatProfile | null = null;
export function centralProfilePhone(): string | undefined {
  return lastProfile?.phone ?? undefined;
}

// Adopt a returned session into the central client so it persists + auto-refreshes.
async function adopt(result: PinAuthResult): Promise<PinAuthResult> {
  if (result.ok && result.session) {
    await chatAuth.auth.setSession({
      access_token: result.session.access_token,
      refresh_token: result.session.refresh_token,
    });
    if (result.profile) lastProfile = result.profile;
  }
  return result;
}

export const centralLogin = {
  login: (phone: string, pin: string) => pinAuth('login', { phone, pin }).then(adopt),
  setup: (phone: string, pin: string) => pinAuth('setup', { phone, pin }).then(adopt),
  forgot: (phone: string) => pinAuth('forgot', { phone }),
  reset: (phone: string, code: string, pin: string) => pinAuth('reset', { phone, code, pin }).then(adopt),
  signOut: () => chatAuth.auth.signOut(),
  getSession: () => chatAuth.auth.getSession().then((r) => r.data.session),
  onChange: (cb: (s: Session | null) => void) => chatAuth.auth.onAuthStateChange((_e, s) => cb(s)),
};
