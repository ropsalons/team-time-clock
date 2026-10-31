import { describe, it, expect } from 'vitest';
import { decidePunch, punchIdempotencyKey, deriveClockState, type ClockState, type StoredEvent } from './punch';

const out: ClockState = { isClockedIn: false, locationId: null, departmentId: null };
const inAt = (loc: string, dept: string): ClockState => ({ isClockedIn: true, locationId: loc, departmentId: dept });
const opts = { requireLocation: true, requireDepartment: true };

describe('decidePunch: clock_in', () => {
  it('opens a segment when out and fully specified', () => {
    const d = decidePunch(out, { action: 'clock_in', locationId: 'L1', departmentId: 'D1', ...opts });
    expect(d).toMatchObject({ ok: true, eventType: 'clock_in', opensSegment: true, closesSegment: false });
  });
  it('rejects a second clock-in', () => {
    const d = decidePunch(inAt('L1', 'D1'), { action: 'clock_in', locationId: 'L1', departmentId: 'D1', ...opts });
    expect(d).toMatchObject({ ok: false, code: 'already_clocked_in' });
  });
  it('requires location/department when configured', () => {
    expect(decidePunch(out, { action: 'clock_in', departmentId: 'D1', ...opts }))
      .toMatchObject({ ok: false, code: 'location_required' });
    expect(decidePunch(out, { action: 'clock_in', locationId: 'L1', ...opts }))
      .toMatchObject({ ok: false, code: 'department_required' });
  });
  it('allows missing location/department when not required', () => {
    const d = decidePunch(out, { action: 'clock_in', requireLocation: false, requireDepartment: false });
    expect(d.ok).toBe(true);
  });
});

describe('decidePunch: clock_out', () => {
  it('closes a segment when in', () => {
    const d = decidePunch(inAt('L1', 'D1'), { action: 'clock_out', ...opts });
    expect(d).toMatchObject({ ok: true, eventType: 'clock_out', closesSegment: true, opensSegment: false });
  });
  it('rejects clock-out when already out', () => {
    expect(decidePunch(out, { action: 'clock_out', ...opts })).toMatchObject({ ok: false, code: 'not_clocked_in' });
  });
});

describe('decidePunch: transfers close-and-open atomically', () => {
  it('location transfer', () => {
    const d = decidePunch(inAt('L1', 'D1'), { action: 'location_transfer', locationId: 'L2', ...opts });
    expect(d).toMatchObject({ ok: true, closesSegment: true, opensSegment: true });
  });
  it('rejects a no-op location transfer', () => {
    expect(decidePunch(inAt('L1', 'D1'), { action: 'location_transfer', locationId: 'L1', ...opts }))
      .toMatchObject({ ok: false, code: 'no_change' });
  });
  it('department transfer requires being clocked in', () => {
    expect(decidePunch(out, { action: 'department_transfer', departmentId: 'D2', ...opts }))
      .toMatchObject({ ok: false, code: 'not_clocked_in' });
  });
});

describe('deriveClockState (replays the event log)', () => {
  const ev = (event_type: string, ts: string, location_id: string | null = null, department_id: string | null = null): StoredEvent =>
    ({ event_type, server_ts: ts, location_id, department_id });

  it('is clocked out with no events', () => {
    expect(deriveClockState([])).toEqual({ isClockedIn: false, locationId: null, departmentId: null, startedAt: null });
  });
  it('is clocked in after a clock_in', () => {
    const s = deriveClockState([ev('clock_in', '2026-07-13T13:00:00Z', 'L1', 'D1')]);
    expect(s).toEqual({ isClockedIn: true, locationId: 'L1', departmentId: 'D1', startedAt: '2026-07-13T13:00:00Z' });
  });
  it('clock_out closes the shift', () => {
    const s = deriveClockState([
      ev('clock_in', '2026-07-13T13:00:00Z', 'L1', 'D1'),
      ev('clock_out', '2026-07-13T21:00:00Z'),
    ]);
    expect(s.isClockedIn).toBe(false);
  });
  it('transfers update the open location/department', () => {
    const s = deriveClockState([
      ev('clock_in', '2026-07-13T13:00:00Z', 'L1', 'D1'),
      ev('location_transfer', '2026-07-13T15:00:00Z', 'L2'),
      ev('department_transfer', '2026-07-13T16:00:00Z', null, 'D2'),
    ]);
    expect(s).toMatchObject({ isClockedIn: true, locationId: 'L2', departmentId: 'D2' });
    expect(s.startedAt).toBe('2026-07-13T13:00:00Z'); // original clock-in time
  });
  it('sorts out-of-order events defensively', () => {
    const s = deriveClockState([
      ev('clock_out', '2026-07-13T21:00:00Z'),
      ev('clock_in', '2026-07-13T13:00:00Z', 'L1', 'D1'),
    ]);
    expect(s.isClockedIn).toBe(false); // clock_out is last chronologically
  });
});

describe('punchIdempotencyKey', () => {
  it('is stable for the same intended action and changes with the action', () => {
    expect(punchIdempotencyKey('e1', 'clock_in', 'n1')).toBe('e1:clock_in:n1');
    expect(punchIdempotencyKey('e1', 'clock_in', 'n1')).toBe(punchIdempotencyKey('e1', 'clock_in', 'n1'));
    expect(punchIdempotencyKey('e1', 'clock_out', 'n1')).not.toBe(punchIdempotencyKey('e1', 'clock_in', 'n1'));
  });
});
