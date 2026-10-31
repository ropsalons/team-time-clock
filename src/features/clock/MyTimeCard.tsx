import { useCallback, useEffect, useMemo, useState } from 'react';
import { meTimecardLoad, meTimecardSave, clockBootstrap, type TimesheetSegment } from '../../lib/api';
import { payPeriodFor, shiftPayPeriod, payPeriodLabel } from '../../lib/time';

// Self-service time card for trusted senior staff (can_manage_own_time). Same
// fast-entry grid as the admin Timesheet, but scoped to the signed-in person and
// limited to the current + previous pay period. Type hours OR set In/Out.

interface Opt { id: string; name: string }
interface Line { in: string; out: string; loc: string; dept: string }
type Day = { date: string; weekday: string; segments: TimesheetSegment[] };

const lineOf = (inV: string, outV: string, loc: string | null, dept: string | null): Line => ({ in: inV, out: outV, loc: loc ?? '', dept: dept ?? '' });
const emptyLine = (home: { loc: string | null; dept: string | null }): Line => lineOf('', '', home.loc, home.dept);

export default function MyTimeCard({ firstName, onBack }: { firstName: string; onBack: () => void }) {
  const current = useMemo(() => payPeriodFor(new Date()), []);
  const prev = useMemo(() => shiftPayPeriod(current, -1), [current]);
  const [sel, setSel] = useState<'this' | 'last'>('this');
  const period = sel === 'this' ? current : prev;

  const [locs, setLocs] = useState<Opt[]>([]);
  const [depts, setDepts] = useState<Opt[]>([]);
  const [days, setDays] = useState<Day[] | null>(null);
  const [home, setHome] = useState<{ loc: string | null; dept: string | null }>({ loc: null, dept: null });
  const [draft, setDraft] = useState<Record<string, Line[]>>({});
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [bulkHrs, setBulkHrs] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { clockBootstrap().then((b) => { setLocs(b.locations); setDepts(b.departments); }).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true); setMsg(null);
    try {
      const r = await meTimecardLoad(period.start, period.end);
      const h = { loc: r.home.locationId, dept: r.home.departmentId }; setHome(h);
      const dr: Record<string, Line[]> = {}; const orig: Record<string, string> = {};
      for (const day of r.days) {
        const lines = day.segments.length ? day.segments.map((s) => lineOf(s.startLocal, s.endLocal ?? '', s.locationId, s.departmentId)) : [emptyLine(h)];
        dr[day.date] = lines; orig[day.date] = JSON.stringify(lines);
      }
      setDays(r.days); setDraft(dr); setOriginal(orig);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed to load.'); setDays([]); }
    finally { setLoading(false); }
  }, [period.start, period.end]);
  useEffect(() => { load(); }, [load]);

  const setLines = (date: string, lines: Line[]) => setDraft((d) => ({ ...d, [date]: lines }));
  const updLine = (date: string, i: number, k: keyof Line, v: string) => setDraft((d) => ({ ...d, [date]: (d[date] ?? []).map((ln, j) => j === i ? { ...ln, [k]: v } : ln) }));
  const addLine = (date: string) => setDraft((d) => ({ ...d, [date]: [...(d[date] ?? []), emptyLine(home)] }));
  const removeLine = (date: string, i: number) => setDraft((d) => { const arr = (d[date] ?? []).filter((_, j) => j !== i); return { ...d, [date]: arr.length ? arr : [emptyLine(home)] }; });
  const quick95 = (date: string) => setLines(date, [lineOf('09:00', '17:00', home.loc, home.dept)]);
  const clearDay = (date: string) => setLines(date, [emptyLine(home)]);
  const setDayHours = (date: string, n: number, keep?: Line) => { const io = hoursToInOut(n); setLines(date, [lineOf(io.in, io.out, keep?.loc || home.loc, keep?.dept || home.dept)]); };
  const fillBlanks = () => {
    const n = Number(bulkHrs);
    if (!Number.isFinite(n) || n <= 0) { setMsg('Enter a number of hours to fill (e.g. 8).'); return; }
    setDraft((d) => {
      const next = { ...d };
      for (const day of days ?? []) {
        if (day.weekday === 'Sun') continue;
        const cur = d[day.date] ?? [];
        if (!(cur.length === 1 && !cur[0].in && !cur[0].out)) continue;
        const io = hoursToInOut(n); next[day.date] = [lineOf(io.in, io.out, home.loc, home.dept)];
      }
      return next;
    });
  };

  const dirtyDates = useMemo(() => (days ?? []).map((d) => d.date).filter((dt) => JSON.stringify(draft[dt] ?? []) !== original[dt]), [days, draft, original]);
  const periodTotal = useMemo(() => { let t = 0; for (const dt of Object.keys(draft)) for (const ln of draft[dt]) { const h = lineHours(ln); if (h && h > 0) t += h; } return Math.round(t * 100) / 100; }, [draft]);
  // A start with no end is OK (an open clock-in you'll close later). Invalid only
  // if there's an end with no start, or the end is before/at the start.
  const invalidDates = useMemo(() => dirtyDates.filter((dt) => (draft[dt] ?? []).some((ln) => (!ln.in && !!ln.out) || (!!ln.in && !!ln.out && !(lineHours(ln)! > 0)))), [dirtyDates, draft]);

  const save = async () => {
    if (!dirtyDates.length) return;
    if (invalidDates.length) { setMsg(`Fix these day(s) — a clock-out needs a start time, and the end must be after the start: ${invalidDates.map(fmtShort).join(', ')}`); return; }
    setBusy(true); setMsg(null);
    try {
      const payload = dirtyDates.map((date) => ({
        date,
        segments: (draft[date] ?? []).filter((ln) => ln.in).map((ln) => ({ startTs: etWallToIso(date, ln.in), endTs: ln.out ? etWallToIso(date, ln.out) : null, locationId: ln.loc || null, departmentId: ln.dept || null })),
      }));
      const r = await meTimecardSave(payload, reason.trim() || undefined);
      setMsg(`Saved ${r.daysApplied} day${r.daysApplied === 1 ? '' : 's'}. ✓`);
      await load();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Save failed.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-full bg-brand-cream safe-top safe-bottom px-3 pb-16">
      <header className="max-w-3xl mx-auto flex items-center justify-between py-4">
        <button onClick={onBack} className="text-brand-ink font-medium">‹ Back</button>
        <div className="font-semibold text-brand-ink">My Time Card</div>
        <div className="w-12" />
      </header>
      <div className="max-w-3xl mx-auto bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
        <p className="text-sm text-neutral-500 mb-3">Hi {firstName} — add a day you forgot to punch, or fix a time. Just type the <b>hours</b> for a day (it fills in the times), or set the exact In/Out. You can edit this pay period and last pay period.</p>

        <div className="flex items-center gap-1 mb-3">
          <button onClick={() => setSel('this')} className={['rounded-lg px-3 py-1.5 text-sm border', sel === 'this' ? 'bg-brand-ink text-white border-brand-ink' : 'bg-white border-neutral-300 text-neutral-700'].join(' ')}>This period<div className="text-[11px] opacity-70">{payPeriodLabel(current)}</div></button>
          <button onClick={() => setSel('last')} className={['rounded-lg px-3 py-1.5 text-sm border', sel === 'last' ? 'bg-brand-ink text-white border-brand-ink' : 'bg-white border-neutral-300 text-neutral-700'].join(' ')}>Last period<div className="text-[11px] opacity-70">{payPeriodLabel(prev)}</div></button>
        </div>

        {loading && <p className="text-neutral-500 text-sm">Loading…</p>}
        {days && !loading && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-neutral-50 border border-neutral-200 px-3 py-2 text-sm">
              <span className="text-neutral-600">Fill every empty day with</span>
              <input type="number" step="0.25" min="0" max="24" value={bulkHrs} onChange={(e) => setBulkHrs(e.target.value)} placeholder="8" className="w-16 rounded border border-neutral-300 px-2 py-1 text-right tabular-nums" />
              <span className="text-neutral-600">hours</span>
              <button onClick={fillBlanks} className="rounded-lg bg-brand-ink text-white px-3 py-1 text-xs font-medium">Fill blanks</button>
              <span className="text-xs text-neutral-400">Blank weekdays only. Adjust or clear any, then Save.</span>
            </div>

            <div className="overflow-x-auto -mx-1 px-1">
              <table className="w-full text-sm min-w-[620px]">
                <thead><tr className="text-left text-neutral-400 text-xs uppercase tracking-wide"><th className="py-1 w-[110px]">Day</th><th>In</th><th>Out</th><th>Salon</th><th>Role</th><th className="text-right pr-1">Hrs</th><th></th></tr></thead>
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
                          <td className="py-1.5">{i === 0 && <span className={`font-medium ${isSun ? 'text-neutral-400' : 'text-brand-ink'}`}>{day.weekday} {fmtShort(day.date)}{dirty ? ' •' : ''}</span>}</td>
                          <td><input type="time" value={ln.in} onChange={(e) => updLine(day.date, i, 'in', e.target.value)} className={`rounded border px-1.5 py-1 ${bad && !ln.in && ln.out ? 'border-red-400' : 'border-neutral-300'}`} /></td>
                          <td><input type="time" value={ln.out} onChange={(e) => updLine(day.date, i, 'out', e.target.value)} className={`rounded border px-1.5 py-1 ${bad ? 'border-red-400' : 'border-neutral-300'}`} /></td>
                          <td><select value={ln.loc} onChange={(e) => updLine(day.date, i, 'loc', e.target.value)} className="rounded border border-neutral-300 px-1.5 py-1 max-w-[120px]"><option value="">—</option>{locs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></td>
                          <td><select value={ln.dept} onChange={(e) => updLine(day.date, i, 'dept', e.target.value)} className="rounded border border-neutral-300 px-1.5 py-1 max-w-[120px]"><option value="">—</option>{depts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></td>
                          <td className="text-right pr-1 tabular-nums whitespace-nowrap">
                            {i === 0 && lines.length === 1 ? (
                              <input type="number" step="0.25" min="0" max="24" value={h && h > 0 ? String(h) : ''} placeholder='—'
                                title="Type hours to fill this day (9:00 AM start), or set In/Out"
                                onChange={(e) => { const v = e.target.value; if (!v) { clearDay(day.date); return; } const n = Number(v); if (Number.isFinite(n) && n > 0) setDayHours(day.date, n, ln); }}
                                className={`w-16 rounded border px-1.5 py-1 text-right tabular-nums ${bad ? 'border-red-400' : 'border-neutral-300'}`} />
                            ) : i === 0 ? <span className={bad ? 'text-red-500' : 'text-neutral-700'}>{dayHrs > 0 ? dayHrs.toFixed(2) : ''}</span> : <span>{h && h > 0 ? h.toFixed(2) : ''}</span>}
                          </td>
                          <td className="text-right whitespace-nowrap pl-1">
                            {i === 0 ? (<>
                              {lines.length === 1 && !ln.in && !ln.out && <button onClick={() => quick95(day.date)} className="text-blue-600 underline text-xs mr-2" title="Fill 9:00–5:00">9–5</button>}
                              <button onClick={() => addLine(day.date)} className="text-neutral-500 text-xs mr-2" title="Add a second shift">+shift</button>
                              {(ln.in || ln.out || lines.length > 1) && <button onClick={() => clearDay(day.date)} className="text-neutral-400 hover:text-red-600 text-xs" title="Clear this day">clear</button>}
                            </>) : <button onClick={() => removeLine(day.date, i)} className="text-red-500 text-xs">✕</button>}
                          </td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4">
              <label className="block text-sm text-neutral-600 mb-1">Reason <span className="text-neutral-400">(optional)</span></label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. forgot to clock out" className="w-full max-w-md rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button disabled={busy || !dirtyDates.length} onClick={save} className="rounded-2xl bg-emerald-600 text-white px-6 py-3 text-base font-bold disabled:opacity-50">{busy ? 'Saving…' : dirtyDates.length ? `Save ${dirtyDates.length} day${dirtyDates.length === 1 ? '' : 's'}` : 'Saved'}</button>
              <span className="text-sm text-neutral-600">Total <b className="tabular-nums">{periodTotal.toFixed(2)}h</b></span>
              {msg && <span className={`text-sm ${invalidDates.length ? 'text-red-600' : 'text-neutral-600'}`}>{msg}</span>}
            </div>
            <p className="text-xs text-neutral-400 mt-2">Salon &amp; role default to your home job. Times are salon (Eastern). Every change is saved under your name.</p>
          </>
        )}
      </div>
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
function hoursToInOut(n: number): { in: string; out: string } {
  const start = 9 * 60; let end = start + Math.round(n * 60); let s = start;
  if (end > 23 * 60 + 59) { end = 23 * 60 + 59; s = Math.max(0, end - Math.round(n * 60)); }
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { in: fmt(s), out: fmt(end) };
}
function fmtShort(d: string) { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
function etWallToIso(date: string, hhmm: string): string {
  const local = `${date}T${hhmm}`;
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(new Date(`${local}:00Z`)).find((x) => x.type === 'timeZoneName')?.value;
  return new Date(`${local}:00${name === 'EST' ? '-05:00' : '-04:00'}`).toISOString();
}
