import { describe, it, expect } from 'vitest';
import { mergeExtras, extrasKey, canonCat } from './extras';

describe('extrasKey (dashboard name → Gusto legal name)', () => {
  it('normalizes and applies aliases', () => {
    expect(extrasKey('Casey D')).toBe('casey demo');
    expect(extrasKey('Casey Demo')).toBe('casey demo');
    expect(extrasKey("Val D'Oe")).toBe('val doe');
  });
});

describe('canonCat (category → exact Gusto earning name)', () => {
  it('translates legacy dashboard categories', () => {
    expect(canonCat('six-step bonus')).toBe('Guest Experience Bonus');
    expect(canonCat('education bonus')).toBe('Team Stylist Development');
    expect(canonCat('paid time off')).toBe('Paid Time');
    expect(canonCat('time adjustment')).toBe('Missed Punch');
    expect(canonCat('tip catch-up')).toBe('Paycheck Tips');
  });
  it('accepts Gusto names in any case', () => {
    expect(canonCat('team stylist development')).toBe('Team Stylist Development');
    expect(canonCat('Missed Punch')).toBe('Missed Punch');
    expect(canonCat('above & beyond!')).toBe('Above & Beyond!');
  });
  it('has no home for other/unknown', () => {
    expect(canonCat('other')).toBeNull();
    expect(canonCat('mystery money')).toBeNull();
  });
});

describe('mergeExtras', () => {
  it('carries Boulevard tips and auto items from the run, on exact Gusto earnings', () => {
    const { byKey, skipped } = mergeExtras(
      [
        { first: 'Sam', last: 'Rivers', blvdTips: 135.75, addlItems: [] },
        { first: 'Emery', last: 'Test', blvdTips: 10, addlItems: [{ category: 'Commission', amount: 225.55, auto: true }] },
        { first: 'Gray', last: 'Mock', blvdTips: 0, addlItems: [{ category: 'six-step bonus', amount: 271, auto: true }] },
      ],
      [],
    );
    expect(byKey.get('sam rivers')!.earnings).toEqual({ 'Paycheck Tips': 135.75 });
    expect(byKey.get('emery test')!.earnings).toEqual({ 'Paycheck Tips': 10, Commission: 225.55 });
    expect(byKey.get('gray mock')!.earnings).toEqual({ 'Guest Experience Bonus': 271 });
    expect(skipped).toHaveLength(0);
  });

  it('a manual adjustment REPLACES the auto item of the same (canonical) category', () => {
    const { byKey } = mergeExtras(
      [{ first: 'Gray', last: 'Mock', blvdTips: 0, addlItems: [{ category: 'six-step bonus', amount: 271, auto: true }] }],
      [{ person: 'Gray Mock', category: 'Guest Experience Bonus', amount: 300, kind: 'pay' }],
    );
    expect(byKey.get('gray mock')!.earnings).toEqual({ 'Guest Experience Bonus': 300 });
  });

  it('tip catch-up adjustments add to Paycheck Tips on top of blvdTips', () => {
    const { byKey } = mergeExtras(
      [{ first: 'Blair', last: 'Example', blvdTips: 42, addlItems: [] }],
      [{ person: 'Blair Example', category: 'tip catch-up', amount: 140, kind: 'pay' }],
    );
    expect(byKey.get('blair example')!.earnings['Paycheck Tips']).toBe(182);
  });

  it('PTO dollars and missed-punch pay ride their own Gusto lines', () => {
    const { byKey, skipped } = mergeExtras(
      [],
      [
        { person: 'Finley Fake', category: 'paid time off', amount: 2295, kind: 'pay' },
        { person: 'Indy Example', category: 'Missed Punch', amount: 259, kind: 'pay' },
        { person: 'Casey Demo', category: 'education bonus', amount: 850, kind: 'pay' },
      ],
    );
    expect(byKey.get('finley fake')!.earnings).toEqual({ 'Paid Time': 2295 });
    expect(byKey.get('indy example')!.earnings).toEqual({ 'Missed Punch': 259 });
    expect(byKey.get('casey demo')!.earnings).toEqual({ 'Team Stylist Development': 850 });
    expect(skipped).toHaveLength(0);
  });

  it('matches an adjustment to a run row through an alias', () => {
    const { byKey } = mergeExtras(
      [{ first: 'Casey', last: 'D', blvdTips: 20, addlItems: [] }],
      [{ person: 'Casey Demo', category: 'tip catch-up', amount: 5, kind: 'pay' }],
    );
    expect(byKey.size).toBe(1);
    expect(byKey.get('casey demo')!.earnings['Paycheck Tips']).toBe(25);
  });

  it('two manual rows landing on one earning sum rather than clobber', () => {
    const { byKey } = mergeExtras(
      [],
      [
        { person: 'Alex Sample', category: 'time adjustment', amount: 100, kind: 'pay' },
        { person: 'Alex Sample', category: 'Missed Punch', amount: 50, kind: 'pay' },
      ],
    );
    expect(byKey.get('alex sample')!.earnings).toEqual({ 'Missed Punch': 150 });
  });

  it('hours rows are ignored; homeless categories are skipped and surfaced', () => {
    const { byKey, skipped } = mergeExtras(
      [],
      [
        { person: 'Alex Sample', category: 'time adjustment', amount: 19.425, kind: 'hours' },
        { person: 'Drew Placeholder', category: 'other', amount: 115, kind: 'pay' },
      ],
    );
    expect(byKey.size).toBe(0);
    expect(skipped).toEqual([{ person: 'Drew Placeholder', category: 'other', amount: 115 }]);
  });

  it('rows marked already-paid are kept OFF the file and surfaced (the 10/13 off-cycle lesson)', () => {
    const { byKey, excludedPaid } = mergeExtras(
      [{ first: 'Blair', last: 'Example', blvdTips: 42, addlItems: [] }],
      [
        { person: 'Blair Example', category: 'tip catch-up', amount: 140, kind: 'pay', excluded: true, excluded_reason: 'Paid in off-cycle 2026-10-13' },
        { person: 'Emery Test', category: 'tip catch-up', amount: 103.5, kind: 'pay', excluded: false },
      ],
    );
    // Blair keeps ONLY her live card tips; her paid catch-up never rides again.
    expect(byKey.get('blair example')!.earnings).toEqual({ 'Paycheck Tips': 42 });
    // Emery's unpaid catch-up still rides.
    expect(byKey.get('emery test')!.earnings).toEqual({ 'Paycheck Tips': 103.5 });
    expect(excludedPaid).toEqual([{ person: 'Blair Example', category: 'tip catch-up', amount: 140, reason: 'Paid in off-cycle 2026-10-13' }]);
  });

  it('people with no extras are left out entirely', () => {
    const { byKey } = mergeExtras([{ first: 'Jordan', last: 'Demo', blvdTips: 0, addlItems: [] }], []);
    expect(byKey.size).toBe(0);
  });
});
