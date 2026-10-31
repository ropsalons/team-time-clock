import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { adminAction, adminBootstrap, liveStatus, inviteSms, inviteEmail, inviteTeamChat, payrollExport, laborDetail, guestCounts, overnightSpans, periodReview, migrationStatus, setSelfManage, type PayrollPreview, type LaborRow, type OvernightSpan, type PeriodRow, type MigrationRow } from '../../lib/api';
import { payPeriodFor, formatElapsed, durationSeconds, listPayPeriods, payPeriodLabel } from '../../lib/time';
import { APP_VERSION, BUILT_AT } from '../../lib/version';
import { CHANGELOG } from '../../data/changelog';
import HelpModal from '../help/HelpModal';
import Timecards from './Timecards';
import Timesheet from './Timesheet';
import Setup from './Setup';
import Corrections from './Corrections';
import { EmployeeEditor as EmployeePunchEditor } from './Timecards';
import Reports from './Reports';

type Tab = 'live' | 'employees' | 'timesheet' | 'timecards' | 'corrections' | 'payroll' | 'reports' | 'setup';

export default function AdminApp({ firstName, onSignOut, onSwitchToClock }: { firstName: string; onSignOut: () => void; onSwitchToClock: () => void }) {
  // A deep link can open straight to a tab, e.g. ?tab=payroll (used for the
  // payroll link posted to Team Chat). Falls back to Live status.
  const [tab, setTab] = useState<Tab>(() => {
    const valid: Tab[] = ['live', 'employees', 'timesheet', 'timecards', 'corrections', 'payroll', 'reports', 'setup'];
    // A deep link (?tab=) wins; otherwise return to the tab you were last on so
    // navigating away and back doesn't dump you on Live status every time.
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && (valid as string[]).includes(t)) return t as Tab;
    try { const s = sessionStorage.getItem('brand-admin-tab'); if (s && (valid as string[]).includes(s)) return s as Tab; } catch { /* ignore */ }
    return 'live';
  });
  useEffect(() => { try { sessionStorage.setItem('brand-admin-tab', tab); } catch { /* ignore */ } }, [tab]);
  const [showHelp, setShowHelp] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [laborOpen, setLaborOpen] = useState(false);
  return (
    <div className="min-h-full bg-neutral-50">
      <header className="bg-brand-ink text-white px-4 py-3 flex items-center justify-between sticky top-0 z-10 safe-top no-print">
        <div><span className="font-semibold tracking-wide">Team Time Clock</span><span className="text-white/60 text-sm ml-2">Admin</span></div>
        <div className="flex items-center gap-3 text-sm">
          <button onClick={() => setLaborOpen(true)} className="rounded-full bg-white/15 hover:bg-white/25 px-3 py-1 font-medium">Labor detail</button>
          <button onClick={() => setShowHelp(true)} className="text-white/80 underline">Help</button>
          <button onClick={onSwitchToClock} className="text-white/80 underline">My clock</button>
          <button onClick={onSignOut} className="text-white/60 underline">Sign out</button>
        </div>
      </header>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
      <LaborDetailPanel open={laborOpen} onClose={() => setLaborOpen(false)} />
      <nav className="flex gap-1 px-3 pt-3 max-w-5xl mx-auto flex-wrap no-print">
        {(['live', 'employees', 'timesheet', 'timecards', 'corrections', 'payroll', 'reports', 'setup'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={['px-4 py-2 rounded-t-lg text-sm font-medium capitalize', tab === t ? 'bg-white text-brand-ink shadow-sm' : 'text-neutral-500'].join(' ')}>
            {t === 'live' ? 'Live status' : t}
          </button>
        ))}
      </nav>
      <main className="max-w-5xl mx-auto p-3 pb-16">
        {tab === 'live' && <LiveStatus />}
        {tab === 'employees' && <Employees adminName={firstName} />}
        {tab === 'timesheet' && <Timesheet />}
        {tab === 'timecards' && <Timecards />}
        {tab === 'corrections' && <Corrections />}
        {tab === 'payroll' && <Payroll />}
        {tab === 'reports' && <Reports />}
        {tab === 'setup' && <Setup />}
        <footer className="text-[11px] text-neutral-400 text-center mt-6">
          <button onClick={() => setShowChangelog(true)} className="underline decoration-dotted">Team Time Clock {APP_VERSION}</button>
          {' '}· updated {BUILT_AT} · all times Eastern
        </footer>
      </main>
    </div>
  );
}

// ---- Live status -----------------------------------------------------------
interface WorkingRow { employeeId: string; employee: string; location: string; department: string; since: string }

function LiveStatus() {
  const [rows, setRows] = useState<WorkingRow[] | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  const load = useCallback(async () => {
    const r = await liveStatus();
    setRows(r.rows.map((w) => ({ employeeId: w.employeeId, employee: w.employee, location: w.location, department: w.department, since: w.since })));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (body: Record<string, unknown>, ok: string) => {
    setBusy(String(body.employeeId)); setMsg(null);
    try { await adminAction(body); setMsg(ok); await load(); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(null); }
  };
  const clockOut = (r: WorkingRow) => {
    const when = window.prompt(`Clock ${r.employee} OUT at (YYYY-MM-DDTHH:MM, Eastern):`, nowLocalET());
    if (!when) return;
    act({ type: 'end_open_shift', employeeId: r.employeeId, mode: 'clock_out', effectiveTs: etToIso(when), reason: 'admin clock-out' }, `${r.employee} clocked out.`);
  };
  const cancelShift = (r: WorkingRow) => {
    if (!window.confirm(`Cancel ${r.employee}'s open clock-in?\n\nUse this for a test or accidental punch — NO hours are recorded. (History is kept.)`)) return;
    const reason = window.prompt('Reason:', 'accidental / test punch'); if (!reason) return;
    act({ type: 'end_open_shift', employeeId: r.employeeId, mode: 'cancel', reason }, `${r.employee}'s open shift cancelled.`);
  };

  if (!rows) return <Card>Loading live status…</Card>;
  return (
    <Card>
      <h2 className="font-semibold text-brand-ink mb-2">Working now ({rows.length})</h2>
      {msg && <p className="text-sm text-neutral-600 mb-2">{msg}</p>}
      {rows.length === 0 ? <p className="text-neutral-500 text-sm">No one is currently clocked in.</p> : (
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead><tr className="text-left text-neutral-500"><th className="py-1">Employee</th><th>Location</th><th>Department</th><th className="text-right">Elapsed</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const secs = r.since ? durationSeconds(new Date(r.since), now) : 0;
              const tooLong = secs > 16 * 3600; // forgot-to-clock-out flag
              return (
                <tr key={r.employeeId} className="border-t border-neutral-100">
                  <td className="py-2 font-medium">{r.employee}</td><td>{r.location}</td><td>{r.department}</td>
                  <td className={`text-right tabular-nums ${tooLong ? 'text-red-600 font-semibold' : ''}`} title={tooLong ? 'Over 16 hours — likely forgot to clock out' : ''}>{r.since ? formatElapsed(secs) : ''}{tooLong ? ' ⚠️' : ''}</td>
                  <td className="text-right whitespace-nowrap">
                    <button onClick={() => clockOut(r)} disabled={busy === r.employeeId} className="text-blue-600 underline mr-3 disabled:opacity-50">clock out</button>
                    <button onClick={() => cancelShift(r)} disabled={busy === r.employeeId} className="text-red-600 underline disabled:opacity-50">cancel</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
      <p className="text-xs text-neutral-400 mt-3"><b>Clock out</b> ends the shift at a time you set (records the hours). <b>Cancel</b> removes an accidental or test clock-in (no hours). Both keep full history.</p>
    </Card>
  );
}

// Current time as a datetime-local string in Eastern.
function nowLocalET(): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}
// Interpret a datetime-local string as Eastern and return a UTC ISO string.
function etToIso(local: string): string {
  const naive = new Date(`${local}:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(naive).find((x) => x.type === 'timeZoneName')?.value;
  return new Date(`${local}:00${name === 'EST' ? '-05:00' : '-04:00'}`).toISOString();
}

// ---- Labor Detail slide-out: who worked, by salon, for a chosen day ----------
function LaborDetailPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [date, setDate] = useState(() => etDateStr(0));
  const [data, setData] = useState<{ totalHours: number; rows: LaborRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  // Guest counts come from Boulevard, separately and best-effort: if Boulevard
  // is unset/down the labor panel still works and guests just don't show.
  const [guests, setGuests] = useState<{ byLocation: Record<string, number>; total: number; configured: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      setBusy(true); setData(null); setGuests(null);
      try { const r = await laborDetail(date); if (alive) setData({ totalHours: r.totalHours, rows: r.rows }); }
      catch { if (alive) setData({ totalHours: 0, rows: [] }); }
      finally { if (alive) setBusy(false); }
    })();
    (async () => {
      try { const g = await guestCounts(date); if (alive) setGuests({ byLocation: g.byLocation, total: g.total, configured: g.configured }); }
      catch { if (alive) setGuests(null); }
    })();
    return () => { alive = false; };
  }, [open, date]);

  const groups = useMemo(() => {
    const g = new Map<string, LaborRow[]>();
    for (const r of data?.rows ?? []) { const k = r.location || 'Other'; (g.get(k) ?? g.set(k, []).get(k)!).push(r); }
    // within each salon: Stylist, then Associate, then Concierge, then the rest — each alphabetical
    const rank = (d: string) => (d === 'Stylist' ? 0 : d === 'Associate' ? 1 : d === 'Concierge' ? 2 : 3);
    for (const list of g.values()) list.sort((a, b) => rank(a.department) - rank(b.department) || a.name.localeCompare(b.name));
    const order = ['Downtown', 'Uptown', 'Lakeside', 'Remote'];
    return [...g.entries()].sort((a, b) => {
      if (a[0] === 'Other') return 1; if (b[0] === 'Other') return -1;
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0]);
    });
  }, [data]);

  // Company-wide totals per role (all locations combined), same role order as the salons.
  const enterpriseByDept = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data?.rows ?? []) { const k = r.department || 'Other'; m.set(k, (m.get(k) ?? 0) + r.hours); }
    const rank = (d: string) => (d === 'Stylist' ? 0 : d === 'Associate' ? 1 : d === 'Concierge' ? 2 : d === 'Other' ? 98 : 3);
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  }, [data]);

  // Mon–Sat of the CURRENT week (Eastern), for one-tap day picking.
  const todayStr = etDateStr(0);
  const dow = new Date(`${todayStr}T12:00:00`).getDay(); // 0=Sun … 6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) => ({ label, d: etDateStr(mondayOffset + i) }));

  return (
    <div className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      {/* faint scrim — page stays visible behind the drawer */}
      <div className={`absolute inset-0 bg-black/20 transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0'}`} onClick={onClose} />
      {/* the drawer itself slides in from the right edge */}
      <aside className={`absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl flex flex-col transition-transform duration-300 ease-out will-change-transform motion-reduce:transition-none ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200">
          <div><div className="font-semibold text-brand-ink">Team Time Clock — Labor Detail</div><div className="text-xs text-neutral-400">all times Eastern</div></div>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700 text-2xl leading-none px-1">×</button>
        </div>
        <div className="px-4 pt-3 pb-2 flex flex-wrap items-center gap-2">
          <button onClick={() => setDate(etDateStr(0))} className={laborPill(date === etDateStr(0))}>Today</button>
          <button onClick={() => setDate(etDateStr(-1))} className={laborPill(date === etDateStr(-1))}>Yesterday</button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-neutral-300 px-2 py-1 text-sm ml-auto" />
        </div>
        <div className="px-4 pb-3 flex flex-wrap items-center gap-1.5 border-b border-neutral-100">
          <span className="text-xs text-neutral-400 mr-1">This week</span>
          {weekDays.map((w) => {
            const future = w.d > todayStr;
            return (
              <button key={w.d} disabled={future} onClick={() => setDate(w.d)}
                className={['rounded-lg px-2.5 py-1 text-xs border', future ? 'opacity-40 cursor-not-allowed border-neutral-200 text-neutral-400' : date === w.d ? 'bg-brand-ink text-white border-brand-ink' : 'bg-white border-neutral-300 text-neutral-700'].join(' ')}>
                {w.label}
              </button>
            );
          })}
        </div>
        <div className="px-4 py-2 text-sm text-neutral-500 border-b border-neutral-100">{fmtDateLong(date)} · <b className="text-brand-ink">{(data?.totalHours ?? 0).toFixed(2)} hrs</b> · {data?.rows.length ?? 0} shifts</div>
        <div className="flex-1 overflow-y-auto">
          {busy ? <p className="p-4 text-neutral-400 text-sm">Loading…</p>
            : groups.length === 0 ? <p className="p-4 text-neutral-400 text-sm">No hours recorded for this day yet.</p>
            : <>
              {groups.map(([salon, list]) => {
                // rows are pre-sorted by role, so runs of the same department are contiguous
                const byDept: Array<[string, LaborRow[]]> = [];
                for (const r of list) {
                  const key = r.department || 'Other';
                  const last = byDept[byDept.length - 1];
                  if (last && last[0] === key) last[1].push(r);
                  else byDept.push([key, [r]]);
                }
                return (
                  <div key={salon} className="px-4 py-2">
                    <div className="text-xs uppercase tracking-wide text-neutral-500 font-semibold mt-1 mb-1">{salon}</div>
                    {byDept.map(([dept, rows]) => (
                      <div key={dept} className="mb-2">
                        <div className="flex flex-col divide-y divide-neutral-100">
                          {rows.map((r, i) => (
                            <div key={i} className="py-1.5 flex items-baseline gap-2">
                              <span className="font-medium text-sm flex-1 min-w-0 truncate">{r.name}{r.department ? <span className="text-neutral-400 font-normal"> · {r.department}</span> : null}</span>
                              <span className="text-xs text-neutral-500 tabular-nums whitespace-nowrap">{r.in_time ?? '—'} → {r.out_time ?? <span className="text-amber-600">still in</span>}</span>
                              <span className="text-sm tabular-nums font-semibold w-12 text-right">{r.hours.toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-baseline justify-between mt-1 pt-1 border-t border-dashed border-neutral-200">
                          <span className="text-[11px] uppercase tracking-wide text-neutral-400 font-medium">{dept} total</span>
                          <span className="text-xs tabular-nums font-semibold text-neutral-600">{rows.reduce((s, r) => s + r.hours, 0).toFixed(2)} hrs</span>
                        </div>
                      </div>
                    ))}
                    <div className="flex items-baseline justify-between mt-0.5 pt-1.5 border-t border-neutral-300">
                      <span className="text-xs uppercase tracking-wide text-neutral-600 font-bold">{salon} total</span>
                      <span className="flex items-baseline gap-3">
                        {guests?.configured && (guests.byLocation[salon] ?? -1) >= 0
                          ? <span className="text-xs tabular-nums font-semibold text-emerald-700">{guests.byLocation[salon]} guests</span> : null}
                        <span className="text-sm tabular-nums font-bold text-brand-ink">{list.reduce((s, r) => s + r.hours, 0).toFixed(2)} hrs</span>
                      </span>
                    </div>
                  </div>
                );
              })}
              <div className="px-4 pt-3 pb-3 mt-1 border-t-2 border-neutral-300 sticky bottom-0 bg-white">
                <div className="text-xs uppercase tracking-wide text-neutral-500 font-semibold mb-1">Enterprise summary — all salons</div>
                {enterpriseByDept.map(([dept, hrs]) => (
                  <div key={dept} className="flex items-baseline justify-between py-0.5">
                    <span className="text-xs text-neutral-500">{dept}</span>
                    <span className="text-xs tabular-nums font-semibold text-neutral-700">{hrs.toFixed(2)} hrs</span>
                  </div>
                ))}
                <div className="flex items-baseline justify-between mt-1 pt-1.5 border-t border-neutral-300">
                  <span className="text-sm font-bold text-brand-ink">Enterprise total</span>
                  <span className="flex items-baseline gap-3">
                    {guests?.configured ? <span className="text-sm tabular-nums font-bold text-emerald-700">{guests.total} guests</span> : null}
                    <span className="text-base tabular-nums font-bold text-brand-ink">{(data?.totalHours ?? 0).toFixed(2)} hrs</span>
                  </span>
                </div>
              </div>
            </>}
        </div>
      </aside>
    </div>
  );
}
function laborPill(active: boolean) { return ['rounded-full px-3 py-1 text-sm border', active ? 'bg-brand-ink text-white border-brand-ink' : 'bg-white border-neutral-300 text-neutral-700'].join(' '); }
// Eastern calendar date (YYYY-MM-DD), offset in days from today.
function etDateStr(offsetDays: number): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + offsetDays * 86400000));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function fmtDateLong(d: string) { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }); }

// ---- Employees + access decisions ------------------------------------------
interface EmpRow { id: string; first_name: string; last_name: string; email: string | null; phone: string | null; primary_job_title: string | null; gusto_department_name: string | null; timekeeping_access: string; auth_user_id: string | null; chat_user_id: string | null; last_login_at: string | null; home_location_id: string | null; home_department_id: string | null; can_manage_own_time?: boolean | null }
interface Opt { id: string; name: string }
const ACCESS_OPTIONS = ['pending_review', 'enabled', 'suspended', 'disabled'];
// Simplified role picker. "Manager" = location_manager across all locations for now.
const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'employee', label: 'Employee' },
  { value: 'location_manager', label: 'Manager' },
  { value: 'payroll_admin', label: 'Payroll admin' },
  { value: 'system_admin', label: 'Admin' },
];

// Staff setup progress: who's invited / registered (set up
// their PIN & signed in) / has actually clocked in on Team Time Clock.
function MigrationStatus() {
  const [data, setData] = useState<{ summary: { total: number; invited: number; registered: number; clocked: number }; rows: MigrationRow[] } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { migrationStatus().then((r) => setData({ summary: r.summary, rows: r.rows })).catch(() => {}); }, []);
  if (!data) return null;
  const s = data.summary;
  const yes = (b: boolean) => b ? <span className="text-emerald-600 font-semibold">✓</span> : <span className="text-neutral-300">—</span>;
  return (
    <div className="mb-4 rounded-xl border border-neutral-200 border-l-4 border-l-indigo-400 bg-indigo-50/30 p-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between text-left">
        <span className="font-semibold text-brand-ink text-sm">Staff setup progress <span className="text-neutral-400 font-normal">· {s.clocked}/{s.total} clocked in here · {s.registered} registered</span></span>
        <span className="text-neutral-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-sm min-w-[520px]">
            <thead><tr className="text-left text-neutral-500"><th className="py-1">Employee</th><th className="text-center">Invited</th><th className="text-center">Registered</th><th className="text-center">Clocked in here</th><th>Last sign-in</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.employee_id} className="border-t border-neutral-100">
                  <td className="py-1.5 font-medium">{r.name}{!r.enabled && <span className="text-xs text-amber-600"> · not enabled</span>}</td>
                  <td className="text-center">{yes(r.invited)}</td>
                  <td className="text-center">{yes(r.registered)}</td>
                  <td className="text-center">{yes(r.clocked_in_here)}</td>
                  <td className="text-neutral-500 text-xs">{r.last_login_at ? new Date(r.last_login_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-neutral-400 mt-2">“Registered” = they set up their PIN / signed in. “Clocked in here” = they’ve punched on Team Time Clock at least once. People not fully switched are listed first.</p>
        </div>
      )}
    </div>
  );
}

function Employees({ adminName: _adminName }: { adminName: string }) {
  const [rows, setRows] = useState<EmpRow[] | null>(null);
  const [roleMap, setRoleMap] = useState<Record<string, string[]>>({});
  const [locs, setLocs] = useState<Opt[]>([]);
  const [depts, setDepts] = useState<Opt[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  // Per-employee invite language (EN default). Lets an admin send the setup
  // message in Spanish to staff who read it more comfortably.
  const [langByEmp, setLangByEmp] = useState<Record<string, 'en' | 'es'>>({});
  const langOf = (id: string): 'en' | 'es' => langByEmp[id] ?? 'en';

  const load = async () => {
    const b = await adminBootstrap();
    setRows(b.employees as EmpRow[]);
    setLocs(b.locations.map((x) => ({ id: x.id, name: x.short_name })));
    setDepts(b.departments.map((x) => ({ id: x.id, name: x.title })));
    const m: Record<string, string[]> = {};
    for (const r of b.userRoles) if (r.auth_user_id) (m[r.auth_user_id] ??= []).push(r.role);
    setRoleMap(m);
  };
  useEffect(() => { load(); }, []);

  const saveEmployee = async (id: string, patch: Record<string, unknown>) => {
    setSaving(id);
    try { await adminAction({ type: 'update_employee', employeeId: id, ...patch }); setEditing(null); await load(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
    finally { setSaving(null); }
  };
  const fmtPhone = (p: string | null) => !p ? '—' : p.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');

  const setAccess = async (id: string, access: string) => {
    setSaving(id);
    try { await adminAction({ type: 'set_access', employeeId: id, access }); await load(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
    finally { setSaving(null); }
  };
  const setRole = async (id: string, role: string) => {
    setSaving(id);
    try {
      const roles = role === 'employee' ? [] : [{ role }];
      await adminAction({ type: 'set_roles', employeeId: id, roles });
      await load();
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
    finally { setSaving(null); }
  };
  const toggleSelfManage = async (r: EmpRow) => {
    setSaving(r.id);
    try { await setSelfManage(r.id, !r.can_manage_own_time); await load(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
    finally { setSaving(null); }
  };
  const textInvite = async (r: EmpRow) => {
    // Use the number already on file; only ask if we truly don't have one.
    let phone = r.phone ?? '';
    if (!phone) {
      const p = window.prompt(`No mobile number on file for ${r.first_name}. Enter one:`, '');
      if (!p) return;
      phone = p;
    }
    setSaving(r.id);
    const inLang = langOf(r.id) === 'es' ? ' in Spanish' : '';
    try { await inviteSms(r.id, phone, langOf(r.id)); alert(`Setup link texted to ${r.first_name}${inLang}${r.phone ? ` at ${fmtPhone(r.phone)}` : ''}.`); await load(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not send text'); }
    finally { setSaving(null); }
  };
  const emailInvite = async (r: EmpRow) => {
    setSaving(r.id);
    const inLang = langOf(r.id) === 'es' ? ' in Spanish' : '';
    try { await inviteEmail(r.id, langOf(r.id)); alert(`Setup link emailed to ${r.first_name}${inLang} at ${r.email}.`); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not send email'); }
    finally { setSaving(null); }
  };
  const teamChatInvite = async (r: EmpRow) => {
    setSaving(r.id);
    try { await inviteTeamChat(r.id); alert(`Setup link sent to ${r.first_name} as a Team Chat DM (${r.email}).`); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not send Team Chat DM'); }
    finally { setSaving(null); }
  };
  // One click: text AND email the same setup invite.
  const textEmailInvite = async (r: EmpRow) => {
    let phone = r.phone ?? '';
    if (!phone) { const p = window.prompt(`No mobile number on file for ${r.first_name}. Enter one:`, ''); if (!p) return; phone = p; }
    setSaving(r.id);
    const out: string[] = [];
    try { await inviteSms(r.id, phone, langOf(r.id)); out.push('✅ texted'); } catch (e) { out.push(`❌ text (${e instanceof Error ? e.message : 'error'})`); }
    if (r.email) { try { await inviteEmail(r.id, langOf(r.id)); out.push('✅ emailed'); } catch (e) { out.push(`❌ email (${e instanceof Error ? e.message : 'error'})`); } }
    else out.push('⚠️ no email on file');
    alert(`${r.first_name}${langOf(r.id) === 'es' ? ' (Spanish)' : ''}: ${out.join('  ·  ')}`);
    await load();
    setSaving(null);
  };
  const topRole = (authId: string | null) => {
    const rs = authId ? roleMap[authId] ?? [] : [];
    for (const r of ['system_admin', 'payroll_admin', 'location_manager']) if (rs.includes(r)) return r;
    return 'employee';
  };

  if (!rows) return <Card>Loading employees…</Card>;
  const INACTIVE = new Set(['terminated_in_gusto', 'disabled', 'suspended']);
  const inactiveCount = rows.filter((r) => INACTIVE.has(r.timekeeping_access)).length;
  const filtered = rows
    .filter((r) => showInactive || !INACTIVE.has(r.timekeeping_access))
    .filter((r) => `${r.first_name} ${r.last_name} ${r.email}`.toLowerCase().includes(q.toLowerCase()));
  const counts = rows.reduce<Record<string, number>>((a, r) => { a[r.timekeeping_access] = (a[r.timekeeping_access] ?? 0) + 1; return a; }, {});

  return (
    <Card>
      <MigrationStatus />
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h2 className="font-semibold text-brand-ink">Employees ({rows.length - inactiveCount})</h2>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <span>enabled {counts.enabled ?? 0} · pending {counts.pending_review ?? 0}</span>
          {inactiveCount > 0 && (
            <button onClick={() => setShowInactive((v) => !v)} className="underline text-neutral-500 hover:text-neutral-700">
              {showInactive ? 'Hide' : 'Show'} {inactiveCount} inactive
            </button>
          )}
        </div>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm mb-3" />
      <AddEmployeeForm onAdded={load} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead><tr className="text-left text-neutral-500"><th className="py-1">Name</th><th>Phone</th><th>Access</th><th>Role</th><th></th></tr></thead>
          <tbody>
            {filtered.map((r) => (
              <Fragment key={r.id}>
                <tr className="border-t border-neutral-100">
                  <td className="py-2">
                    <div className="font-medium">{r.first_name} {r.last_name}{r.home_department_id ? <span className="text-neutral-400 font-normal"> · {depts.find((d) => d.id === r.home_department_id)?.name}</span> : null}</div>
                    <div className="text-neutral-400 text-xs">{r.email}</div>
                    {(r.auth_user_id || r.chat_user_id || r.last_login_at)
                      ? <div className="text-emerald-600 text-xs font-medium mt-0.5">✓ signed in{r.last_login_at ? ` · ${new Date(r.last_login_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}` : ''}</div>
                      : <div className="text-neutral-400 text-xs mt-0.5">not signed in yet</div>}
                  </td>
                  <td className="tabular-nums text-neutral-600">{fmtPhone(r.phone)}</td>
                  <td>
                    <select value={r.timekeeping_access} disabled={saving === r.id} onChange={(e) => setAccess(r.id, e.target.value)}
                      className={['rounded-lg border px-2 py-1 text-sm', r.timekeeping_access === 'enabled' ? 'border-emerald-300 bg-emerald-50' : 'border-neutral-300 bg-white'].join(' ')}>
                      {[...new Set([...ACCESS_OPTIONS, r.timekeeping_access])].map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
                    </select>
                  </td>
                  <td>
                    {r.auth_user_id ? (
                      <select value={topRole(r.auth_user_id)} disabled={saving === r.id} onChange={(e) => setRole(r.id, e.target.value)}
                        className="rounded-lg border border-neutral-300 px-2 py-1 text-sm bg-white">
                        {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (r.chat_user_id || r.last_login_at)
                      ? <span className="text-xs text-neutral-400">Employee</span>
                      : <span className="text-xs text-neutral-400">must log in first</span>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button onClick={() => setEditing(editing === r.id ? null : r.id)} className="text-blue-600 underline text-sm mr-3">edit</button>
                    <button onClick={() => toggleSelfManage(r)} disabled={saving === r.id}
                      title="Let this trusted person add/edit their OWN time card (My Time Card screen)"
                      className={['rounded-full border px-2 py-0.5 text-xs mr-3', r.can_manage_own_time ? 'border-emerald-400 bg-emerald-50 text-emerald-800' : 'border-neutral-300 text-neutral-500'].join(' ')}>
                      self-time {r.can_manage_own_time ? 'ON' : 'off'}
                    </button>
                    {r.timekeeping_access === 'enabled' && (
                      <span className="text-sm">
                        <button
                          onClick={() => setLangByEmp((m) => ({ ...m, [r.id]: langOf(r.id) === 'es' ? 'en' : 'es' }))}
                          title="Language the invite will be sent in — click to switch"
                          className={['rounded-full border px-2 py-0.5 text-xs font-medium mr-2', langOf(r.id) === 'es' ? 'border-amber-400 bg-amber-50 text-amber-800' : 'border-neutral-300 bg-white text-neutral-600'].join(' ')}>
                          {langOf(r.id) === 'es' ? '🇪🇸 Español' : '🇺🇸 English'}
                        </button>
                        <span className="text-neutral-400">invite:</span>{' '}
                        <button onClick={() => textEmailInvite(r)} disabled={saving === r.id} className="text-emerald-700 underline font-semibold">Text + Email</button>
                        <span className="text-neutral-300"> · </span>
                        <button onClick={() => textInvite(r)} disabled={saving === r.id} className="text-emerald-700 underline">Text</button>
                        <span className="text-neutral-300"> · </span>
                        <button onClick={() => emailInvite(r)} disabled={saving === r.id} className="text-emerald-700 underline">Email</button>
                        <span className="text-neutral-300"> · </span>
                        <button onClick={() => teamChatInvite(r)} disabled={saving === r.id} className="text-emerald-700 underline">Team Chat</button>
                      </span>
                    )}
                  </td>
                </tr>
                {editing === r.id && (
                  <tr className="bg-neutral-50">
                    <td colSpan={5} className="p-3">
                      <EmployeeEditor row={r} locs={locs} depts={depts} busy={saving === r.id}
                        onSave={(patch) => saveEmployee(r.id, patch)} onClose={() => setEditing(null)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-400 mt-3">Managers can review & edit timecards for employees at their assigned locations. Payroll admins & admins have full reach.</p>
    </Card>
  );
}

// ---- Inline editor: phone + home location + home department ----------------
function EmployeeEditor({ row, locs, depts, busy, onSave, onClose }: {
  row: EmpRow; locs: Opt[]; depts: Opt[]; busy: boolean;
  onSave: (patch: Record<string, unknown>) => void; onClose: () => void;
}) {
  const [phone, setPhone] = useState(row.phone ?? '');
  const [loc, setLoc] = useState(row.home_location_id ?? '');
  const [dept, setDept] = useState(row.home_department_id ?? '');
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 555-0100" className="block rounded border border-neutral-300 px-2 py-1 mt-1 text-sm" /></label>
      <label className="text-sm">Home location
        <select value={loc} onChange={(e) => setLoc(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1 text-sm bg-white"><option value="">—</option>{locs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
      </label>
      <label className="text-sm">Home department
        <select value={dept} onChange={(e) => setDept(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1 text-sm bg-white"><option value="">—</option>{depts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
      </label>
      <button disabled={busy} onClick={() => onSave({ phone, homeLocationId: loc || null, homeDepartmentId: dept || null })} className="rounded bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50">Save</button>
      <button onClick={onClose} className="rounded border border-neutral-300 px-3 py-1.5 text-sm">Cancel</button>
    </div>
  );
}

// ---- Add a manual employee (before they're in Gusto) -----------------------
function AddEmployeeForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [locs, setLocs] = useState<Array<{ id: string; short_name: string }>>([]);
  const [depts, setDepts] = useState<Array<{ id: string; title: string }>>([]);
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', homeLocationId: '', homeDepartmentId: '', access: 'enabled' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    adminBootstrap().then((b) => { setLocs(b.locations as any); setDepts(b.departments as any); }).catch(() => {});
  }, [open]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await adminAction({ type: 'create_employee', ...f, homeLocationId: f.homeLocationId || null, homeDepartmentId: f.homeDepartmentId || null });
      setF({ firstName: '', lastName: '', email: '', phone: '', homeLocationId: '', homeDepartmentId: '', access: 'enabled' });
      setOpen(false); onAdded();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };

  if (!open) return <button onClick={() => setOpen(true)} className="mb-3 text-sm text-emerald-700 underline">+ Add an employee (not yet in Gusto)</button>;
  return (
    <div className="mb-3 rounded-lg border border-dashed border-neutral-300 p-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">New employee — Gusto can be matched later (Gusto wins the spelling)</div>
      <div className="grid grid-cols-2 gap-2">
        <input placeholder="First name" value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
        <input placeholder="Last name" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
        <input placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
        <input placeholder="Phone (optional)" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
        <select value={f.homeLocationId} onChange={(e) => setF({ ...f, homeLocationId: e.target.value })} className="rounded border border-neutral-300 px-2 py-1.5 text-sm bg-white"><option value="">Home location…</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.short_name}</option>)}</select>
        <select value={f.homeDepartmentId} onChange={(e) => setF({ ...f, homeDepartmentId: e.target.value })} className="rounded border border-neutral-300 px-2 py-1.5 text-sm bg-white"><option value="">Home department…</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select>
      </div>
      {err && <div className="text-sm text-red-600 mt-2">{err}</div>}
      <div className="flex gap-2 mt-2">
        <button disabled={busy} onClick={submit} className="rounded bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50">Create</button>
        <button onClick={() => setOpen(false)} className="rounded border border-neutral-300 px-3 py-1.5 text-sm">Cancel</button>
      </div>
    </div>
  );
}

// ---- Payroll ---------------------------------------------------------------
function Payroll() {
  const pp = payPeriodFor(new Date());
  // Restore the last preview so minimizing or leaving the app doesn't wipe it —
  // the owner no longer has to re-pick the dates and reload after coming back.
  const SAVED_KEY = 'brand-payroll-preview-v1';
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(SAVED_KEY) || 'null'); } catch { return null; } })();
  // A deep link can preselect the pay period (e.g. ?start=2026-09-07&end=2026-09-20)
  // and auto-load the preview — used for the "run payroll" link posted to Team Chat
  // so it opens exactly on the right period with no date-picking.
  const _url = new URLSearchParams(window.location.search);
  const _uStart = _url.get('start'), _uEnd = _url.get('end');
  const _isYmd = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const deepLink = _isYmd(_uStart) && _isYmd(_uEnd);
  const [start, setStart] = useState<string>(deepLink ? _uStart! : (saved?.start ?? pp.start));
  const [end, setEnd] = useState<string>(deepLink ? _uEnd! : (saved?.end ?? pp.end));
  const [data, setData] = useState<PayrollPreview | null>(deepLink ? null : (saved?.data ?? null));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>(saved?.sort ?? { key: 'last_name', dir: 1 });
  const [overnight, setOvernight] = useState<OvernightSpan[]>([]);
  const [view, setView] = useState<'totals' | 'punches'>(saved?.view ?? 'totals');
  const [review, setReview] = useState<PeriodRow[] | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  // Locations/roles for the inline editor on the all-punches review (loaded once,
  // only when that view is first opened).
  const [meta, setMeta] = useState<{ locs: Array<{ id: string; name: string }>; depts: Array<{ id: string; name: string }> } | null>(null);
  useEffect(() => {
    if (view === 'punches' && !meta) {
      adminBootstrap().then((b) => setMeta({ locs: b.locations.map((x) => ({ id: x.id, name: x.short_name })), depts: b.departments.map((x) => ({ id: x.id, name: x.title })) })).catch(() => {});
    }
  }, [view, meta]);
  useEffect(() => {
    try { sessionStorage.setItem(SAVED_KEY, JSON.stringify({ start, end, data, sort, view })); } catch { /* storage full — non-fatal */ }
  }, [start, end, data, sort, view]);
  const loadReview = async () => {
    setReviewBusy(true); setErr(null);
    try { const r = await periodReview(start, end); setReview(r.rows); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setReviewBusy(false); }
  };
  const showPunches = (v: boolean) => setView(v ? 'punches' : 'totals');
  // Auto-load the all-punches review whenever it's the active view, and reload
  // it when the dates change — so switching to it (or changing the period)
  // always shows data instead of a stale "tap to load" prompt.
  useEffect(() => {
    if (view === 'punches') loadReview(); else setReview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, view]);

  const PAYROLL_COLS: Array<{ key: string; label: string; num?: boolean; align?: string }> = [
    { key: 'last_name', label: 'Last name' },
    { key: 'first_name', label: 'First name' },
    { key: 'job_title', label: 'Job (Gusto)' },
    { key: 'total', label: 'Total', num: true },
    { key: 'regular_seconds', label: 'Reg', num: true },
    { key: 'overtime_seconds', label: 'OT', num: true },
    { key: 'paycheck_tips', label: 'Tips $', num: true },
    { key: 'extras_other', label: 'Extras $', num: true },
    { key: 'location', label: 'Location' },
    { key: 'department', label: 'Dept' },
    { key: 'exceptions', label: 'Flags' },
  ];
  const sortedRows = useMemo(() => {
    if (!data) return [];
    const num = PAYROLL_COLS.find((c) => c.key === sort.key)?.num;
    const val = (r: any, k: string) => k === 'total' ? (Number(r.regular_seconds) || 0) + (Number(r.overtime_seconds) || 0) : r[k];
    return [...data.rows].sort((a, b) => {
      const av = val(a, sort.key), bv = val(b, sort.key);
      const cmp = num ? (Number(av) || 0) - (Number(bv) || 0) : String(av ?? '').localeCompare(String(bv ?? ''));
      return cmp * sort.dir;
    });
  }, [data, sort]);
  const toggleSort = (key: string) => setSort((s) => s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 });

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      setData(await payrollExport(start, end));
      try { const o = await overnightSpans(start, end); setOvernight(o.rows); } catch { setOvernight([]); }
    }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };
  // Always (re)compute the Gusto export when the Payroll screen opens, when the
  // dates change, or when returning to the Totals view — so it NEVER shows a
  // stale copy after you've added or fixed hours. (It used to cache the last run
  // and only refresh on a manual click, which hid freshly-added hours — e.g. you
  // add someone's shift, come back here, and the old totals are still showing.)
  useEffect(() => {
    if (view === 'totals') run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, view]);
  const download = () => {
    if (!data) return;
    const blob = new Blob([data.csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `brand-payroll-${start}_to_${end}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  };

  const periods = useMemo(() => listPayPeriods(new Date(), 6, 1).reverse(), []);
  const selectPeriod = (p: { start: string; end: string }) => { setStart(p.start); setEnd(p.end); };

  return (
    <Card>
      <h2 className="font-semibold text-brand-ink mb-3">Payroll — pay period preview</h2>
      <PayrollChecklist />
      <div className="mb-3">
        <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">Pay periods (aligned to Gusto)</div>
        <div className="flex flex-wrap gap-2">
          {periods.map((p) => {
            const active = p.start === start && p.end === end;
            return (
              <button key={p.start} onClick={() => selectPeriod(p)}
                className={['rounded-full px-3 py-1.5 text-sm border', active ? 'bg-brand-ink text-white border-brand-ink' : 'bg-white border-neutral-300 text-neutral-700'].join(' ')}>
                {payPeriodLabel(p)}{p.isCurrent ? ' · current' : ''}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3 mb-3">
        <label className="text-sm">Start<input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="block rounded-lg border border-neutral-300 px-2 py-1 mt-1" /></label>
        <label className="text-sm">End<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="block rounded-lg border border-neutral-300 px-2 py-1 mt-1" /></label>
        <span className="text-xs text-neutral-400 self-center">or pick a custom range</span>
        <button onClick={run} disabled={busy} className="rounded-lg bg-brand-ink text-white px-4 py-2 text-sm font-medium disabled:opacity-60">{busy ? 'Computing…' : 'Preview hours'}</button>
        {data && <button onClick={download} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium">Download Gusto CSV</button>}
      </div>
      <div className="inline-flex rounded-lg border border-neutral-300 overflow-hidden mb-3 text-sm">
        <button onClick={() => showPunches(false)} className={`px-3 py-1.5 ${view === 'totals' ? 'bg-brand-ink text-white' : 'bg-white text-neutral-700'}`}>Totals (for Gusto)</button>
        <button onClick={() => showPunches(true)} className={`px-3 py-1.5 border-l border-neutral-300 ${view === 'punches' ? 'bg-brand-ink text-white' : 'bg-white text-neutral-700'}`}>All punches (by day)</button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {view === 'punches' && (
        reviewBusy ? <p className="text-sm text-neutral-400">Loading everyone’s punches…</p>
          : review ? <PunchReview rows={review} meta={meta} start={start} end={end} onChanged={() => { loadReview(); if (data) run(); }} />
          : <p className="text-sm text-neutral-400">Loading…</p>
      )}
      {view === 'totals' && data && overnight.length > 0 && (
        <div className="mb-3 rounded-xl border border-red-300 bg-red-50 p-3">
          <div className="font-semibold text-red-800 text-sm">🌙 {overnight.length} overnight span{overnight.length === 1 ? '' : 's'} — someone forgot to clock out</div>
          <p className="text-xs text-red-700 mt-0.5 mb-2">A clock-in on one day paired with a clock-out the next day. Shifts are not expected to run overnight, so these are almost always a forgotten clock-out. They are <b>NOT counted in the totals above</b> until fixed. The employee is auto-texted for the real clock-out time each morning; fix each one in the <b>Timesheet</b> or <b>Timecards</b> tab.</p>
          <div className="flex flex-col divide-y divide-red-200">
            {overnight.map((r) => (
              <div key={`${r.employee_id}|${r.in_day}`} className="flex items-center gap-3 py-1.5 text-sm">
                <span className="font-medium flex-1 min-w-0 truncate">{r.name}</span>
                <span className="text-red-700 tabular-nums whitespace-nowrap">in {r.in_label} → out {r.out_label} ({r.hours.toFixed(1)}h)</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {view === 'totals' && data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
            <Stat label="Employees" value={String(data.preview.employees)} />
            <Stat label="Job lines" value={String(data.preview.jobLines)} />
            <Stat label="Regular hrs" value={data.preview.regularHours.toFixed(2)} />
            <Stat label="Overtime hrs" value={data.preview.overtimeHours.toFixed(2)} />
            <Stat label="Exceptions" value={String(data.preview.exceptions)} />
          </div>
          <p className="text-xs text-neutral-400 -mt-1 mb-2">A person who works more than one job shows one <b>line per job</b> (that's how Gusto imports them) — so job lines can exceed the employee count.{data.preview.excludedNonGusto ? ` ${data.preview.excludedNonGusto} non-Gusto person(s) excluded from this export.` : ''}{data.preview.unmatchedJobs ? <span className="text-amber-600"> {data.preview.unmatchedJobs} line(s) had no matching Gusto job (flagged NO_GUSTO_JOB) — add that job in Gusto so it imports correctly.</span> : null}</p>
          {data.preview.extras ? (
            <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 text-sm">
              <div className="font-semibold text-emerald-800">💵 Dashboard extras ride this file — no manual entry needed</div>
              <p className="text-xs text-emerald-700 mt-0.5">
                {data.preview.extras.people} people · ${data.preview.extras.total.toFixed(2)} total: {Object.entries(data.preview.extras.totalsByEarning).map(([n, v]) => `${n} $${v.toFixed(2)}`).join(' · ')} (from the Team Payroll Performance report — Boulevard card tips + Add’l pay, on the Gusto line item of the same name).
              </p>
              {data.preview.extras.unmatched.length > 0 && (
                <p className="text-xs text-amber-700 mt-1">⚠️ Couldn’t match to a Gusto employee — enter these by hand: {data.preview.extras.unmatched.join(', ')}.</p>
              )}
              {data.preview.extras.manualOnly.length > 0 && (
                <p className="text-xs text-amber-700 mt-1">✋ Still manual in Gusto (hours-based or “other”): {data.preview.extras.manualOnly.map((m) => `${m.person} — ${m.category} $${m.amount.toFixed(2)}`).join('; ')}.</p>
              )}
              {(data.preview.extras.excludedPaid?.length ?? 0) > 0 && (
                <p className="text-xs text-neutral-500 mt-1">🚫 Left OFF this file — already paid (e.g. off-cycle), ${data.preview.extras.excludedPaid!.reduce((a, x) => a + x.amount, 0).toFixed(2)} total: {data.preview.extras.excludedPaid!.map((x) => `${x.person} $${x.amount.toFixed(2)}`).join(' · ')}. Do NOT add these in Gusto.</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-amber-600 -mt-1 mb-2">Dashboard extras (tips / bonus / commission) aren’t available for this range — the file is hours-only. On the Team Payroll Performance report, pick this pay period and press ⟳ Sync, then re-preview here.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[980px]">
              <thead>
                <tr className="text-left text-neutral-500">
                  {PAYROLL_COLS.map((c) => (
                    <th key={c.key} className="py-1">
                      <button onClick={() => toggleSort(c.key)} className="inline-flex items-center gap-1 hover:text-brand-ink font-medium">
                        {c.label}<span className="text-[10px]">{sort.key === c.key ? (sort.dir === 1 ? '▲' : '▼') : '↕'}</span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r, i) => (
                  <tr key={i} className="border-t border-neutral-100">
                    <td className="py-2 font-medium">{String(r.last_name ?? '')}</td>
                    <td className="py-2">{String(r.first_name ?? '')}</td>
                    <td>{String(r.job_title ?? '')}{r.title_source === 'constructed' ? <span title="No exact Gusto job matched — name built from role + salon" className="text-amber-500"> *</span> : null}</td>
                    <td className="tabular-nums font-semibold">{((Number(r.regular_seconds) + Number(r.overtime_seconds)) / 3600).toFixed(2)}</td>
                    <td className="tabular-nums">{(Number(r.regular_seconds) / 3600).toFixed(2)}</td>
                    <td className="tabular-nums">{(Number(r.overtime_seconds) / 3600).toFixed(2)}</td>
                    <td className="tabular-nums">{r.paycheck_tips ? `$${Number(r.paycheck_tips).toFixed(2)}` : ''}</td>
                    <td className="tabular-nums" title={r.extras ? Object.entries(r.extras as Record<string, number>).filter(([n]) => n !== 'Paycheck Tips').map(([n, v]) => `${n}: $${v.toFixed(2)}`).join('\n') : undefined}>{r.extras_other ? `$${Number(r.extras_other).toFixed(2)}` : ''}</td>
                    <td>{String(r.location ?? '')}</td><td>{String(r.department ?? '')}</td>
                    <td className="text-amber-600">{String(r.exceptions ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-neutral-400 mt-3">Preview classifications for review. Gusto remains the payroll authority (rates and the final pay run live in Gusto, not here). OT = weekly hours over 40 (federal rule). <b>Job</b> is the exact Gusto job name we send (a <span className="text-amber-500">*</span> means no exact Gusto job matched — it was built from role+salon). The Gusto CSV carries hours <b>plus</b> the dashboard’s dollar extras (Paycheck Tips / Bonus / Commission); Gusto computes base pay from its own rates.</p>
        </>
      )}
    </Card>
  );
}

// All employees' daily clock in/out for the pay period, grouped by person —
// the "review everyone at once" view.
function PunchReview({ rows, meta, start, end, onChanged }: { rows: PeriodRow[]; meta: { locs: Array<{ id: string; name: string }>; depts: Array<{ id: string; name: string }> } | null; start: string; end: string; onChanged: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (rows.length === 0) return <p className="text-sm text-neutral-400">No punches in this period.</p>;
  const groups: Array<{ id: string; name: string; rows: PeriodRow[]; total: number }> = [];
  for (const r of rows) {
    let g = groups[groups.length - 1];
    if (!g || g.id !== r.employee_id) { g = { id: r.employee_id, name: `${r.last_name}, ${r.first_name}`, rows: [], total: 0 }; groups.push(g); }
    g.rows.push(r); g.total += r.hours;
  }
  const grand = Math.round(rows.reduce((s, r) => s + r.hours, 0) * 100) / 100;
  const srcTag = (s: string) => s === 'Team Time Clock' ? <span className="text-emerald-600">Team Time Clock</span> : <span className="text-neutral-400">{s}</span>;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs text-neutral-500">{groups.length} employees · every day’s clock in/out for this period. Team Time Clock wins any day someone clocked here. <span className="text-red-600 font-medium">Red 🌙</span> = clocked out 8:30 PM or later.</p>
        <span className="text-sm font-semibold text-brand-ink">Total {grand.toFixed(2)} h</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead><tr className="text-left text-neutral-500"><th className="py-1">Employee</th><th>Day</th><th>Date</th><th>In</th><th>Out</th><th className="text-right">Hours</th><th>Source</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.id}>
                <tr className="border-t border-neutral-200 bg-neutral-50"><td className="py-1.5 font-semibold" colSpan={5}>{g.name} <span className="text-neutral-400 font-normal text-xs">· {g.rows.length} day{g.rows.length === 1 ? '' : 's'}</span></td><td className="py-1.5 text-right font-bold tabular-nums">{g.total.toFixed(2)}<span className="text-neutral-400 font-normal text-xs"> h</span></td><td className="py-1.5 text-right pr-1"><button onClick={() => setOpenId(openId === g.id ? null : g.id)} className="text-blue-600 underline text-xs whitespace-nowrap">{openId === g.id ? 'close' : '✎ fix'}</button></td></tr>
                {g.rows.map((r, i) => (
                  <tr key={i} className="border-t border-neutral-100">
                    <td></td>
                    <td className="text-neutral-500">{r.weekday}</td>
                    <td className="tabular-nums">{fmtMD(r.date)}</td>
                    <td className="tabular-nums">{r.in_time ?? '—'}</td>
                    <td className="tabular-nums">{r.open ? <span className="text-amber-600">still in</span> : r.out_time
                      ? <span className={r.out_late ? 'text-red-600 font-semibold' : ''} title={r.out_late ? 'Clocked out 8:30 PM or later' : undefined}>{r.out_time}{r.out_late ? ' 🌙' : ''}</span>
                      : '—'}</td>
                    <td className="text-right tabular-nums font-medium">{r.hours.toFixed(2)}</td>
                    <td className="text-xs">{srcTag(r.source)}</td>
                  </tr>
                ))}
                {openId === g.id && (
                  <tr><td colSpan={7} className="p-2 bg-neutral-50">
                    {meta ? <EmployeePunchEditor employeeId={g.id} locs={meta.locs} depts={meta.depts} start={start} end={end} onChanged={onChanged} />
                      : <p className="text-sm text-neutral-400 px-2 py-1">Loading editor…</p>}
                  </td></tr>
                )}
              </Fragment>
            ))}
            <tr className="border-t-2 border-neutral-300"><td className="py-2 font-bold" colSpan={5}>Grand total</td><td className="py-2 text-right font-bold tabular-nums">{grand.toFixed(2)}</td><td></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
function fmtMD(d: string) { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }

// Simple tick-box checklist for running payroll — the whole process in order,
// progress saved so the owner can work through it and pick up where he left off.
function PayrollChecklist() {
  const KEY = 'brand-payroll-checklist-v3';
  const STEPS: Array<{ t: string; d: string }> = [
    { t: 'Review the punches', d: 'Payroll → pick the pay period → “All punches (by day)” and check everyone’s in/out. Team Time Clock is the only source of hours.' },
    { t: 'Do the corrections', d: 'Corrections tab → “Approve & fix” each request (it makes the change and approves it).' },
    { t: 'Sync the payroll dashboard', d: 'Open the Team Payroll Performance report, pick this pay period, and press “⟳ Sync this pay period”. That computes the tips, bonuses, commissions and PTO dollars that ride the Gusto file. Do this AFTER corrections and right before the next step — if hours change later, sync again.' },
    { t: 'Preview the totals', d: 'Back here on “Totals (for Gusto)”, press Preview hours. The GREEN BOX shows every dollar riding the file, line item by line item — if it shows an amber warning instead, the dashboard wasn’t synced: go back one step.' },
    { t: 'Download the Gusto file', d: 'Download Gusto CSV. One file: hours + all the dollars from the green box.' },
    { t: 'Import to Gusto', d: 'Gusto → Run Payroll → Smart Import → upload the file. In mapping: Location = (Unmatched) — NOT Vacation hours; Regular → Regular hours, Overtime → Overtime hours, and every dollar column maps to the Gusto earning with the SAME NAME (Paycheck Tips → Paycheck tips, Paid Time → Paid time, Missed Punch → Missed punch, Team Stylist Development → Team stylist development, …). Gusto remembers the mapping after the first time.' },
    { t: 'Add what’s still manual', d: 'Tips, bonuses, commission, PTO dollars and missed-punch pay now ride the import file (the green box lists the totals per line item). Still entered by hand in Gusto: “Hours to add” from the dashboard (extra HOURS, e.g. Boulevard hours for non-punchers) and anything the green box flags as unmatched or manual. Recurring pay (Gray’s $250 Bonus, Gratitude Bonus, Leadership Bonus) lives in Gusto itself — the file correctly leaves it alone.' },
    { t: 'Submit payroll in Gusto', d: 'Review Gusto’s totals and submit the run.' },
  ];
  const [done, setDone] = useState<Set<number>>(() => { try { return new Set<number>(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); } });
  const [open, setOpen] = useState(true);
  const save = (n: Set<number>) => { try { localStorage.setItem(KEY, JSON.stringify([...n])); } catch { /* ignore */ } };
  const toggle = (i: number) => setDone((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); save(n); return n; });
  const reset = () => { const n = new Set<number>(); setDone(n); save(n); };
  return (
    <div className="mb-4 rounded-xl border border-neutral-200 border-l-4 border-l-emerald-500 bg-emerald-50/40 p-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between text-left">
        <span className="font-semibold text-brand-ink text-sm">✓ Payroll run checklist — how to run payroll, start to finish <span className="text-neutral-400 font-normal">· {done.size}/{STEPS.length} done</span></span>
        <span className="text-neutral-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-2.5">
          {STEPS.map((s, i) => (
            <label key={i} className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={done.has(i)} onChange={() => toggle(i)} className="mt-1 h-4 w-4 flex-none accent-emerald-600" />
              <span className="min-w-0">
                <span className={`text-sm font-medium ${done.has(i) ? 'line-through text-neutral-400' : 'text-brand-ink'}`}>{i + 1}. {s.t}</span>
                <span className="block text-xs text-neutral-500 mt-0.5">{s.d}</span>
              </span>
            </label>
          ))}
          <button onClick={reset} className="self-start text-xs text-neutral-500 underline mt-1">Reset for a new run</button>
        </div>
      )}
    </div>
  );
}

function ChangelogModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-white rounded-2xl p-5 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-brand-ink">What's new</h2>
          <button onClick={onClose} className="text-neutral-400 text-2xl leading-none">&times;</button>
        </div>
        <div className="text-xs text-neutral-400 mb-4">Currently running {APP_VERSION} · updated {BUILT_AT}</div>
        <div className="space-y-5">
          {CHANGELOG.map((r) => (
            <div key={r.version}>
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-brand-ink">v{r.version}</span>
                <span className="text-xs text-neutral-400">{r.date}</span>
              </div>
              <ul className="list-disc list-inside text-sm text-neutral-700 mt-1 space-y-0.5">
                {r.changes.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          ))}
        </div>
        <button onClick={onClose} className="w-full rounded-xl bg-brand-ink text-white py-3 font-medium mt-5">Close</button>
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">{children}</div>;
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-neutral-50 border border-neutral-200 px-3 py-2"><div className="text-xs text-neutral-500">{label}</div><div className="text-xl font-bold text-brand-ink tabular-nums">{value}</div></div>;
}
