// Correction decision engine — decides the time a "missed clock-in / clock-out"
// correction should be applied to, or refuses and asks for human review.
//
// Root-cause history: the old logic blindly trusted `requested_ts` (the
// employee's datetime-local picker value). That picker's TIME defaults to "now"
// on many phones, so an employee who typed the real time in the comment but only
// set the date in the picker produced a requested_ts with a bogus time — and it
// was applied verbatim (Harper Sample: comment said 11:06, picker said 6:37 PM →
// 6:37 PM was written). This engine fixes that with an explicit priority order,
// a text parser, AM/PM disambiguation, validation, and a NEVER-GUESS default.
//
// Priority when choosing the correction time:
//   1. EXACT OFFLINE PUNCH  — an offline-queued punch's real device timestamp.
//   2. EXPLICIT EMPLOYEE TIME — a time the employee stated in the comment.
//   3. REQUESTED TIME — the picker value, but only when it is not a "now" default
//      and nothing more reliable exists.
// If confidence is not high (ambiguous AM/PM, conflicts, failed validation, or no
// time at all) the decision is 'review' and NOTHING is written.

export type CorrectionKind = 'missed_clock_in' | 'missed_clock_out' | 'incorrect_time' | 'wrong_location' | 'wrong_department' | 'other';

export interface DayPunch { event_type: string; server_ts: string } // non-voided punches for the target ET day
export interface ResolveInput {
  kind: CorrectionKind;
  explanation: string;
  requestedTs: string | null; // ISO, from the picker (date is usually trustworthy, time often not)
  createdAt: string;          // ISO, when the request was submitted
  dayPunches: DayPunch[];     // the employee's non-voided punches on the target ET day
}
export type ResolveResult =
  | { decision: 'apply'; ts: string; source: 'offline_punch' | 'employee_explicit_time' | 'requested_time'; reason: string }
  | { decision: 'review'; reason: string }
  | { decision: 'unsupported' }; // not a missed_clock_* kind — caller handles it

const TZ = 'America/New_York';
const MAX_SHIFT_H = 14;        // a paired shift longer than this is implausible
const MIN_SHIFT_MIN = 1;       // must be at least this long
const CONFIDENT_SHIFT_H = 12;  // above this, a bare-AM/PM guess is not confident

// ---- ET time helpers --------------------------------------------------------
function etParts(iso: string) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hh: +(g('hour') === '24' ? '00' : g('hour')), mm: +g('minute') };
}
export function etDateStr(iso: string): string { return etParts(iso).date; }
function etMinutesOfDay(iso: string): number { const { hh, mm } = etParts(iso); return hh * 60 + mm; }
// Build a UTC ISO for an ET wall-clock date + h:m (DST-correct via offset probe).
export function etWallToIso(date: string, hh: number, mm: number): string {
  const local = `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' }).formatToParts(new Date(`${local}:00Z`)).find((x) => x.type === 'timeZoneName')?.value;
  return new Date(`${local}:00${name === 'EST' ? '-05:00' : '-04:00'}`).toISOString();
}

// ---- explicit-time parser ---------------------------------------------------
interface ParsedTime { hh12: number; mm: number; meridiem: 'am' | 'pm' | null; raw: string }
// Returns the time the employee explicitly stated FOR THE REQUESTED DIRECTION,
// or null if none can be attributed to that direction with confidence.
export function parseExplicitPunchTime(explanation: string, kind: 'missed_clock_in' | 'missed_clock_out'): ParsedTime | null {
  const text = explanation.toLowerCase();
  // H:MM (am/pm optional) OR a bare hour that REQUIRES am/pm (so "9" alone isn't a time).
  const re = /(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s*m\.?)?|(\d{1,2})\s*([ap])\.?\s*m\.?/gi;
  const found: Array<ParsedTime & { tag: 'in' | 'out' | null }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const hh12 = m[1] != null ? +m[1] : +m[4];
    const mm = m[2] != null ? +m[2] : 0;
    const mer = (m[3] ?? m[5]) as 'a' | 'p' | undefined;
    if (hh12 < 1 || hh12 > 12 || mm > 59) continue;
    const before = text.slice(Math.max(0, m.index - 22), m.index);
    const tag: 'in' | 'out' | null = /\bout\b/.test(before) ? 'out' : /\bin\b/.test(before) ? 'in' : null;
    found.push({ hh12, mm, meridiem: mer === 'a' ? 'am' : mer === 'p' ? 'pm' : null, raw: m[0].trim(), tag });
  }
  if (!found.length) return null;
  const want: 'in' | 'out' = kind === 'missed_clock_out' ? 'out' : 'in';
  const other: 'in' | 'out' = want === 'out' ? 'in' : 'out';
  const tagged = found.filter((f) => f.tag === want);
  if (tagged.length === 1) return tagged[0];
  if (tagged.length > 1) return null; // more than one candidate for the same direction — ambiguous
  // No time is tagged for the wanted direction.
  const untagged = found.filter((f) => f.tag === null);
  const opposite = found.filter((f) => f.tag === other);
  // Use a single untagged time ONLY if there is no time explicitly tagged as the
  // opposite direction (e.g. "clocked out @5:45" must NOT become a clock-in).
  if (untagged.length === 1 && opposite.length === 0) return untagged[0];
  return null;
}

function to24(hh12: number, meridiem: 'am' | 'pm'): number {
  if (meridiem === 'am') return hh12 === 12 ? 0 : hh12;
  return hh12 === 12 ? 12 : hh12 + 12;
}

// Resolve a parsed time to a concrete {hh,mm} in 24h, disambiguating AM/PM from
// the shift context when it was omitted. Returns null when it cannot be resolved
// safely (→ the caller sends it to manual review).
// Salon operating window (ET, 24h) used to disambiguate a bare time when there's
// no reference punch to compare against. Team salons run mornings to evenings, so
// a time only makes sense inside this window — that resolves most bare times
// safely (e.g. "5:45" → 5:45 PM, "11:06" → 11:06 AM) without a wild guess.
const BUSINESS_START_H = 6;   // 6:00 AM
const BUSINESS_END_H = 22;    // 10:00 PM (exclusive)

function resolveMeridiem(p: ParsedTime, kind: 'missed_clock_in' | 'missed_clock_out', targetDate: string, dayPunches: DayPunch[]): { hh: number; mm: number } | null {
  if (p.meridiem) return { hh: to24(p.hh12, p.meridiem), mm: p.mm };
  // No AM/PM given — first try a reference punch on the day to disambiguate.
  const ref = kind === 'missed_clock_out' ? openClockIn(dayPunches) : orphanClockOut(dayPunches);
  if (ref) {
    const refMs = Date.parse(ref);
    const cands = (['am', 'pm'] as const).map((mer) => {
      const hh = to24(p.hh12, mer); const iso = etWallToIso(targetDate, hh, p.mm); const ms = Date.parse(iso);
      const durH = kind === 'missed_clock_out' ? (ms - refMs) / 3600000 : (refMs - ms) / 3600000;
      return { hh, mm: p.mm, durH, valid: durH > MIN_SHIFT_MIN / 60 && durH <= MAX_SHIFT_H };
    }).filter((c) => c.valid).sort((a, b) => a.durH - b.durH);
    // Prefer the shortest plausible shift; only trust it if it's comfortably plausible.
    if (cands.length && cands[0].durH <= CONFIDENT_SHIFT_H) return { hh: cands[0].hh, mm: cands[0].mm };
  }
  // No reference (or it was inconclusive): fall back to the salon-hours window.
  // Use it only when exactly ONE of AM/PM lands inside business hours.
  const inWindow = (['am', 'pm'] as const)
    .map((mer) => to24(p.hh12, mer))
    .filter((hh) => hh >= BUSINESS_START_H && hh < BUSINESS_END_H);
  if (inWindow.length === 1) return { hh: inWindow[0], mm: p.mm };
  return null;
}

// The clock-in that opens the current (unclosed) shift on the day, if any.
function openClockIn(dayPunches: DayPunch[]): string | null {
  const evs = [...dayPunches].sort((a, b) => a.server_ts.localeCompare(b.server_ts));
  let open: string | null = null;
  for (const e of evs) { if (e.event_type === 'clock_in') open = e.server_ts; else if (e.event_type === 'clock_out') open = null; }
  return open;
}
// A clock-out with no clock-in before it on the day (a shift missing its clock-in).
function orphanClockOut(dayPunches: DayPunch[]): string | null {
  const evs = [...dayPunches].sort((a, b) => a.server_ts.localeCompare(b.server_ts));
  let seenIn = false;
  for (const e of evs) { if (e.event_type === 'clock_in') seenIn = true; else if (e.event_type === 'clock_out') { if (!seenIn) return e.server_ts; seenIn = false; } }
  return null;
}

// ---- validation before write ------------------------------------------------
function validate(ts: string, kind: 'missed_clock_in' | 'missed_clock_out', dayPunches: DayPunch[]): { ok: true } | { ok: false; reason: string } {
  const day = dayPunches.filter((p) => etDateStr(p.server_ts) === etDateStr(ts)).sort((a, b) => a.server_ts.localeCompare(b.server_ts));
  const tsMs = Date.parse(ts);
  if (kind === 'missed_clock_out') {
    const open = openClockIn(day);
    if (!open) return { ok: false, reason: 'no open clock-in on that day to attach a clock-out to' };
    // Duplicate: is the shift already closed (a clock-out already after the open clock-in)?
    const closed = day.some((p) => p.event_type === 'clock_out' && Date.parse(p.server_ts) > Date.parse(open));
    if (closed) return { ok: false, reason: 'a clock-out already exists for that shift (would duplicate)' };
    const durH = (tsMs - Date.parse(open)) / 3600000;
    if (durH <= MIN_SHIFT_MIN / 60) return { ok: false, reason: 'clock-out is not after the clock-in' };
    if (durH > MAX_SHIFT_H) return { ok: false, reason: `resulting shift is ${durH.toFixed(1)}h — implausibly long` };
    return { ok: true };
  }
  // missed_clock_in
  const orphan = orphanClockOut(day);
  const alreadyIn = day.some((p) => p.event_type === 'clock_in');
  if (orphan) {
    const durH = (Date.parse(orphan) - tsMs) / 3600000;
    if (durH <= MIN_SHIFT_MIN / 60) return { ok: false, reason: 'clock-in is not before the clock-out' };
    if (durH > MAX_SHIFT_H) return { ok: false, reason: `resulting shift is ${durH.toFixed(1)}h — implausibly long` };
    return { ok: true };
  }
  if (alreadyIn) return { ok: false, reason: 'a clock-in already exists for that day (would duplicate)' };
  return { ok: true }; // no context to contradict it
}

// A picker whose TIME equals (within 10 min) the submission time, on a DIFFERENT
// day, is almost certainly a "defaulted to now" artifact — do not trust its time.
function looksLikeNowDefault(requestedTs: string, createdAt: string): boolean {
  if (etDateStr(requestedTs) === etDateStr(createdAt)) return false;
  return Math.abs(etMinutesOfDay(requestedTs) - etMinutesOfDay(createdAt)) <= 10;
}

// ---- main entry -------------------------------------------------------------
export function resolveCorrection(input: ResolveInput): ResolveResult {
  const { kind, explanation, requestedTs, createdAt, dayPunches } = input;
  if (kind !== 'missed_clock_in' && kind !== 'missed_clock_out') return { decision: 'unsupported' };
  const reqValid = requestedTs != null && !Number.isNaN(Date.parse(requestedTs));

  const targetDate = reqValid ? etDateStr(requestedTs!) : null;

  // PRIORITY 1 — exact offline punch (its requested_ts IS the real device time).
  if (/^\s*offline clock (in|out) tapped at/i.test(explanation) && reqValid) {
    // Conflict safety: if a human-typed comment states a DIFFERENT time than the
    // device timestamp, don't guess — send it to review.
    const stated = parseExplicitPunchTime(explanation, kind);
    if (stated && targetDate) {
      const r = resolveMeridiem(stated, kind, targetDate, dayPunches);
      if (r && Math.abs((r.hh * 60 + r.mm) - etMinutesOfDay(requestedTs!)) > 5)
        return { decision: 'review', reason: 'the offline device time and the stated time disagree — confirm which is right' };
    }
    const v = validate(requestedTs!, kind, dayPunches);
    return v.ok
      ? { decision: 'apply', ts: requestedTs!, source: 'offline_punch', reason: 'exact offline device timestamp' }
      : { decision: 'review', reason: v.reason };
  }

  // PRIORITY 2 — explicit time stated in the comment.
  const parsed = parseExplicitPunchTime(explanation, kind);
  if (parsed) {
    if (!targetDate) return { decision: 'review', reason: 'you stated a time but no date is attached — confirm the day' };
    const resolved = resolveMeridiem(parsed, kind, targetDate, dayPunches);
    if (!resolved) return { decision: 'review', reason: `AM/PM for "${parsed.raw}" can't be determined safely` };
    const ts = etWallToIso(targetDate, resolved.hh, resolved.mm);
    const v = validate(ts, kind, dayPunches);
    if (!v.ok) return { decision: 'review', reason: v.reason };
    return { decision: 'apply', ts, source: 'employee_explicit_time', reason: `parsed "${parsed.raw}" from the comment` };
  }

  // PRIORITY 3 — the picker value alone (weak). Guard against "now" defaults.
  if (reqValid) {
    if (looksLikeNowDefault(requestedTs!, createdAt)) return { decision: 'review', reason: 'the time matches when it was submitted (picker likely defaulted to “now”) — confirm it' };
    const v = validate(requestedTs!, kind, dayPunches);
    if (!v.ok) return { decision: 'review', reason: v.reason };
    return { decision: 'apply', ts: requestedTs!, source: 'requested_time', reason: 'employee-entered time (no explicit time in the comment)' };
  }

  return { decision: 'review', reason: 'no time was provided' };
}
