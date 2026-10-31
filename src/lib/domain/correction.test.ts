import { describe, it, expect } from 'vitest';
import { resolveCorrection, parseExplicitPunchTime, etWallToIso, type DayPunch } from './correction';

// Helper: an ET wall-clock time on a date -> the ISO the engine would produce.
const et = (date: string, hh: number, mm = 0) => etWallToIso(date, hh, mm);
const clockIn = (date: string, hh: number, mm = 0): DayPunch => ({ event_type: 'clock_in', server_ts: et(date, hh, mm) });
const clockOut = (date: string, hh: number, mm = 0): DayPunch => ({ event_type: 'clock_out', server_ts: et(date, hh, mm) });

const D = '2026-08-27';
const pickerNoise = et(D, 18, 37);          // a picker "defaulted to now" time
const submitted = et('2026-09-02', 18, 41); // when the request was submitted

describe('parseExplicitPunchTime', () => {
  it('picks the clock-out time when both are stated', () => {
    expect(parseExplicitPunchTime('Clock in time 9:14 am Clock out time 11:06', 'missed_clock_out')).toMatchObject({ hh12: 11, mm: 6 });
  });
  it('does NOT use a stated clock-OUT time as the missing clock-IN', () => {
    expect(parseExplicitPunchTime('I forgot to clock in and I clocked out @5:45', 'missed_clock_in')).toBeNull();
  });
  it('returns null when no time is present', () => {
    expect(parseExplicitPunchTime('forgot to clock out', 'missed_clock_out')).toBeNull();
  });
});

describe('resolveCorrection', () => {
  // A + B: explicit clock-out time is used, AM inferred from the same-shift clock-in.
  it('A: "Clock out time 11:06" with a 9:14 AM clock-in => 11:06 AM', () => {
    const r = resolveCorrection({ kind: 'missed_clock_out', explanation: 'Clock out time 11:06', requestedTs: pickerNoise, createdAt: submitted, dayPunches: [clockIn(D, 9, 14)] });
    expect(r.decision).toBe('apply');
    if (r.decision === 'apply') { expect(r.ts).toBe(et(D, 11, 6)); expect(r.source).toBe('employee_explicit_time'); }
  });
  it('B: "Clock in time 9:14 am Clock out time 11:06" => 11:06 AM (beats the 6:37 PM picker value)', () => {
    const r = resolveCorrection({ kind: 'missed_clock_out', explanation: 'Clock in time 9:14 am \nClock out time 11:06', requestedTs: pickerNoise, createdAt: submitted, dayPunches: [clockIn(D, 9, 14), clockOut(D, 9, 14), clockIn(D, 10, 50)] });
    expect(r.decision).toBe('apply');
    if (r.decision === 'apply') { expect(r.ts).toBe(et(D, 11, 6)); expect(r.source).toBe('employee_explicit_time'); }
  });
  // C: stated clock-out time must NOT become the missing clock-in; with no reliable in-time => review.
  it('C: "clocked out @5:45" for a missed CLOCK-IN => review, never 5:45 as the clock-in', () => {
    const r = resolveCorrection({ kind: 'missed_clock_in', explanation: 'I forgot to clock in and I clocked out @5:45', requestedTs: null, createdAt: submitted, dayPunches: [clockOut('2026-09-02', 17, 45)] });
    expect(r.decision).toBe('review');
  });
  // D: exact offline device timestamp is used.
  it('D: offline clock-in tapped at 10:06 => uses that exact time', () => {
    const req = et('2026-09-02', 10, 6);
    const r = resolveCorrection({ kind: 'missed_clock_in', explanation: 'Offline clock in tapped at 9/2/2026, 10:06:18 AM (ET) couldn\'t be applied automatically when it synced — please confirm this punch.', requestedTs: req, createdAt: et('2026-09-02', 18, 50), dayPunches: [clockOut('2026-09-02', 17, 0)] });
    expect(r.decision).toBe('apply');
    if (r.decision === 'apply') { expect(r.ts).toBe(req); expect(r.source).toBe('offline_punch'); }
  });
  // E: no time and no reliable source => review, never invent.
  it('E: "forgot to clock out" with no time => review', () => {
    const r = resolveCorrection({ kind: 'missed_clock_out', explanation: 'forgot to clock out', requestedTs: null, createdAt: submitted, dayPunches: [clockIn(D, 9, 0)] });
    expect(r.decision).toBe('review');
  });
  // F: offline time conflicts with a stated time => review.
  it('F: offline 10:06 but comment says 11:06 => review (conflict)', () => {
    const r = resolveCorrection({ kind: 'missed_clock_in', explanation: 'Offline clock in tapped at 9/2/2026 but I actually came in at 11:06 am', requestedTs: et('2026-09-02', 10, 6), createdAt: et('2026-09-02', 18, 50), dayPunches: [clockOut('2026-09-02', 17, 0)] });
    expect(r.decision).toBe('review');
  });

  // The exact production bug: a picker "defaulted to now" value with NO explicit
  // comment time must NOT be applied blindly.
  it('now-default picker value with no explicit time => review', () => {
    const r = resolveCorrection({ kind: 'missed_clock_out', explanation: 'please fix', requestedTs: pickerNoise, createdAt: submitted, dayPunches: [clockIn(D, 10, 50)] });
    expect(r.decision).toBe('review');
  });
  // Example case: a clock-out already exists for the shift => duplicate => review.
  it('duplicate clock-out (shift already closed) => review', () => {
    const r = resolveCorrection({ kind: 'missed_clock_out', explanation: 'Missed punch', requestedTs: et('2026-09-03', 18, 0), createdAt: et('2026-09-03', 18, 44), dayPunches: [clockIn('2026-09-03', 8, 30), clockOut('2026-09-03', 18, 44)] });
    expect(r.decision).toBe('review');
  });
  // A deliberate (non-"now") picker time with no comment time is allowed (priority 3).
  it('deliberate picker time (no explicit comment) with a valid shift => apply requested_time', () => {
    const r = resolveCorrection({ kind: 'missed_clock_out', explanation: 'Fix time, forgot to clock out', requestedTs: et('2026-09-01', 18, 28), createdAt: et('2026-09-02', 9, 49), dayPunches: [clockIn('2026-09-01', 11, 46)] });
    expect(r.decision).toBe('apply');
    if (r.decision === 'apply') expect(r.source).toBe('requested_time');
  });
});
