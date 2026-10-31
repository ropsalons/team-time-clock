import { adminClient } from './_shared/supabase';
import { deriveSegments } from '../../src/lib/domain/segments';
import type { StoredEvent } from '../../src/lib/domain/punch';
import { sendSms } from './_shared/sms';
import { postChannel } from './_shared/teamchat';

// Daily overnight-span watch. Shifts are not expected to run overnight, so a clock-in on
// one ET day paired with a clock-out on the next is always a forgotten clock-out
// (it also silently inflates hours). Every morning this finds any such span in
// the last few days, TEXTS the employee once to ask for their real clock-out
// time, and posts a flag to the payroll channel. Those spans are already
// excluded from hour totals until a human fixes them (see segments.ts).
//
// 15:00 UTC = 11:00 AM EDT / 10:00 AM EST — late enough that yesterday's open
// shift has been closed by this morning's re-clock-in.

const etDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
function normPhone(raw: string): string {
  const s = (raw || '').trim(); if (!s) return '';
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : '';
}

export default async (): Promise<Response> => {
  const admin = adminClient();
  const now = Date.now();
  const startTs = new Date(now - 4 * 86400000).toISOString(); // last 4 days
  const [{ data: pev }, { data: es }] = await Promise.all([
    admin.from('punch_events').select('employee_id, event_type, location_id, department_id, server_ts').is('voided_at', null).gte('server_ts', startTs).order('server_ts', { ascending: true }),
    admin.from('employees').select('id, first_name, last_name, phone'),
  ]);
  const empById = new Map((es ?? []).map((e: any) => [e.id, e]));
  const byEmp = new Map<string, any[]>();
  for (const ev of pev ?? []) { const a = byEmp.get(ev.employee_id) ?? []; a.push(ev); byEmp.set(ev.employee_id, a); }

  // Collect completed overnight spans.
  const spans: Array<{ empId: string; inTs: string; outTs: string; inDay: string; outDay: string }> = [];
  for (const [empId, evs] of byEmp) {
    for (const s of deriveSegments(evs as StoredEvent[])) {
      if (s.crossesMidnight && s.endedAt) spans.push({ empId, inTs: s.startedAt, outTs: s.endedAt, inDay: etDay(s.startedAt), outDay: etDay(s.endedAt) });
    }
  }

  // Which have we already texted about? (dedupe on employee + clock-in day)
  const { data: prior } = await admin.from('audit_logs').select('after_value').eq('action', 'overnight_notified').gte('created_at', new Date(now - 10 * 86400000).toISOString());
  const notified = new Set((prior ?? []).map((r: any) => r?.after_value?.span_key).filter(Boolean));

  const texted: string[] = []; const skipped: string[] = [];
  for (const sp of spans) {
    const key = `${sp.empId}|${sp.inDay}`;
    if (notified.has(key)) continue;
    const emp = empById.get(sp.empId); if (!emp) continue;
    const phone = normPhone(emp.phone ?? '');
    const label = `${emp.first_name} ${emp.last_name}`;
    const body =
      `Hi ${emp.first_name}, it's Sample Salon Co. On ${fmt(sp.inTs)} you clocked in, but it looks like you forgot to clock out that day — the system shows you clocking out the NEXT day (${fmt(sp.outTs)}), which isn't right.\n\n` +
      `What time did you actually clock OUT that first day? And did you work the next day (${new Date(sp.outTs).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' })})? If so, what times? Reply and we'll fix your hours. Thanks!`;
    let ok = false; let err: string | undefined;
    if (phone) { const r = await sendSms(phone, body); ok = r.ok; err = r.error; } else err = 'no phone on file';
    await admin.from('audit_logs').insert({ actor_label: 'system:overnight-watch', action: 'overnight_notified', entity: 'punch_events', entity_id: sp.empId, after_value: { span_key: key, in: sp.inTs, out: sp.outTs, texted: ok, error: err ?? null }, is_security_event: false });
    (ok ? texted : skipped).push(`${label} (${sp.inDay}${ok ? '' : ` — ${err}`})`);
  }

  // Flag the payroll channel with anything found (texted or needing manual chase).
  try {
    if (texted.length || skipped.length) {
      const lines = [`⏰ Overnight-span check — ${spans.length} found, ${texted.length} newly texted.`];
      if (texted.length) lines.push(`Texted for the real clock-out: ${texted.join(', ')}.`);
      if (skipped.length) lines.push(`⚠️ Couldn't text (chase manually): ${skipped.join(', ')}.`);
      lines.push(`These are excluded from hours until fixed. Review in Team Time Clock (Payroll).`);
      await postChannel('payroll', lines.join('\n'));
    }
  } catch { /* best-effort */ }

  return new Response(JSON.stringify({ ok: true, spans: spans.length, texted: texted.length, skipped: skipped.length }), { status: 200, headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '0 15 * * *' };
