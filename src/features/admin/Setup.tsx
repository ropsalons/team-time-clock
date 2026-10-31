import { useCallback, useEffect, useState } from 'react';
import { adminAction, setupLoad, listBackups, runBackupNow, downloadBackup, syncGusto, type BackupItem, type GustoSyncResult } from '../../lib/api';

interface Loc { id: string; display_name: string; short_name: string; address: string | null; is_active: boolean; sort_order: number }
interface Dept { id: string; title: string; is_active: boolean; sort_order: number; gusto_job_title: string | null }

export default function Setup() {
  const [locs, setLocs] = useState<Loc[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await setupLoad();
    setLocs(r.locations as Loc[]); setDepts(r.departments as Dept[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (body: Record<string, unknown>, ok = 'Saved') => {
    setBusy(true); setMsg(null);
    try { await adminAction(body); setMsg(ok); await load(); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="md:col-span-2"><GustoSync /></div>
      <div className="md:col-span-2"><Reminders /></div>
      <div className="md:col-span-2"><Backups /></div>
      <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-brand-ink">Locations</h2>
          <button disabled={busy} onClick={() => {
            const shortName = window.prompt('Short name (e.g. Off-site):'); if (!shortName) return;
            const displayName = window.prompt('Display name:', shortName) || shortName;
            act({ type: 'upsert_location', shortName, displayName, sortOrder: 50 }, 'Location added');
          }} className="text-sm text-emerald-700 underline">+ Add location</button>
        </div>
        <ul className="divide-y divide-neutral-100">
          {locs.map((l) => (
            <li key={l.id} className="py-2 flex items-center justify-between gap-2">
              <div>
                <div className={['font-medium', l.is_active ? '' : 'text-neutral-400 line-through'].join(' ')}>{l.short_name}</div>
                <div className="text-xs text-neutral-400">{l.display_name}</div>
              </div>
              <div className="flex items-center gap-3 text-sm whitespace-nowrap">
                <button disabled={busy} onClick={() => { const displayName = window.prompt('Display name:', l.display_name); if (displayName) act({ type: 'upsert_location', id: l.id, shortName: l.short_name, displayName }); }} className="text-blue-600 underline">rename</button>
                <button disabled={busy} onClick={() => act({ type: 'upsert_location', id: l.id, shortName: l.short_name, displayName: l.display_name, isActive: !l.is_active })} className="text-neutral-500 underline">{l.is_active ? 'disable' : 'enable'}</button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-brand-ink">Departments</h2>
          <button disabled={busy} onClick={() => { const title = window.prompt('Department name (e.g. Phone Concierge):'); if (title) act({ type: 'upsert_department', title, sortOrder: 50 }, 'Department added'); }} className="text-sm text-emerald-700 underline">+ Add department</button>
        </div>
        <ul className="divide-y divide-neutral-100">
          {depts.map((d) => (
            <li key={d.id} className="py-2 flex items-center justify-between gap-2">
              <div>
                <div className={['font-medium', d.is_active ? '' : 'text-neutral-400 line-through'].join(' ')}>{d.title}</div>
                <div className="text-xs text-neutral-400">
                  Gusto: {d.gusto_job_title ? <span className="text-neutral-600">{d.gusto_job_title}</span> : <span>“{d.title} + Location”</span>}
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm whitespace-nowrap">
                <button disabled={busy} onClick={() => { const g = window.prompt(`Exact Gusto job title for "${d.title}" (leave blank to use "${d.title} + Location"):`, d.gusto_job_title ?? ''); if (g !== null) act({ type: 'upsert_department', id: d.id, title: d.title, gustoJobTitle: g || null }); }} className="text-blue-600 underline">Gusto title</button>
                <button disabled={busy} onClick={() => { const title = window.prompt('Department name:', d.title); if (title) act({ type: 'upsert_department', id: d.id, title }); }} className="text-blue-600 underline">rename</button>
                <button disabled={busy} onClick={() => act({ type: 'upsert_department', id: d.id, title: d.title, isActive: !d.is_active })} className="text-neutral-500 underline">{d.is_active ? 'disable' : 'enable'}</button>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-xs text-neutral-400 mt-3">The <b>Gusto</b> line shows the exact job title hours export under. Location-based roles (Stylist, Concierge…) become “Role + Location”; specialty jobs (Nails, Marketing…) use a fixed Gusto title. These must match Gusto exactly to import.</p>
      </div>
      {msg && <div className="md:col-span-2 text-sm text-neutral-600">{msg}</div>}
    </div>
  );
}

function GustoSync() {
  const [last, setLast] = useState<{ at: string; scanned?: number; newHires?: string[]; terminated?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GustoSyncResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await setupLoad();
    if (r.settings.gusto_last_sync) setLast(r.settings.gusto_last_sync as any);
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async () => {
    setBusy(true); setErr(null); setResult(null);
    try { const r = await syncGusto(); setResult(r.result); await load(); }
    catch (e) {
      const detail = e instanceof Error ? e.message : 'Sync failed';
      // The common cause is Gusto not being connected (no saved authorization).
      // Don't leave the owner staring at a raw 502 — tell him the way forward.
      setErr(`Gusto sync isn’t available right now — Gusto likely needs to be reconnected (a one-time setup). You don’t need it to add someone: use “+ Add employee” on the Employees tab and they’ll get the same invite. (Technical detail: ${detail})`);
    }
    finally { setBusy(false); }
  };
  const fmtDate = (d: string) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h2 className="font-semibold text-brand-ink">Gusto sync</h2>
        <button onClick={run} disabled={busy} className="rounded-lg bg-brand-ink text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60">{busy ? 'Syncing…' : 'Sync with Gusto now'}</button>
      </div>
      <p className="text-xs text-neutral-500 mb-2">Runs automatically every night. New hires appear here as “pending review”; anyone terminated in Gusto is disabled from clocking in. You can also pull the latest roster on demand.</p>
      {last && <p className="text-xs text-neutral-500">Last synced <b>{fmtDate(last.at)}</b> · scanned {last.scanned ?? '—'}{last.newHires?.length ? ` · ${last.newHires.length} new` : ''}{last.terminated?.length ? ` · ${last.terminated.length} terminated` : ''}.</p>}
      {result && (
        <div className="text-sm text-neutral-700 mt-2 space-y-0.5">
          <div>Scanned {result.scanned} · {result.updated} updated.</div>
          {result.newHires.length > 0 && <div className="text-emerald-700">New (pending review): {result.newHires.join(', ')}</div>}
          {result.terminated.length > 0 && <div className="text-red-600">Terminated in Gusto: {result.terminated.join(', ')}</div>}
          {result.reactivatedConflicts.length > 0 && <div className="text-amber-600">Re-activated, needs review: {result.reactivatedConflicts.join(', ')}</div>}
          {result.newHires.length + result.terminated.length + result.reactivatedConflicts.length === 0 && <div className="text-neutral-500">No changes — roster already up to date.</div>}
        </div>
      )}
      {err && <div className="text-sm text-red-600 mt-2">{err}</div>}
    </div>
  );
}

function Backups() {
  const [items, setItems] = useState<BackupItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const r = await listBackups(); setItems(r.backups); }
    catch { setItems([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const now = async () => {
    setBusy(true); setMsg(null);
    try { const r = await runBackupNow(); setMsg(`Backup saved (${(r.bytes / 1024 / 1024).toFixed(1)} MB).`); await load(); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Backup failed'); }
    finally { setBusy(false); }
  };
  const fmtSize = (b: number | null) => b == null ? '' : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const fmtDate = (d: string | null) => d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h2 className="font-semibold text-brand-ink">Data backups</h2>
        <button onClick={now} disabled={busy} className="rounded-lg bg-brand-ink text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60">{busy ? 'Backing up…' : 'Back up now'}</button>
      </div>
      <p className="text-xs text-neutral-500 mb-3">A full snapshot of all timekeeping data runs automatically every Monday. The newest 12 are kept — download any as a JSON file. (Supabase also backs up the database daily.)</p>
      {!items ? <p className="text-sm text-neutral-400">Loading…</p> : items.length === 0 ? (
        <p className="text-sm text-neutral-500">No snapshots yet — click “Back up now” to create the first one.</p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {items.map((b) => (
            <li key={b.key} className="py-2 flex items-center justify-between gap-2 text-sm">
              <div><div className="font-medium">{fmtDate(b.created_at)}</div><div className="text-xs text-neutral-400">{b.rows != null ? `${b.rows.toLocaleString()} rows · ` : ''}{fmtSize(b.bytes)}</div></div>
              <button onClick={() => downloadBackup(b.key)} className="text-emerald-700 underline whitespace-nowrap">Download</button>
            </li>
          ))}
        </ul>
      )}
      {msg && <div className="text-sm text-neutral-600 mt-2">{msg}</div>}
    </div>
  );
}

function Reminders() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [hours, setHours] = useState(12);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const { settings: s } = await setupLoad();
    setEnabled(s.clockout_reminder_enabled !== false);
    if (typeof s.clockout_reminder_hours === 'number') setHours(s.clockout_reminder_hours);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (key: string, value: unknown) => {
    setBusy(true); setSaved(false);
    try { await adminAction({ type: 'set_setting', key, value }); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); await load(); }
    finally { setBusy(false); }
  };

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm">
      <h2 className="font-semibold text-brand-ink mb-3">Forgot-to-clock-out reminders</h2>
      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <span className="text-sm text-neutral-700">Text employees who are still clocked in too long</span>
          <button role="switch" aria-checked={!!enabled} disabled={busy || enabled === null}
            onClick={() => { const v = !enabled; setEnabled(v); save('clockout_reminder_enabled', v); }}
            className={['relative inline-flex h-6 w-11 items-center rounded-full transition', enabled ? 'bg-emerald-600' : 'bg-neutral-300'].join(' ')}>
            <span className={['inline-block h-5 w-5 transform rounded-full bg-white transition', enabled ? 'translate-x-5' : 'translate-x-0.5'].join(' ')} />
          </button>
        </label>
        <label className="text-sm text-neutral-700 flex items-center gap-2">
          Remind after
          <input type="number" min={1} max={24} value={hours} disabled={busy || !enabled}
            onChange={(e) => setHours(Number(e.target.value))}
            onBlur={() => save('clockout_reminder_hours', hours)}
            className="w-16 rounded border border-neutral-300 px-2 py-1 disabled:bg-neutral-100" />
          hours clocked in
        </label>
        {saved && <span className="text-sm text-emerald-700">Saved</span>}
      </div>
      <p className="text-xs text-neutral-400 mt-3">Runs hourly. Each person is texted at most once per shift, only if still clocked in past the threshold.</p>
    </div>
  );
}
