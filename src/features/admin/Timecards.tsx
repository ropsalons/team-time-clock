import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { adminAction, adminBootstrap, timecardDetail } from '../../lib/api';
import { deriveSegments, computePayrollTotals } from '../../lib/domain/segments';
import { secondsToDecimalHours, payPeriodFor } from '../../lib/time';
import type { StoredEvent } from '../../lib/domain/punch';

interface Emp { id: string; first_name: string; last_name: string; home_location_id: string | null; home_department_id: string | null }
interface Ev { id: string; event_type: string; server_ts: string; location_id: string | null; department_id: string | null; source: string; correction_reason: string | null }
interface Opt { id: string; name: string }

export default function Timecards() {
  const pp = payPeriodFor(new Date());
  // Remember the person + dates so leaving Timecards and coming back doesn't wipe
  // your selection (a big time-sink during payroll).
  const TC_KEY = 'brand-timecards-v1';
  const tcSaved = (() => { try { return JSON.parse(sessionStorage.getItem(TC_KEY) || 'null'); } catch { return null; } })();
  const [emps, setEmps] = useState<Emp[]>([]);
  const [locs, setLocs] = useState<Opt[]>([]);
  const [depts, setDepts] = useState<Opt[]>([]);
  const [empId, setEmpId] = useState<string>(tcSaved?.empId ?? '');
  const [start, setStart] = useState<string>(tcSaved?.start ?? pp.start);
  const [end, setEnd] = useState<string>(tcSaved?.end ?? pp.end);
  const [events, setEvents] = useState<Ev[]>([]);
  const [approval, setApproval] = useState<{ state: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  useEffect(() => { try { sessionStorage.setItem(TC_KEY, JSON.stringify({ empId, start, end })); } catch { /* ignore */ } }, [empId, start, end]);

  useEffect(() => {
    (async () => {
      const b = await adminBootstrap();
      // Only current staff — never show people terminated in Gusto (or disabled) in the timecard picker.
      const INACTIVE = new Set(['terminated_in_gusto', 'disabled']);
      setEmps(b.employees.filter((e) => !INACTIVE.has(e.timekeeping_access)).map((e) => ({ id: e.id, first_name: e.first_name, last_name: e.last_name, home_location_id: e.home_location_id, home_department_id: e.home_department_id })));
      setLocs(b.locations.map((x) => ({ id: x.id, name: x.short_name })));
      setDepts(b.departments.map((x) => ({ id: x.id, name: x.title })));
    })().catch(() => {});
  }, []);

  const [ppId, setPpId] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!empId) { setEvents([]); setApproval(null); setPpId(null); return; }
    const r = await timecardDetail(empId, start, end);
    setEvents((r.events as Ev[]) ?? []);
    setApproval(r.approval);
    setPpId(r.payPeriodId);
  }, [empId, start, end]);

  useEffect(() => { load(); }, [load]);

  const act = async (body: Record<string, unknown>, ok = 'Done') => {
    setBusy(true); setMsg(null);
    try { await adminAction(body); setMsg(ok); await load(); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };

  const locName = (id: string | null) => locs.find((o) => o.id === id)?.name ?? '—';
  const deptName = (id: string | null) => depts.find((o) => o.id === id)?.name ?? '—';
  const totals = useMemo(() => {
    const segs = deriveSegments(events as unknown as StoredEvent[]);
    return computePayrollTotals(segs);
  }, [events]);

  const periodTotal = useMemo(() => ({ total: (totals.regularSeconds + totals.overtimeSeconds) / 3600 }), [totals]);

  const payPeriodId = () => ppId;

  const saveEdit = async (ev: Ev, patch: { newTs: string; locationId: string | null; departmentId: string | null; reason: string }) => {
    await act({ type: 'edit_punch', eventId: ev.id, newTs: patch.newTs, locationId: patch.locationId, departmentId: patch.departmentId, reason: patch.reason });
    setEditId(null);
  };
  const voidPunch = async (ev: Ev) => {
    if (!window.confirm('Remove this punch? The original is kept in history.')) return;
    await act({ type: 'void_punch', eventId: ev.id, reason: 'admin adjustment' });
  };

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
      <h2 className="font-semibold text-brand-ink mb-3">Timecards — review & edit</h2>
      <div className="flex flex-wrap items-end gap-3 mb-3">
        <label className="text-sm">Employee
          <select value={empId} onChange={(e) => setEmpId(e.target.value)} className="block rounded-lg border border-neutral-300 px-2 py-1 mt-1 min-w-[180px]">
            <option value="">Select…</option>
            {emps.map((e) => <option key={e.id} value={e.id}>{e.last_name}, {e.first_name}</option>)}
          </select>
        </label>
        <label className="text-sm">Start<input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="block rounded-lg border border-neutral-300 px-2 py-1 mt-1" /></label>
        <label className="text-sm">End<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="block rounded-lg border border-neutral-300 px-2 py-1 mt-1" /></label>
      </div>

      {empId && (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
            <span className="rounded-lg bg-brand-ink text-white px-3 py-1">Period total <b>{periodTotal.total.toFixed(2)}h</b></span>
            <span className="rounded-lg bg-neutral-50 border border-neutral-200 px-3 py-1">Team Time Clock <b>{secondsToDecimalHours(totals.regularSeconds + totals.overtimeSeconds)}h</b></span>
            <span className="text-neutral-400 text-xs">Team Time Clock = Reg {secondsToDecimalHours(totals.regularSeconds)}h · OT {secondsToDecimalHours(totals.overtimeSeconds)}h</span>
            {totals.hasOpenSegment && <span className="text-amber-600">open shift in range</span>}
            <span className="ml-auto text-neutral-500">Timecard: <b>{approval?.state ?? 'open'}</b></span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[620px]">
              <thead><tr className="text-left text-neutral-500"><th className="py-1">Time (ET)</th><th>Type</th><th>Location</th><th>Dept</th><th>Source</th><th></th></tr></thead>
              <tbody>
                {events.length === 0 && <tr><td colSpan={6} className="py-3 text-neutral-400">No punches in this range.</td></tr>}
                {events.map((ev) => (
                  <Fragment key={ev.id}>
                    <tr className="border-t border-neutral-100">
                      <td className="py-2 tabular-nums">{fmt(ev.server_ts)}</td>
                      <td>{ev.event_type.replace(/_/g, ' ')}</td>
                      <td>{locName(ev.location_id)}</td><td>{deptName(ev.department_id)}</td>
                      <td className="text-neutral-400">{ev.source}{ev.correction_reason ? ' *' : ''}</td>
                      <td className="text-right whitespace-nowrap">
                        <button onClick={() => setEditId(editId === ev.id ? null : ev.id)} disabled={busy} className="text-blue-600 underline mr-3">{editId === ev.id ? 'close' : 'edit'}</button>
                        <button onClick={() => voidPunch(ev)} disabled={busy} className="text-red-600 underline">remove</button>
                      </td>
                    </tr>
                    {editId === ev.id && (
                      <PunchEditor ev={ev} locs={locs} depts={depts} busy={busy}
                        onSave={(patch) => saveEdit(ev, patch)} onCancel={() => setEditId(null)} />
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <ManualPunch locs={locs} depts={depts} busy={busy} onAdd={(b) => act({ ...b, employeeId: empId }, 'Punch added')} defaultDate={start} />

          <div className="flex flex-wrap gap-2 mt-4">
            <button disabled={busy} onClick={async () => act({ type: 'approve_timecard', employeeId: empId, payPeriodId: await payPeriodId() }, 'Approved')}
              className="rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-60">Approve</button>
            <button disabled={busy} onClick={async () => act({ type: 'lock_timecard', employeeId: empId, payPeriodId: await payPeriodId() }, 'Locked')}
              className="rounded-lg bg-brand-ink text-white px-4 py-2 text-sm font-medium disabled:opacity-60">Lock</button>
            <button disabled={busy} onClick={async () => { const r = window.prompt('Reason to reopen:'); if (r) act({ type: 'reopen_timecard', employeeId: empId, payPeriodId: await payPeriodId(), reason: r }, 'Reopened'); }}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium disabled:opacity-60">Reopen</button>
            {msg && <span className="self-center text-sm text-neutral-600">{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function ManualPunch({ locs, depts, busy, onAdd, defaultDate }: { locs: Opt[]; depts: Opt[]; busy: boolean; onAdd: (b: Record<string, unknown>) => void; defaultDate: string }) {
  const [type, setType] = useState<'clock_in' | 'clock_out'>('clock_in');
  const [when, setWhen] = useState(`${defaultDate}T09:00`);
  const [loc, setLoc] = useState('');
  const [dept, setDept] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div className="mt-4 rounded-lg border border-dashed border-neutral-300 p-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">Add a manual punch</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">Type<select value={type} onChange={(e) => setType(e.target.value as any)} className="block rounded border border-neutral-300 px-2 py-1 mt-1"><option value="clock_in">Clock in</option><option value="clock_out">Clock out</option></select></label>
        <label className="text-sm">When (ET)<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1" /></label>
        <label className="text-sm">Location<select value={loc} onChange={(e) => setLoc(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1"><option value="">—</option>{locs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <label className="text-sm">Dept<select value={dept} onChange={(e) => setDept(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1"><option value="">—</option>{depts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="rounded border border-neutral-300 px-2 py-1 text-sm flex-1 min-w-[120px]" />
        <button disabled={busy} onClick={() => onAdd({ type: 'manual_punch', eventType: type, effectiveTs: fromLocalInput(when), locationId: loc || null, departmentId: dept || null, reason })}
          className="rounded bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50">Add</button>
      </div>
      <p className="text-xs text-neutral-400 mt-2">Times are entered in salon (Eastern) time. The original is never deleted — edits keep full history.</p>
    </div>
  );
}

// ---- Inline punch editor (replaces the old prompt() boxes) --------------------
function PunchEditor({ ev, locs, depts, busy, onSave, onCancel }: {
  ev: Ev; locs: Opt[]; depts: Opt[]; busy: boolean;
  onSave: (patch: { newTs: string; locationId: string | null; departmentId: string | null; reason: string }) => void;
  onCancel: () => void;
}) {
  const [when, setWhen] = useState(toLocalInput(ev.server_ts));
  const [loc, setLoc] = useState(ev.location_id ?? '');
  const [dept, setDept] = useState(ev.department_id ?? '');
  const [reason, setReason] = useState('');
  return (
    <tr className="bg-amber-50/60 border-t border-neutral-100">
      <td colSpan={6} className="p-3">
        <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">Edit this {ev.event_type.replace(/_/g, ' ')}</div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">Time (ET)<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1" /></label>
          <label className="text-sm">Location<select value={loc} onChange={(e) => setLoc(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1"><option value="">—</option>{locs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          <label className="text-sm">Dept<select value={dept} onChange={(e) => setDept(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1"><option value="">—</option>{depts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="rounded border border-neutral-300 px-2 py-1 text-sm flex-1 min-w-[140px]" />
          <button disabled={busy} onClick={() => onSave({ newTs: fromLocalInput(when), locationId: loc || null, departmentId: dept || null, reason: reason.trim() })}
            className="rounded bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50">Save</button>
          <button onClick={onCancel} className="rounded border border-neutral-300 px-3 py-1.5 text-sm">Cancel</button>
        </div>
        <p className="text-xs text-neutral-400 mt-2">Salon (Eastern) time. The original punch is kept — edits never destroy history.</p>
      </td>
    </tr>
  );
}

// ---- Reusable per-employee punch editor -------------------------------------
// Used inline on the all-employees payroll review so an admin can fix anyone's
// punches (edit a time, add a missing in/out, remove one) without leaving the
// page or searching person by person. Self-contained: loads its own punches and
// calls onChanged after every save so the parent can refresh totals.
export function EmployeeEditor({ employeeId, locs, depts, start, end, onChanged }: {
  employeeId: string; locs: Opt[]; depts: Opt[]; start: string; end: string; onChanged?: () => void;
}) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await timecardDetail(employeeId, start, end); setEvents(r.events as Ev[]); }
    finally { setLoading(false); }
  }, [employeeId, start, end]);
  useEffect(() => { load(); }, [load]);
  const act = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await adminAction(body); setMsg(ok); await load(); onChanged?.(); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };
  const locName = (id: string | null) => locs.find((o) => o.id === id)?.name ?? '—';
  const deptName = (id: string | null) => depts.find((o) => o.id === id)?.name ?? '—';
  const saveEdit = (ev: Ev, patch: { newTs: string; locationId: string | null; departmentId: string | null; reason: string }) => { setEditId(null); act({ type: 'edit_punch', eventId: ev.id, ...patch }, '✓ Saved.'); };
  const voidPunch = (ev: Ev) => { if (window.confirm('Remove this punch? The original is kept in history.')) act({ type: 'void_punch', eventId: ev.id, reason: 'admin adjustment' }, '✓ Removed.'); };
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3 my-1">
      {msg && <div className="text-xs text-emerald-700 font-medium mb-2">{msg}</div>}
      {loading ? <p className="text-sm text-neutral-400">Loading punches…</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[520px]">
            <thead><tr className="text-left text-neutral-500"><th className="py-1 px-1">Time (ET)</th><th>Type</th><th>Location</th><th>Dept</th><th></th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={5} className="py-2 px-1 text-neutral-400">No Team Time Clock punches this period. Use “Add a manual punch” below to add the shift.</td></tr>}
              {events.map((ev) => (
                <Fragment key={ev.id}>
                  <tr className="border-t border-neutral-100">
                    <td className="py-1.5 px-1 tabular-nums">{fmt(ev.server_ts)}</td>
                    <td>{ev.event_type.replace(/_/g, ' ')}</td>
                    <td>{locName(ev.location_id)}</td><td>{deptName(ev.department_id)}</td>
                    <td className="text-right whitespace-nowrap pr-1">
                      <button onClick={() => setEditId(editId === ev.id ? null : ev.id)} disabled={busy} className="text-blue-600 underline mr-3">{editId === ev.id ? 'close' : 'edit'}</button>
                      <button onClick={() => voidPunch(ev)} disabled={busy} className="text-red-600 underline">remove</button>
                    </td>
                  </tr>
                  {editId === ev.id && <PunchEditor ev={ev} locs={locs} depts={depts} busy={busy} onSave={(patch) => saveEdit(ev, patch)} onCancel={() => setEditId(null)} />}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ManualPunch locs={locs} depts={depts} busy={busy} onAdd={(b) => act({ ...b, employeeId }, '✓ Punch added.')} defaultDate={start} />
    </div>
  );
}

function fmt(iso: string) { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); }
function toLocalInput(iso: string) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}
// Interpret a datetime-local string as Eastern time and return a UTC ISO string.
function fromLocalInput(local: string): string {
  // Determine ET offset for that date (EDT -04 mar–nov, EST -05 otherwise) via a probe.
  const naive = new Date(`${local}:00Z`); // treat as UTC first
  const etName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(naive).find((p) => p.type === 'timeZoneName')?.value;
  const offset = etName === 'EST' ? '-05:00' : '-04:00';
  return new Date(`${local}:00${offset}`).toISOString();
}
