import { adminClient } from './_shared/supabase';
import { sendSms } from './_shared/sms';
import { deriveClockState, type StoredEvent } from '../../src/lib/domain/punch';
import { durationSeconds } from '../../src/lib/time';

// Scheduled: texts anyone still clocked in past the threshold, once per shift.
// Admin-toggleable via app_settings.clockout_reminder_enabled / _hours.
const APP_URL = process.env.APP_URL ?? 'https://timeclock.example.com';

export default async (): Promise<Response> => {
  const admin = adminClient();

  const { data: settings } = await admin.from('app_settings').select('key, value')
    .in('key', ['clockout_reminder_enabled', 'clockout_reminder_hours']);
  const s = Object.fromEntries((settings ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  if (s['clockout_reminder_enabled'] === false) return json({ ok: true, skipped: 'disabled' });
  const thresholdSec = (typeof s['clockout_reminder_hours'] === 'number' ? s['clockout_reminder_hours'] : 12) * 3600;

  const { data: emps } = await admin.from('employees')
    .select('id, first_name, phone, clockout_reminded_for')
    .eq('timekeeping_access', 'enabled').not('phone', 'is', null);

  const now = new Date();
  const locNames = new Map<string, string>();
  for (const l of (await admin.from('locations').select('id, short_name')).data ?? []) locNames.set(l.id, l.short_name);

  let checked = 0, reminded = 0; const errors: string[] = [];
  for (const e of emps ?? []) {
    checked++;
    const { data: ev } = await admin.from('punch_events')
      .select('event_type, location_id, department_id, server_ts')
      .eq('employee_id', e.id).is('voided_at', null)
      .order('server_ts', { ascending: false }).limit(60);
    const state = deriveClockState((ev as StoredEvent[]) ?? []);
    if (!state.isClockedIn || !state.startedAt) continue;
    if (durationSeconds(new Date(state.startedAt), now) < thresholdSec) continue;
    // already reminded for this exact open shift?
    if (e.clockout_reminded_for && Date.parse(e.clockout_reminded_for) === Date.parse(state.startedAt)) continue;

    const since = new Date(state.startedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    const loc = state.locationId ? locNames.get(state.locationId) ?? '' : '';
    const msg = `Team Time Clock: you've been clocked in${loc ? ` at ${loc}` : ''} since ${since}. If you forgot to clock out, open ${APP_URL}. If you're still working, ignore this.`;
    const r = await sendSms(e.phone as string, msg);
    if (r.ok) {
      reminded++;
      await admin.from('employees').update({ clockout_reminded_for: state.startedAt }).eq('id', e.id);
      await admin.from('audit_logs').insert({ action: 'clockout_reminder_sent', entity: 'employees', entity_id: e.id, after_value: { since } });
    } else {
      errors.push(`${e.first_name}: ${r.error}`);
    }
  }
  console.log(`[otc] clockout-reminder: checked ${checked}, reminded ${reminded}${errors.length ? ', errors: ' + errors.join('; ') : ''}`);
  return json({ ok: true, checked, reminded, errors });
};

function json(b: unknown) { return new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }); }

// Runs hourly (UTC). The 12h threshold prevents spurious reminders.
export const config = { schedule: '@hourly' };
