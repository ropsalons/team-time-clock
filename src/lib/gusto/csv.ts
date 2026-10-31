// Payroll CSV / Gusto Smart-Import export with formula-injection protection.
// Gusto Smart Import matches HOURS TO JOBS BY JOB TITLE. So for anyone who works
// more than one department/location we emit ONE ROW PER JOB, and the "Job Title"
// column is built to match the Gusto job (e.g. "Stylist Uptown"). Hours are
// decimal; overtime is attributed to the job where the >40h hours occurred.
// The file can also carry optional DOLLAR extras
// (Paycheck Tips / Bonus / Commission — see extras.ts), so one import covers
// hours and extras; rates and the final pay run still live in Gusto.

import { secondsToDecimalHours } from '../time';
import { GUSTO_EARNING_COLUMNS, type GustoEarning } from './extras';

export interface ExportRow {
  gusto_employee_uuid: string;
  employee_name: string;   // exactly as in Gusto
  first_name?: string;     // preview only (for First/Last sortable columns) — not in the CSV
  last_name?: string;      // preview only
  email: string;
  pay_period_start: string;
  pay_period_end: string;
  job_title: string;       // must match a Gusto job title for Smart Import
  location: string;
  department: string;
  regular_seconds: number;
  overtime_seconds: number;
  double_ot_seconds: number;
  // Per-workweek split (Gusto pays OT by the week it was earned; a bi-weekly
  // lump makes Gusto split evenly and mis-derive OT). Week 1 = first 7 days of
  // the pay period, Week 2 = second 7 days. Optional; default 0.
  w1_regular_seconds?: number;
  w1_overtime_seconds?: number;
  w2_regular_seconds?: number;
  w2_overtime_seconds?: number;
  exceptions?: string;
  // Optional dollar extras (see extras.ts), keyed by
  // the EXACT Gusto earning-type name (tips, bonuses, commission, PTO dollars,
  // missed-punch pay, …) — attached to each person's PRIMARY job row only, so
  // Gusto never gets the same dollars twice. One CSV column per earning; blank
  // when zero. Preview-only flats for the admin table live in paycheck_tips /
  // extras_other.
  extras?: Partial<Record<GustoEarning, number>> | null;
  paycheck_tips?: number | null;   // preview only — not written separately to the CSV
  extras_other?: number | null;    // preview only — sum of non-tip extras
  // Costing (on-screen preview only — deliberately NOT written to the Gusto CSV,
  // which stays hours-only so Smart Import matches on job title and lets Gusto
  // compute pay from its own rates). `rate` is the per-role hourly rate from the
  // employee's Gusto job; `amount` estimates gross = reg×rate + OT×rate×1.5.
  rate?: number | null;
  amount?: number | null;
  // 'gusto' = job_title is the exact Gusto job name (safe match); 'constructed'
  // = built from department+location as a fallback (no matching Gusto job found).
  title_source?: 'gusto' | 'constructed';
}

const HEADERS = [
  'Gusto Employee UUID', 'Employee Name', 'Email',
  'Pay Period Start', 'Pay Period End',
  'Job Title', 'Location', 'Department',
  'Regular Hours', 'Overtime Hours', 'Double OT Hours',
  'Week 1 Regular Hours', 'Week 1 Overtime Hours', 'Week 2 Regular Hours', 'Week 2 Overtime Hours',
  // One dollar column per Gusto earning type — identical names, so the Smart
  // Import mapping is 1:1 and remembered after the first run. The set is FIXED
  // (not only the nonzero ones) so Gusto's saved mapping never shifts.
  ...GUSTO_EARNING_COLUMNS,
  'Exceptions',
] as const;

// A dollar cell: exact cents when present, blank when zero/absent (a blank maps
// to "no earning" in Gusto; a 0.00 would still import, blank is just cleaner).
const usd = (v: number | null | undefined): string => (v ? v.toFixed(2) : '');

/** Neutralise CSV formula injection: a cell whose text begins with = + - @ (or
 *  tab/CR) is prefixed with a single quote so spreadsheets treat it as text. */
export function sanitizeCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build the Gusto job title from department + location (matches Team's Gusto
 *  naming like "Stylist Uptown"). Falls back gracefully when one is missing. */
export function jobTitle(department: string, location: string): string {
  return [department, location].filter(Boolean).join(' ').trim();
}

// Daily hours feed (history + live) for other Team dashboards / print / export.
export interface HoursRow {
  date: string;
  employee_name: string;
  email: string | null;
  gusto_employee_uuid: string | null;
  source: string;
  total_hours: number;
  regular_hours: number;
  overtime_hours: number;
}
const HOURS_HEADERS = ['Date', 'Employee', 'Email', 'Gusto Employee UUID', 'Source', 'Total Hours', 'Regular Hours', 'Overtime Hours'] as const;

export function buildHoursCsv(rows: HoursRow[]): string {
  const lines: string[] = [HOURS_HEADERS.map(sanitizeCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.date, r.employee_name, r.email ?? '', r.gusto_employee_uuid ?? '', r.source,
      r.total_hours, r.regular_hours, r.overtime_hours,
    ].map(sanitizeCell).join(','));
  }
  return lines.join('\r\n');
}

export function buildPayrollCsv(rows: ExportRow[]): string {
  const lines: string[] = [HEADERS.map(sanitizeCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.gusto_employee_uuid,
      r.employee_name,
      r.email,
      r.pay_period_start,
      r.pay_period_end,
      r.job_title,
      r.location,
      r.department,
      secondsToDecimalHours(r.regular_seconds),
      secondsToDecimalHours(r.overtime_seconds),
      secondsToDecimalHours(r.double_ot_seconds),
      secondsToDecimalHours(r.w1_regular_seconds ?? 0),
      secondsToDecimalHours(r.w1_overtime_seconds ?? 0),
      secondsToDecimalHours(r.w2_regular_seconds ?? 0),
      secondsToDecimalHours(r.w2_overtime_seconds ?? 0),
      ...GUSTO_EARNING_COLUMNS.map((name) => usd(r.extras?.[name])),
      r.exceptions ?? '',
    ].map(sanitizeCell).join(','));
  }
  return lines.join('\r\n');
}
