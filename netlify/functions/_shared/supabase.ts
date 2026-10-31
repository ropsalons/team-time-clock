import { createClient } from '@supabase/supabase-js';

// Two clients:
//  - admin: service-role key, bypasses RLS. NEVER exposed to the browser.
//  - anon:  used only to validate a caller's JWT via auth.getUser(token).
// All queries target the `otc` schema.

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';

if (!url) console.error('[otc] SUPABASE_URL is not set');

export function adminClient() {
  if (!serviceRole) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'otc' },
  });
}

export function anonClient() {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
