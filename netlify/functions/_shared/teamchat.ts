// Post to Team Chat via the direct AI gateway (machine-to-machine).
// Replaces the older email bridge (@chat.example.com). Best-effort: never
// throws — returns { ok, error? } so callers can log and carry on. Secrets
// (TEAM_CHAT_GATEWAY_URL, TEAM_CHAT_TOKEN) live in Netlify env.

import { randomUUID } from 'node:crypto';

const GATEWAY = process.env.TEAM_CHAT_GATEWAY_URL ?? '';
const TOKEN = process.env.TEAM_CHAT_TOKEN ?? '';
const AUTHOR = 'Team Time Clock';

interface Result { ok: boolean; error?: string; messageId?: string }

async function call(body: Record<string, unknown>): Promise<Result> {
  if (!GATEWAY || !TOKEN) return { ok: false, error: 'team_chat_not_configured' };
  try {
    const res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ author_name: AUTHOR, idempotency_key: randomUUID(), ...body }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error ?? `http_${res.status}` };
    return { ok: true, messageId: data.message_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'gateway_error' };
  }
}

/** Post to a channel by slug (e.g. "payroll", "ai-updates"). */
export function postChannel(channel: string, text: string, title?: string): Promise<Result> {
  return call({ action: 'post_message', channel, text, ...(title ? { title } : {}) });
}

/** DM a person by their work email. */
export function sendDM(toEmail: string, text: string): Promise<Result> {
  return call({ action: 'send_dm', to_email: toEmail, text });
}
