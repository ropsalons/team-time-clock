import { json, requireMethod } from './_shared/http';
import { adminClient } from './_shared/supabase';

// Optional "daily standard" line for the clock screen, served same-origin from
// this app's own backend. It reads app_config keys DAILY_STANDARD_TODAY (a line
// for today) and DAILY_STANDARD_BANK (a list to rotate through), which you can
// fill yourself or from another tool. Content is the public announcement line,
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
