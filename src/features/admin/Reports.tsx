import { useEffect, useMemo, useState } from 'react';
import { adminBootstrap, reportsHours } from '../../lib/api';
import { listPayPeriods, payPeriodLabel } from '../../lib/time';
import { buildHoursCsv, type HoursRow } from '../../lib/gusto/csv';

interface Emp { id: string; first_name: string; last_name: string; email: string | null; gusto_employee_uuid: string | null }
interface SummaryRow { key: string; name: string; former: boolean; days: number; regular: number; overtime: number; total: number }

export default function Reports() {
  const [emps, setEmps] = useState<Emp[]>([]);
  const [start, setStart] = useState('2025-01-01');
  const [end, setEnd] = useState('2025-12-31');
  const [empFilter, setEmpFilter] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const [detail, setDetail] = useState<HoursRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: 'name' | 'days' | 'regular' | 'overtime' | 'total'; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });

  useEffect(() => {
    adminBootstrap().then((b) => setEmps(b.employees.map((e) => ({ id: e.id, first_name: e.first_name, last_name: e.last_name, email: e.email, gusto_employee_uuid: e.gusto_employee_uuid })))).catch(() => {});
  }, []);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await reportsHours(start, end, empFilter || undefined, activeOnly);
      setSummary(r.summary);
      setDetail(r.detail as HoursRow[]);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Report failed'); }
    finally { setBusy(false); }
  };

  const grand = useMemo(() => (summary ?? []).reduce((a, r) => ({ days: a.days + r.days, total: a.total + r.total }), { days: 0, total: 0 }), [summary]);

  const sortedSummary = useMemo(() => {
    const rows = [...(summary ?? [])];
    const { key, dir } = sort; const mul = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => key === 'name' ? mul * a.name.localeCompare(b.name) : mul * (a[key] - b[key]));
    return rows;
  }, [summary, sort]);

  const clickSort = (key: typeof sort.key) =>
    setSort((s) => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' });
  const arrow = (key: typeof sort.key) => sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  const download = () => {
    const rows = empFilter ? detail : (summary ?? []).map((r) => ({ date: `${start}..${end}`, employee_name: r.name, email: null, gusto_employee_uuid: null, source: r.former ? 'former' : 'total', total_hours: r.total, regular_hours: r.regular, overtime_hours: r.overtime }));
    const blob = new Blob([buildHoursCsv(rows as HoursRow[])], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `brand-hours-${empFilter ? 'detail-' : 'summary-'}${start}_to_${end}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  const setYear = (y: number | 'ytd') => { if (y === 'ytd') { setStart('2026-01-01'); setEnd('2026-07-14'); } else { setStart(`${y}-01-01`); setEnd(`${y}-12-31`); } };
  const periods = useMemo(() => listPayPeriods(new Date(), 6, 1).reverse(), []);

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3 no-print">
        <h2 className="font-semibold text-brand-ink">Reports — hours (history + live)</h2>
        <div className="flex gap-2">
          <button onClick={() => window.print()} disabled={!summary} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50">Print</button>
          <button onClick={download} disabled={!summary} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50">Download CSV</button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2 mb-2 no-print">
        <div className="flex gap-1">
          {([2024, 2025, 2026] as const).map((y) => {
            const on = start === `${y}-01-01` && end === `${y}-12-31`;
            return <button key={y} onClick={() => setYear(y)} className={['rounded-full border px-3 py-1 text-sm', on ? 'bg-brand-ink text-white border-brand-ink font-medium' : 'border-neutral-300 text-neutral-700'].join(' ')}>{y}</button>;
          })}
          {(() => { const on = start === '2026-01-01' && end === '2026-07-14'; return (
            <button onClick={() => setYear('ytd')} className={['rounded-full border px-3 py-1 text-sm', on ? 'bg-brand-ink text-white border-brand-ink font-medium' : 'border-neutral-300 text-neutral-700'].join(' ')}>2026 YTD</button>
          ); })()}
        </div>
        <label className="text-sm">Start<input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1" /></label>
        <label className="text-sm">End<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1" /></label>
        <label className="text-sm">Employee
          <select value={empFilter} onChange={(e) => setEmpFilter(e.target.value)} className="block rounded border border-neutral-300 px-2 py-1 mt-1 min-w-[150px] bg-white">
            <option value="">All employees</option>
            {emps.map((e) => <option key={e.id} value={e.id}>{e.last_name}, {e.first_name}</option>)}
          </select>
        </label>
        <button onClick={run} disabled={busy} className="rounded-lg bg-brand-ink text-white px-4 py-2 text-sm font-medium disabled:opacity-60">{busy ? 'Running…' : 'Run report'}</button>
      </div>

      {!empFilter && (
        <div className="inline-flex rounded-lg border border-neutral-300 overflow-hidden text-sm mb-3 no-print">
          <button onClick={() => setActiveOnly(true)} className={['px-3 py-1.5', activeOnly ? 'bg-brand-ink text-white' : 'bg-white text-neutral-600'].join(' ')}>Active only</button>
          <button onClick={() => setActiveOnly(false)} className={['px-3 py-1.5 border-l border-neutral-300', !activeOnly ? 'bg-brand-ink text-white' : 'bg-white text-neutral-600'].join(' ')}>All (incl. former)</button>
        </div>
      )}

      {periods.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3 no-print">
          <span className="text-xs text-neutral-400 self-center mr-1">pay periods:</span>
          {periods.map((p) => {
            const on = p.start === start && p.end === end;
            return <button key={p.start} onClick={() => { setStart(p.start); setEnd(p.end); }} className={['rounded-full border px-2 py-0.5 text-xs', on ? 'bg-brand-ink text-white border-brand-ink font-medium' : 'border-neutral-200 text-neutral-600'].join(' ')}>{payPeriodLabel(p)}</button>;
          })}
        </div>
      )}

      {err && <p className="text-sm text-red-600 no-print">{err}</p>}

      {summary && (
        <div className="printable">
          <div className="mb-2 text-sm text-neutral-500">
            {empFilter ? emps.find((e) => e.id === empFilter)?.last_name : (activeOnly ? 'Active employees' : 'All employees')} · {start} to {end} · <b>{grand.total.toFixed(2)} hrs</b> across {grand.days} days
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead><tr className="text-neutral-500 select-none">
                <th className="py-1 text-left"><button onClick={() => clickSort('name')} className="hover:text-brand-ink font-medium">Employee{arrow('name')}</button></th>
                <th className="text-right"><button onClick={() => clickSort('days')} className="hover:text-brand-ink font-medium">Days{arrow('days')}</button></th>
                <th className="text-right"><button onClick={() => clickSort('regular')} className="hover:text-brand-ink font-medium">Regular{arrow('regular')}</button></th>
                <th className="text-right"><button onClick={() => clickSort('overtime')} className="hover:text-brand-ink font-medium">OT{arrow('overtime')}</button></th>
                <th className="text-right"><button onClick={() => clickSort('total')} className="hover:text-brand-ink font-medium">Total{arrow('total')}</button></th>
              </tr></thead>
              <tbody>
                {sortedSummary.length === 0 && <tr><td colSpan={5} className="py-3 text-neutral-400">No hours in this range.</td></tr>}
                {sortedSummary.map((r) => (
                  <tr key={r.key} className="border-t border-neutral-100">
                    <td className="py-2">{r.name}{r.former && <span className="text-xs text-neutral-400"> · former</span>}</td>
                    <td className="text-right tabular-nums">{r.days}</td>
                    <td className="text-right tabular-nums">{r.regular.toFixed(2)}</td>
                    <td className="text-right tabular-nums">{r.overtime.toFixed(2)}</td>
                    <td className="text-right tabular-nums font-medium">{r.total.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              {summary.length > 0 && <tfoot><tr className="border-t-2 border-neutral-200 font-semibold"><td className="py-2">Total</td><td className="text-right tabular-nums">{grand.days}</td><td></td><td></td><td className="text-right tabular-nums">{grand.total.toFixed(2)}</td></tr></tfoot>}
            </table>
          </div>
          <p className="text-xs text-neutral-400 mt-3">Hours from Team Time Clock punches. Pick a single employee for day-by-day detail. Totals are computed in the database, so full years are exact.</p>
        </div>
      )}
    </div>
  );
}
