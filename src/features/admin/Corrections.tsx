import { useCallback, useEffect, useState } from 'react';
import { adminAction, applyCorrection, correctionsList } from '../../lib/api';

interface Req {
  id: string; employee_id: string; kind: string; requested_ts: string | null;
  requested_location_id: string | null; requested_department_id: string | null;
  target_event_id: string | null; explanation: string; status: string; created_at: string;
  applied_ts: string | null; applied_source: string | null;
}
const SOURCE_LABEL: Record<string, string> = {
  offline_punch: 'Offline punch (exact device time)',
  employee_explicit_time: 'Time the employee stated in their note',
  requested_time: 'Time the employee entered on the form',
  requested_location: 'Location the employee selected',
  requested_department: 'Role the employee selected',
  duplicate_removed: 'Duplicate punch removed (repair)',
  admin_entered: 'Time/details entered by you',
};
const EDITABLE_KINDS = ['missed_clock_in', 'missed_clock_out', 'incorrect_time', 'wrong_location', 'wrong_department'];
interface Opt { id: string; name: string }

export default function Corrections() {
  const [rows, setRows] = useState<Req[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  // Sort keys ("lastname\u0000firstname") so the list orders by last name, then first.
  const [nameSort, setNameSort] = useState<Record<string, string>>({});
  const [locs, setLocs] = useState<Opt[]>([]);
  const [depts, setDepts] = useState<Opt[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [flash, setFlash] = useState<Record<string, string>>({});
  const [allMsg, setAllMsg] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  // Which request has the inline "enter the time and apply" editor open (only
  // needed when a request came in with no time of its own).
  const [fixId, setFixId] = useState<string | null>(null);
  // Optional note-to-employee drafts, per request (reject is still one click).
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await correctionsList();
    setRows((r.requests as Req[]) ?? []);
    setLocs(r.locations.map((x) => ({ id: x.id, name: x.short_name })));
    setDepts(r.departments.map((x) => ({ id: x.id, name: x.title })));
    setNames(r.names ?? {});
    setNameSort(r.nameSort ?? {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const locName = (id: string | null) => locs.find((o) => o.id === id)?.name;
  const deptName = (id: string | null) => depts.find((o) => o.id === id)?.name;
  const whenET = (ts: string | null) => ts ? new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  // The DAY being corrected (weekday + date) — shown big so it's unmistakable
  // which shift this is, separate from when the request was submitted.
  const workDate = (ts: string | null) => ts ? new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }) : null;

  // Plain-English "what will happen" for the admin.
  const proposal = (r: Req): string => {
    const t = whenET(r.requested_ts);
    switch (r.kind) {
      case 'incorrect_time': return t ? `Change this punch to ${t}.` : 'Fix the punch time (no time given — needs a manual fix).';
      case 'missed_clock_in': return t ? `Add a missing clock-in at ${t}${locName(r.requested_location_id) ? ` · ${locName(r.requested_location_id)}` : ''}.` : 'Add a missing clock-in (no time given — needs a manual fix).';
      case 'missed_clock_out': return t ? `Add a missing clock-out at ${t}.` : 'Add a missing clock-out (no time given — needs a manual fix).';
      case 'wrong_location': return locName(r.requested_location_id) ? `Change this punch's salon to ${locName(r.requested_location_id)}.` : 'Change the salon (none given — needs a manual fix).';
      case 'wrong_department': return deptName(r.requested_department_id) ? `Change this punch's role to ${deptName(r.requested_department_id)}.` : 'Change the role (none given — needs a manual fix).';
      default: return 'Needs a hands-on fix — open the employee in Timecards.';
    }
  };

  // Single explicit approve: apply the employee's requested time as-is (force).
  // If the request had no time to apply, open the inline editor instead of
  // sending the admin off to Timecards.
  const approveFix = async (r: Req) => {
    setBusy(r.id); setFlash((f) => ({ ...f, [r.id]: '' }));
    try {
      const res = await applyCorrection(r.id, { force: true });
      if (res.applied) { setFixId(null); setFlash((f) => ({ ...f, [r.id]: '✓ Fixed & approved.' })); await load(); }
      else if (EDITABLE_KINDS.includes(r.kind)) { setFixId(r.id); setFlash((f) => ({ ...f, [r.id]: res.message || 'Enter the correct details below and apply.' })); }
      else setFlash((f) => ({ ...f, [r.id]: res.message || 'Open Timecards for a hands-on fix.' }));
    } catch (e) { setFlash((f) => ({ ...f, [r.id]: e instanceof Error ? e.message : 'Failed' })); }
    finally { setBusy(null); }
  };

  // Apply the admin's inline-entered time/salon/role for a request that had none.
  const applyWithEntered = async (r: Req, over: { overrideTs?: string; overrideLocationId?: string | null; overrideDepartmentId?: string | null }) => {
    setBusy(r.id);
    try {
      const res = await applyCorrection(r.id, { force: true, ...over });
      if (res.applied) { setFixId(null); setFlash((f) => ({ ...f, [r.id]: '✓ Fixed & approved.' })); await load(); }
      else setFlash((f) => ({ ...f, [r.id]: res.message || 'Still needs a time.' }));
    } catch (e) { setFlash((f) => ({ ...f, [r.id]: e instanceof Error ? e.message : 'Failed' })); }
    finally { setBusy(null); }
  };

  // One click: apply every pending request the engine can safely handle. The rest
  // stay put, flagged, for a quick manual look — nothing risky is forced through.
  const approveAllSafe = async () => {
    const targets = rows.filter((r) => r.status === 'pending');
    if (!targets.length) return;
    if (!window.confirm(`Approve & fix all ${targets.length} request(s) that can be applied safely?\n\nAnything the system isn't sure about is left for you to review — not forced through.`)) return;
    setRunningAll(true); setAllMsg(null); setFlash({});
    let applied = 0, review = 0, failed = 0;
    for (const r of targets) {
      try {
        const res = await applyCorrection(r.id);
        if (res.applied) applied++;
        else { review++; setFlash((f) => ({ ...f, [r.id]: res.message || 'Needs a quick look.' })); }
      } catch { failed++; setFlash((f) => ({ ...f, [r.id]: 'Errored — try individually.' })); }
    }
    await load();
    setRunningAll(false);
    setAllMsg(`✓ Fixed ${applied}.${review ? ` ${review} still need a quick look (flagged below).` : ''}${failed ? ` ${failed} errored.` : ''}`);
  };

  // One click — no popup. Sends the optional inline note if one was typed.
  const reject = async (r: Req) => {
    setBusy(r.id);
    try { await adminAction({ type: 'resolve_correction', correctionId: r.id, decision: 'rejected', note: notes[r.id] ?? '' }); await load(); }
    catch (e) { setFlash((f) => ({ ...f, [r.id]: e instanceof Error ? e.message : 'Failed' })); }
    finally { setBusy(null); }
  };

  // Group a person's requests together, alphabetical by name, then by day.
  // Sort by last name, then first (server-provided key); fall back to display name.
  const nameOf = (r: Req) => (nameSort[r.employee_id] ?? names[r.employee_id] ?? 'zzzz').toLowerCase();
  const visible = rows
    .filter((r) => showResolved || r.status === 'pending')
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || (a.requested_ts ?? a.created_at).localeCompare(b.requested_ts ?? b.created_at));
  const pending = rows.filter((r) => r.status === 'pending').length;

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h2 className="font-semibold text-brand-ink">Change requests {pending > 0 && <span className="ml-1 text-sm text-amber-600">({pending} to review)</span>}</h2>
        <div className="flex items-center gap-3">
          {pending > 0 && (
            <button disabled={runningAll} onClick={approveAllSafe} className="rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
              {runningAll ? 'Working…' : `Approve & fix all safe (${pending})`}
            </button>
          )}
          <label className="text-sm text-neutral-500 flex items-center gap-1"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> show resolved</label>
        </div>
      </div>
      {allMsg && <div className="mb-3 text-sm rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-2 font-medium">{allMsg}</div>}
      {visible.length === 0 ? <p className="text-neutral-500 text-sm">No {showResolved ? '' : 'open '}requests.</p> : (
        <ul className="divide-y divide-neutral-100">
          {visible.map((r) => {
            const needsLook = !!flash[r.id] && !flash[r.id].startsWith('✓');
            return (
            <li key={r.id} className={['py-3 px-2 -mx-2 rounded-lg', needsLook ? 'bg-amber-50/60' : ''].join(' ')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{names[r.employee_id] ?? 'Employee'}</span>
                    {workDate(r.requested_ts) && <span className="rounded-md bg-brand-ink text-white text-xs font-semibold px-2 py-0.5 tabular-nums">📅 {workDate(r.requested_ts)}</span>}
                    <span className="text-neutral-400 text-sm">· {r.kind.replace(/_/g, ' ')}</span>
                  </div>
                  {/* What one click will do */}
                  <div className="text-sm text-brand-ink mt-1 bg-emerald-50 border border-emerald-100 rounded-lg px-2.5 py-1.5 inline-block">{proposal(r)}</div>
                  <div className="text-sm text-neutral-600 mt-1">“{r.explanation}”</div>
                  <div className="text-xs text-neutral-400 mt-0.5">submitted {whenET(r.created_at)}</div>
                  {r.status === 'approved' && (r.applied_ts || r.applied_source) && (
                    <div className="mt-1.5 text-xs bg-neutral-50 border border-neutral-200 rounded-lg px-2.5 py-1.5 inline-block leading-relaxed">
                      <div><span className="text-neutral-400">Requested:</span> {r.kind.replace(/_/g, ' ')}{r.requested_ts ? ` · ${whenET(r.requested_ts)}` : ' · (no time given)'}</div>
                      {r.applied_ts && <div><span className="text-neutral-400">Applied:</span> <b>{whenET(r.applied_ts)}</b></div>}
                      {r.applied_source && <div><span className="text-neutral-400">Source:</span> {SOURCE_LABEL[r.applied_source] ?? r.applied_source}</div>}
                    </div>
                  )}
                  {flash[r.id] && <div className={['text-xs mt-1 font-medium', needsLook ? 'text-amber-700' : 'text-emerald-700'].join(' ')}>{needsLook ? '⚠ ' : ''}{flash[r.id]}</div>}
                </div>
                {r.status === 'pending' ? (
                  <div className="flex flex-col gap-1.5 whitespace-nowrap w-[150px]">
                    <button disabled={busy === r.id || runningAll} onClick={() => approveFix(r)} className="rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50">{busy === r.id ? 'Working…' : 'Approve & fix'}</button>
                    <button disabled={busy === r.id || runningAll} onClick={() => reject(r)} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50">Reject</button>
                    <input value={notes[r.id] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} placeholder="note (optional)" className="rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-600" />
                  </div>
                ) : <span className={['text-sm font-medium', r.status === 'approved' ? 'text-emerald-700' : 'text-neutral-400'].join(' ')}>{r.status}</span>}
              </div>
              {r.status === 'pending' && fixId === r.id && (
                <ApplyFix r={r} locs={locs} depts={depts} busy={busy === r.id}
                  onApply={(over) => applyWithEntered(r, over)} onCancel={() => setFixId(null)} />
              )}
            </li>
          );})}
        </ul>
      )}
      <p className="text-xs text-neutral-400 mt-3"><b>“Approve &amp; fix”</b> applies exactly what the employee requested and marks it approved — one click. If a request came in with no time, enter it right here and apply. <b>“Approve &amp; fix all safe”</b> does the whole list at once but only for requests it’s confident about; anything unclear stays flagged here. History is always kept.</p>
    </div>
  );
}

// Inline "enter the correct details and apply" editor — shown only when a
// request arrived with no time/salon/role of its own. Pre-fills anything the
// employee did provide so most cases are just Apply.
function ApplyFix({ r, locs, depts, busy, onApply, onCancel }: {
  r: Req; locs: Opt[]; depts: Opt[]; busy: boolean;
  onApply: (over: { overrideTs?: string; overrideLocationId?: string | null; overrideDepartmentId?: string | null }) => void;
  onCancel: () => void;
}) {
  const needsTime = r.kind === 'missed_clock_in' || r.kind === 'missed_clock_out' || r.kind === 'incorrect_time';
  const needsLoc = r.kind === 'missed_clock_in' || r.kind === 'missed_clock_out' || r.kind === 'wrong_location';
  const needsDept = r.kind === 'missed_clock_in' || r.kind === 'missed_clock_out' || r.kind === 'wrong_department';
  const [when, setWhen] = useState(r.requested_ts ? toLocalInput(r.requested_ts) : '');
  const [loc, setLoc] = useState(r.requested_location_id ?? '');
  const [dept, setDept] = useState(r.requested_department_id ?? '');
  const canApply = !needsTime || !!when;
  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500 mb-2">Enter the correct details and apply</div>
      <div className="flex flex-wrap items-end gap-2">
        {needsTime && <label className="text-sm">Time (ET)<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1" /></label>}
        {needsLoc && <label className="text-sm">Salon<select value={loc} onChange={(e) => setLoc(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1"><option value="">—</option>{locs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}
        {needsDept && <label className="text-sm">Role<select value={dept} onChange={(e) => setDept(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1"><option value="">—</option>{depts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}
        <button disabled={busy || !canApply} onClick={() => onApply({
          overrideTs: needsTime && when ? fromLocalInput(when) : undefined,
          overrideLocationId: needsLoc ? (loc || null) : undefined,
          overrideDepartmentId: needsDept ? (dept || null) : undefined,
        })} className="rounded bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50">{busy ? 'Working…' : 'Apply'}</button>
        <button onClick={onCancel} className="rounded border border-neutral-300 px-3 py-1.5 text-sm">Cancel</button>
      </div>
      <p className="text-xs text-neutral-400 mt-2">Salon (Eastern) time. History is always kept.</p>
    </div>
  );
}

// datetime-local <-> ET ISO (mirrors the Timecards editor's converters).
function toLocalInput(iso: string) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}
function fromLocalInput(local: string): string {
  const naive = new Date(`${local}:00Z`);
  const etName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(naive).find((p) => p.type === 'timeZoneName')?.value;
  const offset = etName === 'EST' ? '-05:00' : '-04:00';
  return new Date(`${local}:00${offset}`).toISOString();
}
