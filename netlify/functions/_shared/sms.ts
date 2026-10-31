// Twilio SMS send. Credentials only in Netlify env. Best-effort; returns status.
export async function sendSms(to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return { ok: false, error: 'twilio_not_configured' };
  if (!to) return { ok: false, error: 'no_recipient' };
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); return { ok: false, error: `twilio ${r.status}: ${t.slice(0, 200)}` }; }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'exception' };
  }
}
