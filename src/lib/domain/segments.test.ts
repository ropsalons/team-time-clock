import { describe, it, expect } from 'vitest';
import { deriveSegments, computePayrollTotals, computePayrollByJob, weekStartKey } from './segments';
import type { StoredEvent } from './punch';

const ev = (event_type: string, ts: string, location_id: string | null = null, department_id: string | null = null): StoredEvent =>
  ({ event_type, server_ts: ts, location_id, department_id });

describe('overnight span (never a real Team shift)', () => {
  // Clock in 9/2 9:20 AM ET, clock out 9/3 11:40 AM ET -> different ET days.
  const overnight = [ev('clock_in', '2026-09-02T13:20:00Z'), ev('clock_out', '2026-09-03T15:40:00Z')];
  it('flags a segment that crosses ET midnight', () => {
    const segs = deriveSegments(overnight);
    expect(segs).toHaveLength(1);
    expect(segs[0].crossesMidnight).toBe(true);
  });
  it('excludes an overnight span from payroll totals (does NOT count ~26h)', () => {
    const t = computePayrollTotals(deriveSegments(overnight));
    expect(t.regularSeconds).toBe(0);
    expect(t.overtimeSeconds).toBe(0);
    expect(t.hasOvernightSpan).toBe(true);
  });
  it('excludes an overnight span from the per-job (Gusto export) totals', () => {
    expect(computePayrollByJob(deriveSegments(overnight))).toHaveLength(0);
  });
  it('a normal same-day shift is NOT flagged and still counts', () => {
    const segs = deriveSegments([ev('clock_in', '2026-09-02T13:20:00Z'), ev('clock_out', '2026-09-02T22:00:00Z')]);
    expect(segs[0].crossesMidnight).toBe(false);
    expect(computePayrollTotals(segs).regularSeconds).toBe(segs[0].durationSeconds);
  });
});

describe('deriveSegments', () => {
  it('builds one closed segment for a simple shift', () => {
    const segs = deriveSegments([
      ev('clock_in', '2026-07-13T13:00:00Z', 'L1', 'D1'),
      ev('clock_out', '2026-07-13T21:00:00Z'),
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0].durationSeconds).toBe(8 * 3600);
    expect(segs[0].locationId).toBe('L1');
  });

  it('splits into two segments across a location transfer, preserving allocation', () => {
    const segs = deriveSegments([
      ev('clock_in', '2026-07-13T13:00:00Z', 'L1', 'D1'),
      ev('location_transfer', '2026-07-13T17:00:00Z', 'L2'),
      ev('clock_out', '2026-07-13T21:00:00Z'),
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ locationId: 'L1', departmentId: 'D1', durationSeconds: 4 * 3600 });
    expect(segs[1]).toMatchObject({ locationId: 'L2', departmentId: 'D1', durationSeconds: 4 * 3600 });
  });

  it('keeps an open segment with null duration', () => {
    const segs = deriveSegments([ev('clock_in', '2026-07-13T13:00:00Z', 'L1', 'D1')]);
    expect(segs).toHaveLength(1);
    expect(segs[0].endedAt).toBeNull();
    expect(segs[0].durationSeconds).toBeNull();
  });
});

describe('weekStartKey', () => {
  it('anchors to the Sunday of the workweek (ET)', () => {
    // 2026-07-13 is a Monday -> week starts Sunday 2026-07-12
    expect(weekStartKey(new Date('2026-07-13T16:00:00Z'))).toBe('2026-07-12');
    expect(weekStartKey(new Date('2026-07-12T16:00:00Z'))).toBe('2026-07-12');
    expect(weekStartKey(new Date('2026-07-18T16:00:00Z'))).toBe('2026-07-12'); // Saturday
  });
});

describe('computePayrollTotals (weekly 40h OT)', () => {
  const seg = (startedAt: string, endedAt: string, loc = 'L1', dep = 'D1') => ({
    locationId: loc, departmentId: dep, startedAt, endedAt,
    durationSeconds: (Date.parse(endedAt) - Date.parse(startedAt)) / 1000,
  });

  it('all regular under 40h', () => {
    const t = computePayrollTotals([seg('2026-07-13T13:00:00Z', '2026-07-13T21:00:00Z')]); // 8h Monday
    expect(t.regularSeconds).toBe(8 * 3600);
    expect(t.overtimeSeconds).toBe(0);
  });

  it('splits regular/OT past 40h in one workweek', () => {
    // five 9h days Mon–Fri same week = 45h -> 40 reg + 5 OT
    const days = ['13', '14', '15', '16', '17'].map((d) =>
      seg(`2026-07-${d}T13:00:00Z`, `2026-07-${d}T22:00:00Z`));
    const t = computePayrollTotals(days);
    expect(t.regularSeconds).toBe(40 * 3600);
    expect(t.overtimeSeconds).toBe(5 * 3600);
  });

  it('OT is per-week, not pooled across the biweekly period', () => {
    // 45h week 1 + 30h week 2: OT only from week 1 (5h)
    const wk1 = ['13', '14', '15', '16', '17'].map((d) => seg(`2026-07-${d}T13:00:00Z`, `2026-07-${d}T22:00:00Z`));
    const wk2 = ['20', '21', '22'].map((d) => seg(`2026-07-${d}T13:00:00Z`, `2026-07-${d}T23:00:00Z`)); // 3x10h=30h
    const t = computePayrollTotals([...wk1, ...wk2]);
    expect(t.overtimeSeconds).toBe(5 * 3600);
    expect(t.regularSeconds).toBe((40 + 30) * 3600);
  });

  it('flags open segments and excludes them', () => {
    const t = computePayrollTotals([{ locationId: 'L1', departmentId: 'D1', startedAt: '2026-07-13T13:00:00Z', endedAt: null, durationSeconds: null }]);
    expect(t.hasOpenSegment).toBe(true);
    expect(t.regularSeconds).toBe(0);
  });
});

describe('computePayrollByJob (per-department OT attribution)', () => {
  const seg = (startedAt: string, endedAt: string, loc: string, dep: string) => ({
    locationId: loc, departmentId: dep, startedAt, endedAt,
    durationSeconds: (Date.parse(endedAt) - Date.parse(startedAt)) / 1000,
  });
  const h = (n: number) => n * 3600;

  it('one job, 45h week -> 40 reg + 5 OT on that job', () => {
    const days = ['13', '14', '15', '16', '17'].map((d) => seg(`2026-07-${d}T13:00:00Z`, `2026-07-${d}T22:00:00Z`, 'Uptown', 'Stylist'));
    const b = computePayrollByJob(days);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ locationId: 'Uptown', departmentId: 'Stylist', regularSeconds: h(40), overtimeSeconds: h(5) });
  });

  it('two departments in one week: OT lands on the later job', () => {
    // 30h Stylist (Mon-Wed 10h) then 15h Concierge (Thu-Fri) = 45h.
    // First 40h regular: Stylist 30 + Concierge 10; last 5h -> Concierge OT.
    const stylist = ['13', '14', '15'].map((d) => seg(`2026-07-${d}T13:00:00Z`, `2026-07-${d}T23:00:00Z`, 'Uptown', 'Stylist')); // 3x10=30h
    const concierge = ['16', '17'].map((d) => seg(`2026-07-${d}T13:00:00Z`, `2026-07-${d}T20:30:00Z`, 'Downtown', 'Concierge')); // 2x7.5=15h
    const b = computePayrollByJob([...stylist, ...concierge]);
    const styl = b.find((x) => x.departmentId === 'Stylist')!;
    const conc = b.find((x) => x.departmentId === 'Concierge')!;
    expect(styl).toMatchObject({ regularSeconds: h(30), overtimeSeconds: 0 });
    expect(conc).toMatchObject({ regularSeconds: h(10), overtimeSeconds: h(5) });
  });
});
