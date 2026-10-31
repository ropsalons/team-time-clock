// Email notifications via Resend. Best-effort: never throws, so a mail failure
// can't break the underlying action. Credentials live only in Netlify env:
//   RESEND_API_KEY  (secret)
//   RESEND_FROM     (e.g. "Team Time Clock <timeclock@example.com>"; needs a
//                    verified Resend domain — falls back to Resend's test sender)

// Default to Team's VERIFIED Resend domain so mail delivers to everyone even if
// the RESEND_FROM env var isn't reaching this function. Override via RESEND_FROM.
const FROM = process.env.RESEND_FROM ?? 'Team Time Clock <timeclock@example.com>';

export async function sendEmail(opts: { to: string[]; subject: string; text: string; html?: string }): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'RESEND_API_KEY not set' };
  const to = opts.to.filter(Boolean);
  if (!to.length) return { ok: false, error: 'no recipients' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject: opts.subject, text: opts.text, html: opts.html ?? undefined }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('[otc] resend error', r.status, body.slice(0, 300));
      return { ok: false, error: `resend ${r.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    console.error('[otc] resend exception', e);
    return { ok: false, error: 'exception' };
  }
}

/** Recipients for admin notifications: app_settings.notify_emails, else OWNER_NOTIFY_EMAIL (comma-separated). */
export async function notifyRecipients(admin: { from: (t: string) => any }): Promise<string[]> {
  try {
    const { data } = await admin.from('app_settings').select('value').eq('key', 'notify_emails').maybeSingle();
    if (Array.isArray(data?.value) && data.value.length) return (data.value as unknown[]).map(String);
  } catch { /* ignore */ }
  return (process.env.OWNER_NOTIFY_EMAIL ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}
