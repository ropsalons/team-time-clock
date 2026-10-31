import { supabase, accessToken } from './supabase';
import type { PunchAction } from './domain/punch';

export interface StatusResponse {
  isClockedIn: boolean;
  locationId: string | null;
  departmentId: string | null;
  startedAt: string | null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = await accessToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message ?? `Request failed (${res.status})`;
    throw Object.assign(new Error(message), { code: data?.error?.code, status: res.status });
  }
  return data as T;
}

export interface PunchArgs {
  action: PunchAction;
  locationId?: string | null;
  departmentId?: string | null;
  note?: string | null;
  clientNonce: string;
  employeeTs?: string | null; // moment the employee tapped (recorded; authoritative for offline)
  offline?: boolean;          // true => this was queued offline; server timestamps it at employeeTs
}

export function punch(args: PunchArgs) {
  return post<{ ok: true; event: unknown; status: StatusResponse }>('/api/punch', args);
}

export function requestCorrection(body: {
  kind: string; targetEventId?: string | null; requestedTs?: string | null; explanation: string;
}) {
  return post<{ ok: true; request: unknown }>('/api/correction-request', body);
}

export async function setPassword(email: string, password: string) {
  const res = await fetch('/api/set-password', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data as { ok: boolean; status: string };
}

export function linkAccount() {
  return post<{ ok: boolean; status: string; employee?: unknown; roles?: string[] }>('/api/link-account', {});
}

// ---- Phone + 4-digit PIN login (staff without email) ----
async function postPublic<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `Request failed (${res.status})`), { code: data?.error?.code, status: res.status });
  return data as T;
}
export interface PhoneSession { ok: boolean; status?: string; access_token: string; refresh_token: string }
export function loginPhone(phone: string, pin: string) {
  return postPublic<PhoneSession>('/api/login-phone', { phone, pin });
}
export function setPin(phone: string, pin: string) {
  return postPublic<PhoneSession>('/api/set-pin', { phone, pin });
}
export function forgotPin(phone: string) {
  return postPublic<{ ok: boolean }>('/api/forgot-pin', { phone });
}
export function resetPin(phone: string, code: string, pin: string) {
  return postPublic<PhoneSession>('/api/reset-pin', { phone, code, pin });
}

export function adminAction(body: Record<string, unknown>) {
  return post<{ ok: true }>('/api/admin', body);
}

// Admin read-through endpoints. These go through the server (which accepts BOTH
// the email/native token AND the Phone+PIN/chat token), so the admin screens
// work no matter how the admin signed in — unlike a direct RLS-gated DB read,
// which returns nothing under a Phone+PIN session.
export interface AdminEmployee {
  id: string; first_name: string; last_name: string; email: string | null; phone: string | null;
  primary_job_title: string | null; gusto_department_name: string | null; timekeeping_access: string;
  auth_user_id: string | null; chat_user_id: string | null; last_login_at: string | null;
  home_location_id: string | null; home_department_id: string | null; gusto_employee_uuid: string | null; is_manual: boolean | null;
  can_manage_own_time?: boolean | null;
}
export interface AdminBootstrap {
  ok: true;
  employees: AdminEmployee[];
  userRoles: Array<{ auth_user_id: string; role: string }>;
  locations: Array<{ id: string; short_name: string }>;
  departments: Array<{ id: string; title: string }>;
}
export function adminBootstrap() {
  return post<AdminBootstrap>('/api/admin', { type: 'admin_bootstrap' });
}

export interface TimecardEvent { id: string; event_type: string; server_ts: string; location_id: string | null; department_id: string | null; source: string; correction_reason: string | null }
export function timecardDetail(employeeId: string, start: string, end: string) {
  return post<{ ok: true; events: TimecardEvent[]; approval: { state: string } | null; payPeriodId: string | null }>('/api/admin', { type: 'timecard_detail', employeeId, start, end });
}

export interface LiveRow { employeeId: string; employee: string; location: string; department: string; since: string }
export function liveStatus() {
  return post<{ ok: true; rows: LiveRow[] }>('/api/admin', { type: 'live_status' });
}

export interface CorrectionReq {
  id: string; employee_id: string; kind: string; requested_ts: string | null;
  requested_location_id: string | null; requested_department_id: string | null;
  target_event_id: string | null; explanation: string; status: string; created_at: string;
  applied_ts: string | null; applied_source: string | null;
}
export function correctionsList() {
  return post<{ ok: true; requests: CorrectionReq[]; names: Record<string, string>; nameSort?: Record<string, string>; locations: Array<{ id: string; short_name: string }>; departments: Array<{ id: string; title: string }> }>('/api/admin', { type: 'corrections_list' });
}

export interface SetupLoc { id: string; display_name: string; short_name: string; address: string | null; is_active: boolean; sort_order: number }
export interface SetupDept { id: string; title: string; is_active: boolean; sort_order: number; gusto_job_title: string | null }
export function setupLoad() {
  return post<{ ok: true; locations: SetupLoc[]; departments: SetupDept[]; settings: Record<string, any> }>('/api/admin', { type: 'setup_load' });
}

export interface ReportSummaryRow { key: string; name: string; former: boolean; days: number; regular: number; overtime: number; total: number }
export interface ReportDetailRow { date: string; employee_name: string; email: string | null; gusto_employee_uuid: string | null; source: string; total_hours: number; regular_hours: number; overtime_hours: number }
export function reportsHours(start: string, end: string, employeeId?: string, activeOnly = true) {
  return post<{ ok: true; summary: ReportSummaryRow[]; detail: ReportDetailRow[] }>('/api/admin', { type: 'reports_hours', start, end, employeeId: employeeId || null, activeOnly });
}

// Approve + auto-apply a correction in one call.
// force: a single explicit approve — apply the requested time as reviewed.
// overrideTs/Loc/Dept: admin-entered values when the request carried none.
export function applyCorrection(
  correctionId: string,
  opts?: { force?: boolean; overrideTs?: string; overrideLocationId?: string | null; overrideDepartmentId?: string | null },
) {
  return post<{ ok: true; applied: boolean; needsManual?: boolean; message?: string }>('/api/admin', { type: 'apply_correction', correctionId, ...opts });
}

// Overnight spans: clock-in one ET day, clock-out the next (always a forgotten
// clock-out at Team). Excluded from hours until fixed.
export interface OvernightSpan { employee_id: string; name: string; in_ts: string; out_ts: string; in_label: string; out_label: string; in_day: string; out_day: string; hours: number }
export function overnightSpans(start: string, end: string) {
  return post<{ ok: true; count: number; rows: OvernightSpan[] }>('/api/admin', { type: 'overnight_spans', start, end });
}

// Full pay-period review: every employee's daily clock in/out, all at once.
export interface PeriodRow {
  employee_id: string; last_name: string; first_name: string; date: string; weekday: string;
  in_time: string | null; out_time: string | null; hours: number; source: string; open: boolean;
  out_late?: boolean; // clock-out at 8:30 PM ET or later — flagged for review
}
export function periodReview(start: string, end: string) {
  return post<{ ok: true; start: string; end: string; count: number; totalHours: number; rows: PeriodRow[] }>('/api/admin', { type: 'period_review', start, end });
}

// Admin timesheet — load a whole pay period for one employee as a day grid.
export interface TimesheetSegment { startLocal: string; endLocal: string | null; locationId: string | null; departmentId: string | null; hours: number | null; open: boolean }
export interface TimesheetEntryBy { by: string | null; source: string | null; reason: string | null }
export interface TimesheetDay { date: string; weekday: string; segments: TimesheetSegment[]; entry: TimesheetEntryBy | null }
export function timesheetLoad(employeeId: string, start: string, end: string) {
  return post<{ ok: true; start: string; end: string; home: { locationId: string | null; departmentId: string | null }; days: TimesheetDay[] }>('/api/admin', { type: 'timesheet_load', employeeId, start, end });
}
export function batchDayEntry(
  employeeId: string,
  days: Array<{ date: string; segments: Array<{ startTs: string; endTs: string | null; locationId: string | null; departmentId: string | null }> }>,
  reason?: string,
) {
  return post<{ ok: true; daysApplied: number; punchesInserted: number }>('/api/admin', { type: 'batch_day_entry', employeeId, days, reason });
}

// Migration status — who's invited / registered / clocked in on Team Time Clock.
export interface MigrationRow { employee_id: string; name: string; enabled: boolean; invited: boolean; registered: boolean; last_login_at: string | null; clocked_in_here: boolean }
export function migrationStatus() {
  return post<{ ok: true; summary: { total: number; invited: number; registered: number; clocked: number }; rows: MigrationRow[] }>('/api/admin', { type: 'migration_status' });
}

// Delegated-login identity: verifies the active token (chat or legacy) and
// returns the linked employee + roles.
export interface WhoAmI { ok: boolean; status?: string; employee: { id: string; first_name: string; home_location_id: string | null; home_department_id: string | null; can_manage_own_time?: boolean } | null; roles: string[] }

// Self-service time card (trusted staff with can_manage_own_time). Scoped to the
// caller — the server derives who they are from their login.
export function meTimecardLoad(start?: string, end?: string) {
  return post<{ ok: true; start: string; end: string; allowedStart: string; allowedEnd: string; home: { locationId: string | null; departmentId: string | null }; days: Array<{ date: string; weekday: string; segments: TimesheetSegment[]; importedHours: number | null }> }>('/api/me-timecard', { action: 'load', start, end });
}
export function meTimecardSave(days: Array<{ date: string; segments: Array<{ startTs: string; endTs: string | null; locationId: string | null; departmentId: string | null }> }>, reason?: string) {
  return post<{ ok: true; daysApplied: number; punchesInserted: number }>('/api/me-timecard', { action: 'save', days, reason });
}
export function setSelfManage(employeeId: string, enabled: boolean) {
  return post<{ ok: true }>('/api/admin', { type: 'set_self_manage', employeeId, enabled });
}

// Read-only "My Hours" — every employee can see their own totals (payroll-accurate).
// A manager edit/add to a punch, shown on the employee's own history.
export interface PunchEdit { field: 'in' | 'out'; kind: 'edited' | 'added'; from: string | null; to: string; by: string; at: string }
export interface MyHoursDay { date: string; weekday: string; in: string | null; out: string | null; total: number | null; open: boolean; source: string; segments?: Array<{ in: string; out: string | null }>; edits?: PunchEdit[] }
export interface MyHours {
  employee_id: string; is_clocked_in: boolean; clocked_in_at: string | null;
  period_start: string; period_end: string; is_current_period?: boolean;
  hours_this_period: number | null; hours_this_week: number | null; hours_last_week: number | null;
  days: MyHoursDay[]; last_updated: string;
}
// Pass a {start,end} to view a PAST pay period; omit for the current one.
export async function meHours(period?: { start: string; end: string }): Promise<MyHours> {
  const token = await accessToken();
  const q = period ? `?start=${encodeURIComponent(period.start)}&end=${encodeURIComponent(period.end)}` : '';
  const res = await fetch(`/api/me/hours${q}`, { headers: { authorization: `Bearer ${token ?? ''}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data as MyHours;
}
export function whoami(phone?: string) {
  return post<WhoAmI>('/api/whoami', phone ? { phone } : {});
}

// One authenticated call with everything the clock screen needs (so it never
// reads the DB directly — required for chat-token sessions).
export interface ClockBootstrap {
  ok: true;
  locations: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
  myLocationIds: string[];
  myDepartmentIds: string[];
  events: Array<{ id: string; event_type: string; server_ts: string; location_id: string | null; department_id: string | null; note: string | null }>;
}
export function clockBootstrap() {
  return post<ClockBootstrap>('/api/clock-bootstrap', {});
}

export interface LaborRow {
  name: string; location_id: string | null; location: string; department: string;
  in_time: string | null; out_time: string | null; hours: number; source: string;
}
export function laborDetail(date: string) {
  return post<{ ok: true; date: string; totalHours: number; rows: LaborRow[] }>('/api/admin', { type: 'labor_detail', date });
}

export interface GuestCounts { ok: true; date: string; configured: boolean; partial?: boolean; byLocation: Record<string, number>; total: number }
export function guestCounts(date: string) {
  return post<GuestCounts>('/api/admin', { type: 'guest_counts', date });
}

export interface GustoSyncResult {
  configured: boolean; scanned: number; newHires: string[]; terminated: string[]; reactivatedConflicts: string[]; updated: number; error?: string;
}
export function syncGusto() {
  return post<{ ok: true; result: GustoSyncResult }>('/api/admin', { type: 'sync_gusto' });
}

export type InviteLang = 'en' | 'es';
export function inviteSms(employeeId: string, phone?: string, lang: InviteLang = 'en') {
  return post<{ ok: true; sid: string | null }>('/api/invite-sms', { employeeId, phone, lang });
}

export function inviteEmail(employeeId: string, lang: InviteLang = 'en') {
  return post<{ ok: true }>('/api/invite-email', { employeeId, lang });
}

export function inviteTeamChat(employeeId: string) {
  return post<{ ok: true }>('/api/invite-teamchat', { employeeId });
}

export interface BackupItem { key: string; created_at: string | null; bytes: number | null; rows: number | null }
export async function listBackups() {
  const token = await accessToken();
  const res = await fetch('/api/backups', { headers: { authorization: `Bearer ${token ?? ''}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data as { ok: true; backups: BackupItem[] };
}
export function runBackupNow() {
  return post<{ ok: true; key: string; bytes: number; kept: number }>('/api/backups', {});
}
export async function downloadBackup(key: string) {
  const token = await accessToken();
  const res = await fetch(`/api/backups?key=${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${token ?? ''}` } });
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = key; a.click(); URL.revokeObjectURL(a.href);
}

export interface PayrollPreview {
  ok: true;
  preview: {
    employees: number; jobLines: number; regularHours: number; overtimeHours: number; estCost?: number; exceptions: number; unmatchedJobs?: number; excludedNonGusto?: number;
    // Dollar extras from the Team Payroll Performance dashboard riding the CSV
    // (null/absent = dashboard data unavailable, file is hours-only). Keys of
    // totalsByEarning are exact Gusto earning-type names.
    extras?: { total: number; totalsByEarning: Record<string, number>; people: number; unmatched: string[]; manualOnly: Array<{ person: string; category: string; amount: number }>; excludedPaid?: Array<{ person: string; category: string; amount: number; reason: string }> } | null;
  };
  rows: Array<Record<string, unknown>>;
  csv: string;
}
export async function payrollExport(start: string, end: string): Promise<PayrollPreview> {
  const token = await accessToken();
  const res = await fetch(`/api/payroll-export?start=${start}&end=${end}`, {
    headers: { authorization: `Bearer ${token ?? ''}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data as PayrollPreview;
}

/**
 * Reads the caller's own recent events (RLS-gated) to show status/history.
 * Passing employeeId makes the request URL user-specific — belt-and-suspenders
 * so a cached HTTP response can never be replayed for a different signed-in user.
 */
export async function fetchRecentEvents(limit = 20, employeeId?: string) {
  let q = supabase
    .from('punch_events')
    .select('id, event_type, server_ts, location_id, department_id, note')
    .is('voided_at', null);
  if (employeeId) q = q.eq('employee_id', employeeId);
  const { data, error } = await q.order('server_ts', { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}
