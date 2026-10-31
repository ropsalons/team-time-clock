import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && anon);

// Browser client. Reads are RLS-gated; the `otc` schema holds our tables.
// `cache: 'no-store'` on every request is deliberate: clock state is live and
// must never be served from the browser's HTTP cache. Without it, a stale
// "clocked in" response could be replayed from disk across reloads/restarts.
export const supabase = createClient(url ?? 'http://localhost', anon ?? 'anon', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  db: { schema: 'otc' },
  global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
});

/**
 * Bearer token for calling Netlify Functions. Prefers the central (chat) session
 * when present — staff signed in with phone+PIN carry a chat token; email admins
 * carry this project's token. Our functions accept either.
 */
export async function accessToken(): Promise<string | null> {
  const { chatAuth } = await import('./chatAuth');
  const central = (await chatAuth.auth.getSession()).data.session?.access_token;
  if (central) return central;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
