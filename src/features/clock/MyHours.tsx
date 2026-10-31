import { useCallback, useEffect, useMemo, useState } from 'react';
import { meHours, type MyHours as MyHoursData, type MyHoursDay, type PunchEdit } from '../../lib/api';
import { listPayPeriods, payPeriodLabel } from '../../lib/time';

// Read-only "My Hours" for every employee. Shows a pay-period total (the paycheck
// number), a day-by-day breakdown with the day of week + clock in/out, any
// manager edits/adds to a punch, and a picker to look back at past pay periods.
// Staff see only their OWN history (the server scopes to the signed-in caller);
// only managers/owners can edit punches — this screen never edits anything.
export default function MyHours({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<MyHoursData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Picker: current first, then previous → older. null = current (server picks).
  const periods = useMemo(() => listPayPeriods(new Date(), 8, 0).reverse(), []);
  const [sel, setSel] = useState<{ start: string; end: string } | null>(null);

  const load = useCallback(async (p: { start: string; end: string } | null) => {
    setLoading(true); setErr(null);
    try { setData(await meHours(p ?? undefined)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not load your hours.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(sel); }, [sel, load]);

  const hrs = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(2));
  const activeStart = data?.period_start;

  return (
    <div className="min-h-full bg-brand-cream safe-top safe-bottom px-3 pb-16">
      <header className="max-w-lg mx-auto flex items-center justify-between py-4">
        <button onClick={onBack} className="text-brand-ink font-medium">‹ Back</button>
        <div className="font-semibold text-brand-ink">My Hours</div>
        <div className="w-12" />
      </header>

      <div className="max-w-lg mx-auto">
        {/* Pay-period picker */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 mb-3">
          {periods.map((p) => {
            const on = activeStart === p.start;
            return (
              <button key={p.start} onClick={() => setSel(p.isCurrent ? null : { start: p.start, end: p.end })}
                className={['shrink-0 rounded-full border px-3 min-h-[36px] text-sm font-medium', on ? 'bg-brand-ink text-white border-brand-ink' : 'bg-white border-neutral-300 text-neutral-700'].join(' ')}>
                {p.isCurrent ? 'Current' : payPeriodLabel(p)}
              </button>
            );
          })}
        </div>

        {loading && <p className="text-neutral-500 text-sm text-center py-6">Loading your hours…</p>}
        {err && <p className="text-red-600 text-sm text-center py-6">{err}</p>}

        {data && !loading && (
          <>
            {data.is_clocked_in && (
              <div className="mb-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm text-center px-4 py-2 font-medium">🟢 You're clocked in right now</div>
            )}

            <div className="rounded-2xl bg-brand-ink text-white px-5 py-6 text-center shadow-sm">
              <div className="text-xs uppercase tracking-wide text-white/60">{data.is_current_period ? 'This pay period' : 'Pay period'}</div>
              <div className="text-5xl font-bold tabular-nums mt-1">{hrs(data.hours_this_period)}<span className="text-2xl font-semibold"> hrs</span></div>
              <div className="inline-block mt-2 rounded-full bg-white/10 px-3 py-1 text-sm font-medium text-white/90">📅 {fmtRange(data.period_start, data.period_end)}</div>
            </div>

            {data.is_current_period && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div className="rounded-xl bg-white border border-neutral-200 px-4 py-3 text-center">
                  <div className="text-xs uppercase tracking-wide text-neutral-400">This week</div>
                  <div className="text-2xl font-bold tabular-nums text-brand-ink">{hrs(data.hours_this_week)}<span className="text-sm"> h</span></div>
                </div>
                <div className="rounded-xl bg-white border border-neutral-200 px-4 py-3 text-center">
                  <div className="text-xs uppercase tracking-wide text-neutral-400">Last week</div>
                  <div className="text-2xl font-bold tabular-nums text-brand-ink">{hrs(data.hours_last_week)}<span className="text-sm"> h</span></div>
                </div>
              </div>
            )}

            <h2 className="text-xs uppercase tracking-wide text-neutral-500 mt-5 mb-1 px-1">Day by day</h2>
            <div className="rounded-xl bg-white border border-neutral-200 divide-y divide-neutral-100 overflow-hidden">
              {data.days.length === 0 && <p className="px-4 py-4 text-sm text-neutral-400 text-center">No hours recorded for this pay period.</p>}
              {data.days.map((d) => <DayRow key={d.date} d={d} />)}
            </div>

            <p className="text-xs text-neutral-400 mt-3 text-center">These match how payroll counts your hours. Missing a day? Tap “Report a missed or incorrect punch” on the clock screen. Only a manager can edit a punch.</p>
          </>
        )}
      </div>
    </div>
  );
}

function DayRow({ d }: { d: MyHoursDay }) {
  const inOut = (i: string | null, o: string | null) => (
    <>In {i ? fmtTime(i) : '—'} · Out {o ? fmtTime(o) : '—'}</>
  );
  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold text-brand-ink">{d.weekday}, {fmtMD(d.date)}</span>
        <span className="tabular-nums font-semibold text-brand-ink whitespace-nowrap">{d.open ? 'in progress' : `${(d.total ?? 0).toFixed(2)} h`}</span>
      </div>
      <div className="text-neutral-600 mt-0.5">
        {d.open ? 'clocked in…'
          : d.segments && d.segments.length > 1
            ? d.segments.map((s, i) => <div key={i}>{inOut(s.in, s.out)}</div>)
            : (d.in || d.out) ? <div>{inOut(d.in, d.out)}</div> : <span className="text-neutral-400">—</span>}
      </div>
      {d.edits && d.edits.length > 0 && (
        <div className="mt-2 space-y-1">
          {d.edits.map((e, i) => <EditNote key={i} e={e} />)}
        </div>
      )}
    </div>
  );
}

function EditNote({ e }: { e: PunchEdit }) {
  const label = e.field === 'in' ? 'Clock-in' : 'Clock-out';
  return (
    <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs px-2.5 py-1.5 leading-relaxed">
      <span className="font-semibold">{e.kind === 'added' ? '➕ Added' : '✏️ Edited'}</span>{' '}
      {e.kind === 'edited' && e.from
        ? <>{label} <span className="line-through text-amber-700/70">{fmtTime(e.from)}</span> → <b>{fmtTime(e.to)}</b></>
        : <>{label} <b>{fmtTime(e.to)}</b></>}
      <span className="text-amber-700/90"> · by {e.by} · {fmtWhen(e.at)}</span>
    </div>
  );
}

function fmtMD(d: string) { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
function fmtRange(a: string, b: string) { return `${fmtMD(a)} – ${fmtMD(b)}, ${b.slice(0, 4)}`; }
function fmtTime(v: string) { const d = new Date(v); return isNaN(d.getTime()) ? v : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); }
function fmtWhen(iso: string) { const d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }); }
