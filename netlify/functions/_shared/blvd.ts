// Minimal Boulevard GraphQL client for Team Time Clock.
//
// Team Time Clock is a timekeeping app; the ONLY thing it reads from Boulevard is a
// per-location guest (appointment) count for a given day, shown alongside
// labor in the Labor Detail slide-out. This is deliberately tiny and
// best-effort: if the Boulevard env vars are absent or Boulevard is throttled/
// down, callers degrade gracefully and the labor panel still works.
//
// Auth + retry mirror the Guest Experience dashboard's shared _blvd.js so the
// same Boulevard business/token works here.

import crypto from 'node:crypto';

const BLVD_ENDPOINT = 'https://dashboard.boulevard.io/api/2020-01/admin';
const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4000;

// Team Time Clock salon short_name  ->  Boulevard Location URN.
// "Remote" has no Boulevard location (no guests) and is intentionally absent.
export const BLVD_LOCATIONS: Record<string, string> = {
  Downtown: 'urn:blvd:Location:YOUR-LOCATION-ID',
  Uptown: 'urn:blvd:Location:YOUR-LOCATION-ID',
  Lakeside: 'urn:blvd:Location:YOUR-LOCATION-ID',
};

export function blvdConfigured(): boolean {
  return !!(process.env.BLVD_API_KEY && process.env.BLVD_SECRET_KEY && process.env.BLVD_BUSINESS_ID);
}

function authHeader(): string {
  const apiKey = process.env.BLVD_API_KEY!;
  const secretKey = process.env.BLVD_SECRET_KEY!;
  const businessId = process.env.BLVD_BUSINESS_ID!;
  const prefix = 'blvd-admin-v1';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = `${prefix}${businessId}${timestamp}`;
  const rawKey = Buffer.from(secretKey, 'base64');
  const signature = crypto.createHmac('sha256', rawKey).update(payload, 'utf8').digest('base64');
  const token = `${signature}${payload}`;
  return `Basic ${Buffer.from(`${apiKey}:${token}`, 'utf8').toString('base64')}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryableStatus = (s: number) => s === 429 || s === 502 || s === 503 || s === 504;
const retryableGql = (errs: any[]) => Array.isArray(errs) && errs.some((e) =>
  /throttl|rate.?limit|api\s*limit|limit\s*exceeded|please\s*wait|timeout|temporarily/i.test(e?.message || ''));
function waitHint(errs: any[]): number | null {
  if (!Array.isArray(errs)) return null;
  for (const e of errs) { const m = /please\s*wait\s*(\d{1,5})\s*ms/i.exec(e?.message || ''); if (m) return Math.min(Number(m[1]), MAX_BACKOFF_MS); }
  return null;
}

export async function blvd(query: string, label = 'blvd'): Promise<any> {
  if (!blvdConfigured()) throw new Error('boulevard_not_configured');
  let attempt = 0; let lastErr: unknown;
  while (attempt <= MAX_RETRIES) {
    try {
      const res = await fetch(BLVD_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: authHeader(), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (retryableStatus(res.status)) { lastErr = new Error(`[${label}] HTTP ${res.status}`); }
      else {
        const body = await res.json().catch(() => ({}));
        if (body?.errors && retryableGql(body.errors)) { lastErr = new Error(`[${label}] ${body.errors[0]?.message}`); const hint = waitHint(body.errors); if (hint) { await sleep(hint); attempt += 1; continue; } }
        else if (body?.errors) throw new Error(`[${label}] ${body.errors.map((e: any) => e.message).join('; ')}`);
        else return body.data;
      }
    } catch (e) { lastErr = e; }
    const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS) + Math.floor(Math.random() * 200);
    await sleep(backoff); attempt += 1;
  }
  throw lastErr ?? new Error(`[${label}] failed`);
}
