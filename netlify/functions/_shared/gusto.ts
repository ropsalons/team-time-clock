import { mapGustoEmployee, nextAccess, type GustoEmployee, type Access } from '../../../src/lib/gusto/mapping';

// Self-contained Gusto → timeclock reconcile.
//
// Auth: the app holds its own Gusto OAuth app credentials (GUSTO_CLIENT_ID /
// GUSTO_CLIENT_SECRET in Netlify env) plus a rotating refresh token stored in
// app_settings ('gusto_refresh_token'). Every run trades the refresh token for
// a short-lived access token; Gusto rotates the refresh token on each use, so
// we persist the new one immediately. This is why the token lives in the DB and
// not in an (immutable) env var.
//
// Nothing here throws on a *missing* config — a not-yet-configured install just
// reports { configured: false } so the nightly schedule no-ops quietly.

type Admin = ReturnType<typeof import('./supabase').adminClient>;

const API_BASE = process.env.GUSTO_API_BASE ?? 'https://api.gusto.com';
const API_VERSION = process.env.GUSTO_API_VERSION ?? '2024-04-01';

export interface SyncSummary {
  configured: boolean;
  scanned: number;
  newHires: string[];
  terminated: string[];
  reactivatedConflicts: string[];
  updated: number;
  error?: string;
}

export function gustoConfigured(): boolean {
  return Boolean(process.env.GUSTO_CLIENT_ID && process.env.GUSTO_CLIENT_SECRET);
}

/** Trade the stored (rotating) refresh token for a fresh access token. */
async function getAccessToken(admin: Admin): Promise<string> {
  const { data: row } = await admin.from('app_settings').select('value').eq('key', 'gusto_refresh_token').maybeSingle();
  const refresh = typeof row?.value === 'string' ? row.value : (row?.value as { refresh_token?: string } | null)?.refresh_token;
  if (!refresh) throw new Error('No Gusto refresh token stored yet — complete the one-time OAuth authorization first.');

  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: process.env.GUSTO_CLIENT_ID,
      client_secret: process.env.GUSTO_CLIENT_SECRET,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gusto token refresh failed (${res.status}): ${data?.error_description ?? data?.error ?? 'unknown'}`);

  // Persist the rotated refresh token right away, or the next run will fail.
  if (data.refresh_token) {
    await admin.from('app_settings').upsert(
      { key: 'gusto_refresh_token', value: data.refresh_token, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  }
  if (!data.access_token) throw new Error('Gusto token refresh returned no access_token.');
  return data.access_token as string;
}

async function gustoGet(token: string, path: string): Promise<{ body: any; totalPages: number }> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}`, 'X-Gusto-API-Version': API_VERSION, accept: 'application/json' },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gusto GET ${path} failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const totalPages = Number(res.headers.get('x-total-pages') ?? '1') || 1;
  return { body: await res.json(), totalPages };
}

async function fetchAllEmployees(token: string, companyUuid: string): Promise<GustoEmployee[]> {
  const all: GustoEmployee[] = [];
  let page = 1;
  // No `terminated` filter → Gusto returns everyone (active + terminated); we
  // read each record's own `terminated` flag. Paginate until the last page.
  for (;;) {
    const { body, totalPages } = await gustoGet(token, `/v1/companies/${companyUuid}/employees?per=100&page=${page}`);
    const list: GustoEmployee[] = Array.isArray(body) ? body : body?.employees ?? [];
    all.push(...list);
    if (page >= totalPages || list.length === 0) break;
    page += 1;
    if (page > 50) break; // hard safety stop
  }
  return all;
}

/**
 * Pull the full Gusto roster and reconcile it into otc.employees:
 *  - new people appear as 'pending_review' (never auto-enabled)
 *  - Gusto terminations flip access to 'terminated_in_gusto' (unless an admin
 *    already parked them at disabled/suspended)
 *  - profile fields (name, email, title, dept) are refreshed from Gusto, the
 *    system of record. Admin-only fields (home location/department, roles) are
 *    left untouched.
 */
export async function runGustoSync(admin: Admin): Promise<SyncSummary> {
  const summary: SyncSummary = { configured: gustoConfigured(), scanned: 0, newHires: [], terminated: [], reactivatedConflicts: [], updated: 0 };
  if (!summary.configured) { summary.error = 'Gusto credentials not configured.'; return summary; }

  try {
    const { data: co } = await admin.from('employees').select('gusto_company_uuid').not('gusto_company_uuid', 'is', null).limit(1).maybeSingle();
    const companyUuid = co?.gusto_company_uuid as string | undefined;
    if (!companyUuid) throw new Error('No Gusto company UUID found on any employee row.');

    const token = await getAccessToken(admin);
    const gustoEmployees = await fetchAllEmployees(token, companyUuid);
    summary.scanned = gustoEmployees.length;

    // Existing local rows keyed by gusto uuid.
    const { data: existingRows } = await admin.from('employees').select('id, gusto_employee_uuid, timekeeping_access, first_name, last_name');
    const byUuid = new Map<string, { id: string; timekeeping_access: Access; first_name: string; last_name: string }>();
    for (const r of existingRows ?? []) if (r.gusto_employee_uuid) byUuid.set(r.gusto_employee_uuid, r as any);

    for (const g of gustoEmployees) {
      if (!g?.uuid) continue;
      const map = mapGustoEmployee(g);
      const existing = byUuid.get(g.uuid);
      const access = nextAccess(existing?.timekeeping_access ?? null, Boolean(g.terminated));
      const name = `${g.first_name} ${g.last_name}`.trim();

      // Columns sourced from Gusto (system of record). We deliberately do NOT
      // touch home_location_id / home_department_id / roles (admin-owned).
      const patch: Record<string, unknown> = {
        gusto_company_uuid: g.company_uuid,
        gusto_employee_uuid: g.uuid,
        first_name: map.first_name,
        middle_initial: map.middle_initial,
        last_name: map.last_name,
        preferred_first_name: map.preferred_first_name,
        email: map.email,
        phone: map.phone,
        employment_status: map.employment_status,
        hire_date: map.hire_date,
        termination_date: map.termination_date,
        primary_job_title: map.primary_job_title,
        flsa_status: map.flsa_status,
        gusto_department_name: map.gusto_department_name,
        gusto_version: map.gusto_version,
        timekeeping_access: access,
        is_manual: false,
      };

      if (!existing) {
        const { error: e } = await admin.from('employees').insert(patch);
        if (!e) summary.newHires.push(name);
      } else {
        const { error: e } = await admin.from('employees').update(patch).eq('id', existing.id);
        if (!e) {
          summary.updated += 1;
          if (access === 'terminated_in_gusto' && existing.timekeeping_access !== 'terminated_in_gusto') summary.terminated.push(name);
          if (access === 'sync_conflict' && existing.timekeeping_access !== 'sync_conflict') summary.reactivatedConflicts.push(name);
        }
      }
    }

    await admin.from('app_settings').upsert(
      { key: 'gusto_last_sync', value: { at: new Date().toISOString(), scanned: summary.scanned, newHires: summary.newHires, terminated: summary.terminated }, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    await admin.from('audit_logs').insert({
      actor_label: 'system:gusto-sync', action: 'gusto_sync', entity: 'employees', entity_id: null,
      after_value: { scanned: summary.scanned, newHires: summary.newHires, terminated: summary.terminated, reactivated: summary.reactivatedConflicts, updated: summary.updated },
    });
  } catch (e) {
    summary.error = e instanceof Error ? e.message : 'Unknown sync error';
  }
  return summary;
}
