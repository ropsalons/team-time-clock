import { json, requireMethod } from './_shared/http';
import { adminClient } from './_shared/supabase';

// The Standard — Daily, served SAME-ORIGIN from Team Time Clock's own backend so the
// clock screen never depends on reaching the command-center host directly (an
// ISP black-holed *.netlify.app on Sep 18, 2026). It reads the very same
// app_config bank the command-center cron writes — the bank lives in the same
// Supabase project Team Time Clock already uses — so this is always in sync with what
// posted to Team Chat #announcements. Content is the public announcement line,
// so no auth is required. On any problem it returns line:null and the clock
// screen simply shows the inspirational quote — it must never break the clock.
//   GET /api/standard-today

function etToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

export default async (req: Request): Promise<Response> => {
  const soft = (body: Record<string, unknown>) => json(body, 200, { 'cache-control': 'public, max-age=300' });
  try {
    requireMethod(req, 'GET');
    const today = etToday();
    const db = adminClient().schema('public');

    // A shout-out (or any override) the cron actually posted today wins, so the
    // app matches Chat exactly.
    const { data: todayRow } = await db.from('app_config').select('value').eq('key', 'DAILY_STANDARD_TODAY').maybeSingle();
    if (todayRow?.value) {
      try {
        const o = JSON.parse(todayRow.value);
        if (o && o.date === today && o.line) return soft({ ok: true, ...o });
      } catch { /* fall through to the bank */ }
    }

    const { data: bankRow } = await db.from('app_config').select('value').eq('key', 'DAILY_STANDARD_BANK').maybeSingle();
    if (!bankRow?.value) return soft({ ok: true, active: false, date: today, line: null, post: null });
    const bank = JSON.parse(bankRow.value);
    const entry = (bank.entries || []).find((e: { date: string }) => e.date === today);
    if (!bank.active || !entry) return soft({ ok: true, active: !!bank.active, date: today, line: null, post: null });
    return soft({ ok: true, active: true, date: today, type: entry.type, line: entry.line, post: entry.post });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] standard-today error', e);
    return soft({ ok: false, line: null, post: null });
  }
};

export const config = { path: '/api/standard-today' };
