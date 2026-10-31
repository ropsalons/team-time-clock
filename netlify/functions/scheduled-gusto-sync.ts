import { adminClient } from './_shared/supabase';
import { runGustoSync, gustoConfigured } from './_shared/gusto';
import { sendDM } from './_shared/teamchat';

// Nightly Gusto reconcile (schedule declared in netlify.toml: 0 8 * * * UTC).
// No-ops quietly until the app's Gusto OAuth credentials are configured, so it
// is safe to ship before the token exists.
export default async (): Promise<Response> => {
  if (!gustoConfigured()) {
    console.log('[otc] gusto-sync skipped — not configured');
    return new Response('skipped: not configured', { status: 200 });
  }
  const admin = adminClient();
  const s = await runGustoSync(admin);
  console.log('[otc] gusto-sync', JSON.stringify(s));

  // Only bother the owner when something actually changed (or a real error occurred).
  const changed = s.newHires.length || s.terminated.length || s.reactivatedConflicts.length;
  if (changed || s.error) {
    const lines = [
      `Gusto sync ${s.error ? 'FAILED' : 'ran'} — scanned ${s.scanned}.`,
      s.newHires.length ? `New in Gusto (now pending review): ${s.newHires.join(', ')}` : '',
      s.terminated.length ? `Terminated in Gusto (clock-in disabled): ${s.terminated.join(', ')}` : '',
      s.reactivatedConflicts.length ? `Re-activated in Gusto, needs review: ${s.reactivatedConflicts.join(', ')}` : '',
      s.error ? `Error: ${s.error}` : '',
    ].filter(Boolean);
    const owner = process.env.OWNER_NOTIFY_EMAIL;
    if (owner) await sendDM(owner, lines.join('\n')).catch(() => {});
  }
  return new Response(JSON.stringify(s), { status: 200, headers: { 'content-type': 'application/json' } });
};
