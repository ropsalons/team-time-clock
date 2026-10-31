import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminBootstrap, timesheetLoad, batchDayEntry, type TimesheetDay, type TimesheetEntryBy } from '../../lib/api';
import { payPeriodFor, shiftPayPeriod, payPeriodLabel } from '../../lib/time';

interface Emp { id: string; first_name: string; last_name: string; home_location_id: string | null; home_department_id: string | null }
interface Opt { id: string; name: string }
interface Line { in: string; out: string; loc: string; dept: string }

// One editable line -> a segment. A day is an array of lines (usually 1).
const lineOf = (inV: string, outV: string, loc: string | null, dept: string | null): Line => ({ in: inV, out: outV, loc: loc ?? '', dept: dept ?? '' });
const emptyLine = (home: { loc: string | null; dept: string | null }): Line => lineOf('', '', home.loc, home.dept);

export default function Timesheet() {
  const [emps, setEmps] = useState<Emp[]>([]);
  const [locs, setLocs] = useState<Opt[]>([]);
  const [depts, setDepts] = useState<Opt[]>([]);
  const [empId, setEmpId] = useState('');
  const [period, setPeriod] = useState(() => payPeriodFor(new Date()));
  const [days, setDays] = useState<TimesheetDay[] | null>(null);
  const [home, setHome] = useState<{ loc: string | null; dept: string | null }>({ loc: null, dept: null });
  const [draft, setDraft] = useState<Record<string, Line[]>>({});
  const [original, setOriginal] = useState<Record<string, string>>({}); // date -> JSON snapshot
  const [reason, setReason] = useState('');
  const [bulkHrs, setBulkHrs] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const b = await adminBootstrap();
      const INACTIVE = new Set(['terminated_in_gusto', 'disabled']);
      setEmps(b.employees.filter((e) => !INACTIVE.has(e.timekeeping_access)).map((e) => ({ id: e.id, first_name: e.first_name, last_name: e.last_name, home_location_id: e.home_location_id, home_department_id: e.home_department_id })));
      setLocs(b.locations.map((x) => ({ id: x.id, name: x.short_name })));
      setDepts(b.departments.map((x) => ({ id: x.id, name: x.title })));
    })().catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!empId) { setDays(null); setDraft({}); setOriginal({}); return; }
    setLoading(true); setMsg(null);
    try {
      const r = await timesheetLoad(empId, period.start, period.end);
      const h = { loc: r.home.locationId, dept: r.home.departmentId };
      setHome(h);
      const dr: Record<string, Line[]> = {}; const orig: Record<string, string> = {};
      for (const day of r.days) {
        const lines = day.segments.length
          ? day.segments.map((s) => lineOf(s.startLocal, s.endLocal ?? '', s.locationId, s.departmentId))
          : [emptyLine(h)];
        dr[day.date] = lines;
        orig[day.date] = JSON.stringify(lines);
      }
      setDays(r.days); setDraft(dr); setOriginal(orig);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed to load.'); setDays([]); }
    finally { setLoading(false); }
  }, [empId, period.start, period.end]);
  useEffect(() => { load(); }, [load]);

  const setLines = (date: string, lines: Line[]) => setDraft((d) => ({ ...d, [date]: lines }));
  const updLine = (date: string, i: number, k: keyof Line, v: string) =>
    setDraft((d) => ({ ...d, [date]: (d[date] ?? []).map((ln, j) => j === i ? { ...ln, [k]: v } : ln) }));
  const addLine = (date: string) => setDraft((d) => ({ ...d, [date]: [...(d[date] ?? []), emptyLine(home)] }));
  const removeLine = (date: string, i: number) => setDraft((d) => { const arr = (d[date] ?? []).filter((_, j) => j !== i); return { ...d, [date]: arr.length ? arr : [emptyLine(home)] }; });
  const quick95 = (date: string) => setLines(date, [lineOf('09:00', '17:00', home.loc, home.dept)]);
  const clearDay = (date: string) => setLines(date, [emptyLine(home)]);
  // Type just a number of hours -> fill that day starting 9:00 AM (times shown so
  // you can see/adjust them), keeping any salon/role already picked.
  const setDayHours = (date: string, n: number, keep?: Line) => {
    const io = hoursToInOut(n);
    setLines(date, [lineOf(io.in, io.out, keep?.loc || home.loc, keep?.dept || home.dept)]);
  };
  // One shot: drop N hours into every empty, non-Sunday day that has nothing yet
  // (skips days that already have hours).
  const fillBlanks = () => {
    const n = Number(bulkHrs);
    if (!Number.isFinite(n) || n <= 0) { setMsg('Enter a number of hours to fill (e.g. 8).'); return; }
    setDraft((d) => {
      const next = { ...d };
      for (const day of days ?? []) {
        if (day.weekday === 'Sun') continue;
        const cur = d[day.date] ?? [];
        const isBlank = cur.length === 1 && !cur[0].in && !cur[0].out;
        if (!isBlank) continue;
        const io = hoursToInOut(n);
        next[day.date] = [lineOf(io.in, io.out, home.loc, home.dept)];
      }
      return next;
    });
  };

  const dirtyDates = useMemo(() => (days ?? []).map((d) => d.date).filter((dt) => JSON.stringify(draft[dt] ?? []) !== original[dt]), [days, draft, original]);

  const periodTotal = useMemo(() => {
    let t = 0;
    for (const dt of Object.keys(draft)) for (const ln of draft[dt]) { const h = lineHours(ln); if (h && h > 0) t += h; }
    return Math.round(t * 100) / 100;
  }, [draft]);

  const invalidDates = useMemo(() => dirtyDates.filter((dt) => (draft[dt] ?? []).some((ln) => {
    const outNoIn = !ln.in && !!ln.out;                 // a clock-out with no start
    const bad = !!ln.in && !!ln.out && !(lineHours(ln)! > 0); // out <= in
    return outNoIn || bad;                               // start-only (open) is OK
  })), [dirtyDates, draft]);

  const save = async () => {
    if (!empId || !dirtyDates.length) return;
    if (invalidDates.length) { setMsg(`Fix these day(s) first — a clock-out needs a start, and the out must be after the in: ${invalidDates.map(fmtShort).join(', ')}`); return; }
    setBusy(true); setMsg(null);
    try {
      const payload = dirtyDates.map((date) => ({
        date,
        segments: (draft[date] ?? []).filter((ln) => ln.in).map((ln) => ({
          startTs: etWallToIso(date, ln.in), endTs: ln.out ? etWallToIso(date, ln.out) : null,
          locationId: ln.loc || null, departmentId: ln.dept || null,
        })),
      }));
      const r = await batchDayEntry(empId, payload, reason.trim() || undefined);
      setMsg(`Saved ${r.daysApplied} day${r.daysApplied === 1 ? '' : 's'}.`);
      await load();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Save failed.'); }
    finally { setBusy(false); }
  };

  const empName = emps.find((e) => e.id === empId);
  const isCurrent = period.start === payPeriodFor(new Date()).start;

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h2 className="font-semibold text-brand-ink">Timesheet — fast entry</h2>
        <span className="text-xs text-neutral-400">Type a whole week at once — just enter the HOURS for a day and it fills in the times, or set In/Out yourself. Every change is logged under your name.</span>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-3">
        <label className="text-sm">Employee
          <select value={empId} onChange={(e) => setEmpId(e.target.value)} className="block rounded-lg border border-neutral-300 px-2 py-1 mt-1 min-w-[200px]">
            <option value="">Select…</option>
            {emps.map((e) => <option key={e.id} value={e.id}>{e.last_name}, {e.first_name}</option>)}
          </select>
        </label>
        <div className="text-sm">
          <div className="mb-1">Pay period</div>
          <div className="flex items-center gap-1">
            <button onClick={() => setPeriod((p) => shiftPayPeriod(p, -1))} className="rounded-lg border border-neutral-300 px-2.5 py-1 hover:bg-neutral-50" title="Previous pay period">‹</button>
            <span className="rounded-lg bg-neutral-100 px-3 py-1 font-medium tabular-nums min-w-[150px] text-center">{payPeriodLabel(period)}</span>
            <button onClick={() => setPeriod((p) => shiftPayPeriod(p, 1))} className="rounded-lg border border-neutral-300 px-2.5 py-1 hover:bg-neutral-50" title="Next pay period">›</button>
            {!isCurrent && <button onClick={() => setPeriod(payPeriodFor(new Date()))} className="ml-1 text-xs text-blue-600 underline">This period</button>}
          </div>
        </div>
      </div>

      {!empId && <p className="text-neutral-500 text-sm">Pick an employee to enter their hours for {payPeriodLabel(period)}.</p>}
      {empId && loading && <p className="text-neutral-500 text-sm">Loading {empName ? `${empName.first_name}'s` : ''} timesheet…</p>}

      {empId && days && !loading && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-neutral-50 border border-neutral-200 px-3 py-2 text-sm">
            <span className="text-neutral-600">Fill every empty day with</span>
            <input type="number" step="0.25" min="0" max="24" value={bulkHrs} onChange={(e) => setBulkHrs(e.target.value)} placeholder="8" className="w-16 rounded border border-neutral-300 px-2 py-1 text-right tabular-nums" />
            <span className="text-neutral-600">hours</span>
            <button onClick={fillBlanks} className="rounded-lg bg-brand-ink text-white px-3 py-1 text-xs font-medium">Fill blanks</button>
            <span className="text-xs text-neutral-400">Fills blank weekdays only (skips Sundays and days that already have hours). Adjust or clear any after, then Save.</span>
          </div>
          <div className="overflow-x-auto -mx-1 px-1">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-left text-neutral-400 text-xs uppercase tracking-wide">
                  <th className="py-1 w-[120px]">Day</th><th>In</th><th>Out</th><th>Salon</th><th>Role</th><th className="text-right pr-1">Hrs</th><th></th><th className="pl-2">Entered by</th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => {
                  const lines = draft[day.date] ?? [];
                  const dirty = JSON.stringify(lines) !== original[day.date];
                  const dayHrs = lines.reduce((s, ln) => { const h = lineHours(ln); return s + (h && h > 0 ? h : 0); }, 0);
                  const isSun = day.weekday === 'Sun';
                  return lines.map((ln, i) => {
                    const h = lineHours(ln);
                    const bad = (!ln.in && !!ln.out) || (!!ln.in && !!ln.out && !(h! > 0));
                    return (
                      <tr key={`${day.date}-${i}`} className={`border-t border-neutral-100 ${dirty ? 'bg-amber-50/40' : ''}`}>
                        <td className="py-1.5 align-middle">
                          {i === 0 && (
                            <div className="flex items-center gap-1.5">
                              <span className={`font-medium ${isSun ? 'text-neutral-400' : 'text-brand-ink'}`}>{day.weekday} {fmtShort(day.date)}</span>
                              {dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="unsaved" />}
                            </div>
                          )}
                        </td>
                        <td><input type="time" value={ln.in} onChange={(e) => updLine(day.date, i, 'in', e.target.value)} className={`rounded border px-1.5 py-1 ${bad && !ln.in && ln.out ? 'border-red-400' : 'border-neutral-300'}`} /></td>
                        <td><input type="time" value={ln.out} onChange={(e) => updLine(day.date, i, 'out', e.target.value)} className={`rounded border px-1.5 py-1 ${bad ? 'border-red-400' : 'border-neutral-300'}`} /></td>
                        <td><select value={ln.loc} onChange={(e) => updLine(day.date, i, 'loc', e.target.value)} className="rounded border border-neutral-300 px-1.5 py-1 max-w-[130px]"><option value="">—</option>{locs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></td>
                        <td><select value={ln.dept} onChange={(e) => updLine(day.date, i, 'dept', e.target.value)} className="rounded border border-neutral-300 px-1.5 py-1 max-w-[130px]"><option value="">—</option>{depts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></td>
                        <td className="text-right pr-1 tabular-nums whitespace-nowrap">
                          {i === 0 && lines.length === 1 ? (
                            <input type="number" step="0.25" min="0" max="24"
                              value={h && h > 0 ? String(h) : ''}
                              placeholder='—'
                              title="Type hours to fill this day (9:00 AM start); or set In/Out for exact times"
                              onChange={(e) => { const v = e.target.value; if (!v) { clearDay(day.date); return; } const n = Number(v); if (Number.isFinite(n) && n > 0) setDayHours(day.date, n, ln); }}
                              className={`w-16 rounded border px-1.5 py-1 text-right tabular-nums ${bad ? 'border-red-400' : 'border-neutral-300'}`} />
                          ) : i === 0
                            ? <span className={bad ? 'text-red-500' : 'text-neutral-700'}>{dayHrs > 0 ? dayHrs.toFixed(2) : ''}</span>
                            : <span className="text-neutral-700">{h && h > 0 ? h.toFixed(2) : ''}</span>}
                        </td>
                        <td className="text-right whitespace-nowrap pl-1">
                          {i === 0 ? (
                            <>
                              {lines.length === 1 && !ln.in && !ln.out && <button onClick={() => quick95(day.date)} className="text-blue-600 underline text-xs mr-2" title="Fill 9:00–5:00">9–5</button>}
                              <button onClick={() => addLine(day.date)} className="text-neutral-500 hover:text-brand-ink text-xs mr-2" title="Add a second shift">+shift</button>
                              {(ln.in || ln.out || lines.length > 1) && <button onClick={() => clearDay(day.date)} className="text-neutral-400 hover:text-red-600 text-xs" title="Clear this day">clear</button>}
                            </>
                          ) : (
                            <button onClick={() => removeLine(day.date, i)} className="text-red-500 text-xs" title="Remove this shift">✕</button>
                          )}
                        </td>
                        <td className="pl-2 text-xs whitespace-nowrap">
                          {i === 0 && (dirty
                            ? <span className="text-amber-600">unsaved…</span>
                            : entryLabel(day.entry))}
                        </td>
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4">
            <label className="block text-sm text-neutral-600 mb-1">Reason <span className="text-neutral-400">(optional — leave blank if you don't need one)</span></label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. entered from paper timesheet" className="w-full max-w-md rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button disabled={busy || !dirtyDates.length} onClick={save}
              className="rounded-lg bg-emerald-600 text-white px-5 py-2 text-sm font-semibold disabled:opacity-50">
              {busy ? 'Saving…' : dirtyDates.length ? `Save ${dirtyDates.length} changed day${dirtyDates.length === 1 ? '' : 's'}` : 'Saved'}
            </button>
            <span className="text-sm text-neutral-600">Period total <b className="tabular-nums">{periodTotal.toFixed(2)}h</b></span>
            {msg && <span className={`text-sm ${invalidDates.length ? 'text-red-600' : 'text-neutral-600'}`}>{msg}</span>}
          </div>
          <p className="text-xs text-neutral-400 mt-2">Salon &amp; role default to the home job — leave them unless a day was worked elsewhere. Times are salon (Eastern). History is kept.</p>
        </>
      )}
    </div>
  );
}

// ---- helpers ----
function lineHours(ln: Line): number | null {
  if (!ln.in || !ln.out) return null;
  const [ih, im] = ln.in.split(':').map(Number); const [oh, om] = ln.out.split(':').map(Number);
  if ([ih, im, oh, om].some((n) => Number.isNaN(n))) return null;
  return Math.round(((oh * 60 + om) - (ih * 60 + im)) / 60 * 100) / 100;
}
// Small "who put this day in" label for the right-hand column.
function entryLabel(entry: TimesheetEntryBy | null) {
  if (!entry || !entry.source) return <span className="text-neutral-300">—</span>;
  if (entry.source === 'administrator') {
    const showReason = entry.reason && entry.reason !== 'admin timesheet entry';
    return <span className="text-neutral-500" title={showReason ? entry.reason! : 'Entered by an admin'}>✎ {entry.by ?? 'an admin'}{showReason ? ' *' : ''}</span>;
  }
  if (entry.source === 'employee_mobile') return <span className="text-emerald-700" title="The employee clocked in on their phone">clocked in (app)</span>;
  return <span className="text-neutral-400">{entry.source}</span>;
}
// Turn a number of hours into a same-day 9:00 AM -> (9:00 + hours) window.
// Stays within the day (never crosses midnight, which would look like an
// overnight shift). Supports fractions (8.5 = 8h30m).
function hoursToInOut(n: number): { in: string; out: string } {
  const start = 9 * 60;
  let end = start + Math.round(n * 60);
  let s = start;
  if (end > 23 * 60 + 59) { end = 23 * 60 + 59; s = Math.max(0, end - Math.round(n * 60)); }
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { in: fmt(s), out: fmt(end) };
}
function fmtShort(d: string) { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
// Interpret an ET wall-clock date+HH:MM as Eastern and return a UTC ISO string.
function etWallToIso(date: string, hhmm: string): string {
  const local = `${date}T${hhmm}`;
  const naive = new Date(`${local}:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(naive).find((x) => x.type === 'timeZoneName')?.value;
  return new Date(`${local}:00${name === 'EST' ? '-05:00' : '-04:00'}`).toISOString();
}
