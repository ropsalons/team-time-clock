import { getStore } from '@netlify/blobs';
import { adminClient } from './supabase';

// Full data snapshot of the app -> a single JSON blob in Netlify Blobs.
// Excludes gusto_connections (holds encrypted tokens). Big tables are paginated.

const TABLES = [
  'locations', 'departments', 'pay_periods', 'app_settings',
  'employees', 'employee_location_assignments', 'employee_department_assignments', 'user_roles',
  'punch_events', 'shift_segments', 'correction_requests', 'timecard_approvals',
  'payroll_export_runs', 'payroll_export_items',
  'messages', 'message_recipients', 'message_acknowledgments',
  'audit_logs', 'device_sessions', 'gusto_sync_runs', 'gusto_webhook_events', 'security_events',
];
const KEEP = 12; // retain the newest 12 snapshots
const STORE = 'otc-backups';

type Admin = ReturnType<typeof adminClient>;

async function fetchAll(admin: Admin, table: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from(table).select('*').range(from, from + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

export interface BackupResult { key: string; bytes: number; counts: Record<string, number>; kept: number }

export async function exportSnapshot(admin: Admin = adminClient()): Promise<BackupResult> {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const t of TABLES) { const rows = await fetchAll(admin, t); tables[t] = rows; counts[t] = rows.length; }

  const created_at = new Date().toISOString();
  const json = JSON.stringify({ app: 'team-time-clock', schema: 'otc', created_at, counts, tables });
  const key = `otc-backup-${created_at.slice(0, 10)}.json`;

  const store = getStore(STORE);
  await store.set(key, json, { metadata: { created_at, bytes: json.length, counts } });

  // Prune to the newest KEEP snapshots (keys sort chronologically).
  const { blobs } = await store.list();
  const keys = blobs.map((b) => b.key).filter((k) => k.startsWith('otc-backup-')).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) await store.delete(old);

  return { key, bytes: json.length, counts, kept: Math.min(keys.length, KEEP) };
}

export function backupStore() { return getStore(STORE); }
