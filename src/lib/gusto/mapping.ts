// Pure mapping from a Gusto employee payload to a local upsert record.
// No I/O here so it is fully unit-testable. Identity is keyed on the immutable
// gusto_employee_uuid; a name/email change never creates a duplicate.

export interface GustoJob {
  primary?: boolean;
  title?: string | null;
  rate?: string | null;
  hire_date?: string | null;
  compensations?: Array<{ flsa_status?: string | null }>;
}

export interface GustoEmployee {
  uuid: string;
  company_uuid: string;
  first_name: string;
  middle_initial?: string | null;
  last_name: string;
  preferred_first_name?: string | null;
  email: string;
  phone?: string | null;
  current_employment_status?: string | null;
  terminated?: boolean;
  department?: string | null;
  version?: string | null;
  jobs?: GustoJob[];
  terminations?: Array<{ effective_date?: string | null }>;
}

export type Access =
  | 'pending_review' | 'enabled' | 'suspended' | 'disabled'
  | 'terminated_in_gusto' | 'sync_conflict';

export interface LocalEmployeeUpsert {
  gusto_company_uuid: string;
  gusto_employee_uuid: string;
  first_name: string;
  middle_initial: string | null;
  last_name: string;
  preferred_first_name: string | null;
  email: string;
  phone: string | null;
  employment_status: string | null;
  hire_date: string | null;
  termination_date: string | null;
  primary_job_title: string | null;
  flsa_status: string | null;
  gusto_department_name: string | null;
  gusto_version: string | null;
  /** Salon short-name inferred from the primary job title, or null. */
  inferred_location_short: string | null;
}

/** Known salon tokens that appear inside Gusto job titles, mapped to short names. */
const LOCATION_TOKENS: Array<[RegExp, string]> = [
  [/downtown/i, 'Downtown'],
  [/uptown/i, 'Uptown'],
  [/lakeside/i, 'Lakeside'],
  [/remote/i, 'Remote'],
];

export function inferLocationFromTitle(title?: string | null): string | null {
  if (!title) return null;
  for (const [re, short] of LOCATION_TOKENS) if (re.test(title)) return short;
  return null;
}

function primaryJob(e: GustoEmployee): GustoJob | undefined {
  if (!e.jobs?.length) return undefined;
  return e.jobs.find((j) => j.primary) ?? e.jobs[0];
}

export function mapGustoEmployee(e: GustoEmployee): LocalEmployeeUpsert {
  const job = primaryJob(e);
  const termination_date = e.terminations?.[0]?.effective_date ?? null;
  return {
    gusto_company_uuid: e.company_uuid,
    gusto_employee_uuid: e.uuid,
    first_name: e.first_name,
    middle_initial: emptyToNull(e.middle_initial),
    last_name: e.last_name,
    preferred_first_name: emptyToNull(e.preferred_first_name),
    email: e.email,
    phone: emptyToNull(e.phone),
    employment_status: e.terminated ? 'terminated' : e.current_employment_status ?? null,
    hire_date: job?.hire_date ?? null,
    termination_date,
    primary_job_title: job?.title ?? null,
    flsa_status: job?.compensations?.[0]?.flsa_status ?? null,
    gusto_department_name: e.department ?? null,
    gusto_version: e.version ?? null,
    inferred_location_short: inferLocationFromTitle(job?.title),
  };
}

/**
 * Decide the next timekeeping_access value on sync, preserving admin decisions.
 * - A brand-new employee (no prior row) starts 'pending_review'.
 * - Termination in Gusto forces 'terminated_in_gusto' (disables punching) unless
 *   an admin has already explicitly resolved it (kept 'disabled'/'suspended').
 * - Otherwise the existing local access is preserved (Gusto activity alone does
 *   NOT grant timeclock access — an admin must enable it).
 */
export function nextAccess(existing: Access | null, gustoTerminated: boolean): Access {
  if (gustoTerminated) {
    if (existing === 'disabled' || existing === 'suspended') return existing;
    return 'terminated_in_gusto';
  }
  if (existing === null) return 'pending_review';
  // Re-activated in Gusto but was flagged terminated locally -> needs review.
  if (existing === 'terminated_in_gusto') return 'sync_conflict';
  return existing;
}

function emptyToNull(v?: string | null): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}
