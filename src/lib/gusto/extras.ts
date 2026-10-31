// Dollar "extras" for the Gusto CSV, calculated by the Team Payroll Performance
// dashboard (same Supabase project): Boulevard credit-card tips, bonuses,
// commissions, PTO dollars and one-off adjustments entered on the dashboard's
// Payroll runs tab. Merging them into the export means ONE Smart Import file
// carries hours AND dollars — no re-typing extras into Gusto by hand.
//
// Sources (read by netlify/functions/payroll-export.ts, merged here):
//  - public.pp_runs (id = period END date): data.rows[] with blvdTips and
//    rule-computed addlItems (auto: true) from the dashboard's sync.
//  - public.pp_run_adjustments (period_start = period START date): manual rows.
//    A manual row REPLACES an auto item of the same category for that person —
//    identical to how the dashboard itself resolves them.
//
// Categories ARE the Gusto earning-type names (the owner, 2026-10-09): the dashboard
// dropdown mirrors Gusto's list exactly, and each category becomes its own CSV
// column so the dollars land on that precise paycheck line item. Legacy category
// names from older rows are translated via CANON_LEGACY. A category with no Gusto
// home ('other', typos) is reported as skipped so money is never silently dropped.
// KEEP IN LOCKSTEP with the payroll dashboard app:
//   netlify/functions/_categories.cjs and src/components/PayrollRuns.jsx.

/** Every dollar column the CSV can carry — exact Gusto earning-type names. */
export const GUSTO_EARNING_COLUMNS = [
  'Paycheck Tips', 'Commission', 'Bonus', 'Paid Time', 'Missed Punch',
  'Guest Experience Bonus', 'Team Stylist Development', 'Team Demand Builder Bonus',
  'Extra Time', 'Above & Beyond!', 'Blessings', 'Gratitude', 'Leadership',
  'Concierge performance bonus', 'Salary Overage', 'Time Off', 'outside Salon schedule',
  'Severance Pay', 'Cash Tips',
] as const;
export type GustoEarning = (typeof GUSTO_EARNING_COLUMNS)[number];

const CANON_LEGACY: Record<string, GustoEarning> = {
  'six-step bonus': 'Guest Experience Bonus',
  'education bonus': 'Team Stylist Development',
  'training & development': 'Team Stylist Development',
  'time adjustment': 'Missed Punch',
  'paid time off': 'Paid Time',
  'tip catch-up': 'Paycheck Tips',
};
const BY_LOWER = new Map<string, GustoEarning>(GUSTO_EARNING_COLUMNS.map((n) => [n.toLowerCase(), n]));

/** Exact Gusto earning name for a category (legacy or Gusto-spelled), or null. */
export function canonCat(c: string | null | undefined): GustoEarning | null {
  const k = (c ?? '').trim().toLowerCase();
  return CANON_LEGACY[k] ?? BY_LOWER.get(k) ?? null;
}

export interface ExtrasPerson {
  name: string;                       // dashboard display name
  earnings: Partial<Record<GustoEarning, number>>;
}

export interface ExtrasResult {
  byKey: Map<string, ExtrasPerson>;
  /** adjustments that do NOT ride the CSV (no Gusto home — stay manual) */
  skipped: Array<{ person: string; category: string; amount: number }>;
  /** rows marked "already paid" (e.g. in an off-cycle payroll) — kept OFF the CSV
   *  so they can never double-pay, and surfaced so the reviewer sees why.
   *  Born 10/19/26: an off-cycle run paid the tip catch-ups early and the file
   *  re-included them; the owner had to delete the lines by hand. Never again. */
  excludedPaid: Array<{ person: string; category: string; amount: number; reason: string }>;
}

// Same normalization + display-name aliases the dashboard uses, so "Casey
// D" (dashboard) and "Casey Demo" (Gusto legal name, which Team Time Clock
// stores) land on one canonical key.
const ALIASES: Record<string, string> = {
  // Example: nickname used in one system -> legal name used in payroll.
  'casey d': 'casey demo',
};
const norm = (s: string): string => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
export const extrasKey = (name: string): string => { const n = norm(name); return ALIASES[n] || n; };

export interface RunRowLike {
  first?: string; last?: string;
  blvdTips?: number | null;
  addlItems?: Array<{ category?: string; amount?: number; auto?: boolean }> | null;
}
export interface AdjustmentLike {
  person: string; category: string; amount: number | string | null; kind?: string | null;
  excluded?: boolean | null; excluded_reason?: string | null;
}

export function mergeExtras(runRows: RunRowLike[], adjustments: AdjustmentLike[]): ExtrasResult {
  const skipped: ExtrasResult['skipped'] = [];
  const excludedPaid: ExtrasResult['excludedPaid'] = [];
  // per person: canonical earning -> {amount, manual} so a manual row replaces the
  // auto item of the same category instead of stacking on top of it. Boulevard
  // tips are tracked separately and ADD to any Paycheck Tips items (a tip
  // catch-up is on top of the current period's card tips, never instead of them).
  const people = new Map<string, { name: string; tips: number; cats: Map<GustoEarning, { amount: number; manual: boolean }> }>();
  const personOf = (name: string) => {
    const key = extrasKey(name);
    let p = people.get(key);
    if (!p) { p = { name, tips: 0, cats: new Map() }; people.set(key, p); }
    return p;
  };

  for (const r of runRows) {
    const name = `${r.first ?? ''} ${r.last ?? ''}`.trim();
    if (!name) continue;
    const tips = Number(r.blvdTips) || 0;
    const autos = (r.addlItems ?? []).filter((it) => it.auto && it.category && Number(it.amount));
    if (!tips && autos.length === 0) continue;
    const p = personOf(name);
    p.tips += tips;
    for (const it of autos) {
      const earning = canonCat(it.category);
      if (!earning) { skipped.push({ person: name, category: it.category!, amount: Number(it.amount) }); continue; }
      p.cats.set(earning, { amount: Number(it.amount), manual: false });
    }
  }

  for (const a of adjustments) {
    if ((a.kind ?? 'pay') !== 'pay') continue; // hours adjustments never carry dollars
    const amount = Number(a.amount) || 0;
    if (!amount || !a.person || !a.category) continue;
    if (a.excluded) { excludedPaid.push({ person: a.person, category: a.category, amount, reason: a.excluded_reason || 'marked already paid' }); continue; }
    const earning = canonCat(a.category);
    if (!earning) { skipped.push({ person: a.person, category: a.category, amount }); continue; }
    // manual wins over auto; two distinct manual rows landing on one earning
    // (e.g. legacy 'time adjustment' + 'Missed Punch') sum rather than clobber.
    const cats = personOf(a.person).cats;
    const ex = cats.get(earning);
    cats.set(earning, { amount: ex?.manual ? ex.amount + amount : amount, manual: true });
  }

  const byKey = new Map<string, ExtrasPerson>();
  for (const [key, p] of people) {
    const earnings: Partial<Record<GustoEarning, number>> = {};
    const add = (e: GustoEarning, v: number) => { earnings[e] = Math.round(((earnings[e] ?? 0) + v) * 100) / 100; };
    if (p.tips) add('Paycheck Tips', p.tips);
    for (const [earning, v] of p.cats) add(earning, v.amount);
    for (const e of Object.keys(earnings) as GustoEarning[]) if (!earnings[e]) delete earnings[e];
    if (Object.keys(earnings).length) byKey.set(key, { name: p.name, earnings });
  }
  return { byKey, skipped, excludedPaid };
}
