import { describe, it, expect } from 'vitest';
import {
  durationSeconds, secondsToDecimalHours, formatElapsed,
  localDateKey, crossesMidnight, payPeriodFor, shiftPayPeriod, listPayPeriods,
} from './time';

describe('durationSeconds', () => {
  it('computes plain durations', () => {
    expect(durationSeconds(new Date('2026-07-13T09:00:00Z'), new Date('2026-07-13T17:30:00Z')))
      .toBe(8.5 * 3600);
  });

  it('is correct across an overnight shift', () => {
    // 10pm ET to 6am ET next day = 8h
    const start = new Date('2026-07-13T22:00:00-04:00');
    const end = new Date('2026-07-14T06:00:00-04:00');
    expect(durationSeconds(start, end)).toBe(8 * 3600);
  });

  it('is correct across the US spring-forward DST transition', () => {
    // 2026-03-08: clocks jump 2:00 EST -> 3:00 EDT. An 8h absolute shift is 8h.
    const start = new Date('2026-03-08T06:00:00Z'); // 1:00 EST
    const end = new Date('2026-03-08T14:00:00Z');   // 10:00 EDT
    expect(secondsToDecimalHours(durationSeconds(start, end))).toBe(8);
  });
});

describe('secondsToDecimalHours', () => {
  it('converts exactly and avoids float drift', () => {
    expect(secondsToDecimalHours(3600)).toBe(1);
    expect(secondsToDecimalHours(1800)).toBe(0.5);
    expect(secondsToDecimalHours(5400)).toBe(1.5);
    expect(secondsToDecimalHours(60 * 60 * 8 + 60 * 15)).toBe(8.25); // 8h15m
    expect(secondsToDecimalHours(60 * 60 * 7 + 60 * 20)).toBe(7.33); // 7h20m -> 7.33
  });
  it('handles zero', () => expect(secondsToDecimalHours(0)).toBe(0));
});

describe('formatElapsed', () => {
  it('formats H:MM:SS', () => {
    expect(formatElapsed(0)).toBe('0:00:00');
    expect(formatElapsed(3661)).toBe('1:01:01');
    expect(formatElapsed(-5)).toBe('0:00:00');
  });
});

describe('localDateKey / crossesMidnight (America/New_York)', () => {
  it('buckets a late-night punch to the correct ET day', () => {
    // 2026-07-14T03:00:00Z == 2026-07-13 23:00 ET
    expect(localDateKey(new Date('2026-07-14T03:00:00Z'))).toBe('2026-07-13');
  });
  it('detects midnight crossing', () => {
    const start = new Date('2026-07-13T22:00:00-04:00');
    const end = new Date('2026-07-14T06:00:00-04:00');
    expect(crossesMidnight(start, end)).toBe(true);
  });
  it('same-day shift does not cross', () => {
    const start = new Date('2026-07-13T09:00:00-04:00');
    const end = new Date('2026-07-13T17:00:00-04:00');
    expect(crossesMidnight(start, end)).toBe(false);
  });
});

describe('payPeriodFor (biweekly, anchor end 2020-04-26)', () => {
  const at = (d: string) => new Date(`${d}T12:00:00-04:00`);
  it('day on the anchor end belongs to the ending period', () => {
    expect(payPeriodFor(at('2020-04-26'))).toEqual({ start: '2020-04-13', end: '2020-04-26' });
  });
  it('day after anchor starts a new period', () => {
    expect(payPeriodFor(at('2020-04-27'))).toEqual({ start: '2020-04-27', end: '2020-05-10' });
  });
  it('day before anchor sits in the prior period', () => {
    expect(payPeriodFor(at('2020-04-25'))).toEqual({ start: '2020-04-13', end: '2020-04-26' });
  });
  it('shifts by whole periods and lists a Gusto-aligned range', () => {
    const p = payPeriodFor(at('2026-07-13'));
    const prev = shiftPayPeriod(p, -1);
    expect((Date.parse(p.start) - Date.parse(prev.start)) / 86400000).toBe(14);
    const list = listPayPeriods(at('2026-07-13'), 3, 1);
    expect(list).toHaveLength(5);
    expect(list.filter((x) => x.isCurrent)).toHaveLength(1);
    // every listed period is 13 inclusive days and aligned to the 14-day anchor
    for (const pp of list) {
      expect((Date.parse(pp.end) - Date.parse(pp.start)) / 86400000).toBe(13);
      expect(Number.isInteger((Date.parse(pp.end) - Date.parse('2020-04-26')) / 86400000 / 14)).toBe(true);
    }
  });

  it('works for a 2026 date', () => {
    // 2026-07-13 -> some 14-day window aligned to the anchor
    const p = payPeriodFor(at('2026-07-13'));
    // start and end are 13 days apart, end is a valid anchor+14k date
    const dayMs = 86400000;
    const span = (Date.parse(p.end) - Date.parse(p.start)) / dayMs;
    expect(span).toBe(13);
    const k = (Date.parse(p.end) - Date.parse('2020-04-26')) / dayMs / 14;
    expect(Number.isInteger(k)).toBe(true);
  });
});
