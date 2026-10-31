import { useEffect, useMemo, useRef, useState } from 'react';
import { formatElapsed, durationSeconds } from '../../lib/time';
import type { PunchAction } from '../../lib/domain/punch';
import { type StatusResponse, requestCorrection } from '../../lib/api';
import { quoteForDay } from '../../data/quotes';
import { APP_VERSION, BUILT_AT } from '../../lib/version';
import HelpModal from '../help/HelpModal';

export interface Option { id: string; name: string }
export interface RecentItem { id: string; event_type: string; server_ts: string; location?: string; department?: string }
export interface PunchPayload { locationId: string; departmentId: string; note: string; clientNonce: string; capturedTs: string }

export interface ClockScreenProps {
  firstName: string;
  locations: Option[];
  departments: Option[];
  status: StatusResponse;
  recent: RecentItem[];
  onPunch: (action: PunchAction, payload: PunchPayload) => Promise<'synced' | 'queued'>;
  onSignOut?: () => void;
  pending?: number;
  canManageOwnTime?: boolean;
  onOpenTimeCard?: () => void;
  onOpenHours?: () => void;
  defaultLocationId?: string | null;
  defaultDepartmentId?: string | null;
}

export default function ClockScreen({ firstName, locations, departments, status, recent, onPunch, onSignOut, pending = 0, canManageOwnTime, onOpenTimeCard, onOpenHours, defaultLocationId, defaultDepartmentId }: ClockScreenProps) {
  const [now, setNow] = useState(() => new Date());
  // Default the pickers to the employee's home location/department when set (and
  // valid for them); otherwise fall back to the first option they're allowed.
  const pick = (opts: Option[], preferred?: string | null) => opts.find((o) => o.id === preferred)?.id ?? opts[0]?.id ?? '';
  const [location, setLocation] = useState(() => status.locationId ?? pick(locations, defaultLocationId));
  const [department, setDepartment] = useState(() => status.departmentId ?? pick(departments, defaultDepartmentId));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [showCorrection, setShowCorrection] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const quote = useMemo(() => quoteForDay(now), [now.getFullYear(), now.getMonth(), now.getDate()]);
  // The Standard — Daily (Team 5.0): replaces the rotating quote when the feed
  // has today's line; falls back to quoteForDay silently if unreachable.
  const [standardLine, setStandardLine] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Same-origin first: Team Time Clock's own backend reads the shared standards bank,
    // so this never depends on reaching the command-center host (an ISP
    // black-holed *.netlify.app on Sep 18). The Cloudflare proxy is a backup.
    // A short timeout guarantees a slow feed can never hold anything up — the
    // quote shows immediately regardless (standardLine ?? quote).
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    fetch('/api/standard-today', { signal: ctrl.signal })
      .then(r => r.json())
      .catch(() => fetch('/api/standard-today').then(r => r.json()))
      .then(j => { if (alive && j && j.line) setStandardLine(j.line); })
      .catch(() => {})
      .finally(() => clearTimeout(t));
    return () => { alive = false; ctrl.abort(); clearTimeout(t); };
  }, [now.getFullYear(), now.getMonth(), now.getDate()]);
  const nonce = useRef(newNonce());

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  // Keep selects in sync when the server status changes (e.g. after a punch).
  useEffect(() => { if (status.locationId) setLocation(status.locationId); if (status.departmentId) setDepartment(status.departmentId); }, [status.locationId, status.departmentId]);

  const startedAt = status.startedAt ? new Date(status.startedAt) : null;
  const elapsed = startedAt ? durationSeconds(startedAt, now) : 0;
  const locName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? '';
  const deptName = (id: string | null) => departments.find((d) => d.id === id)?.name ?? '';

  const submit = async () => {
    if (busy) return;
    const wasClockedIn = status.isClockedIn;
    const capturedTs = new Date().toISOString(); // the exact tap moment — what counts if we queue
    setBusy(true);
    try {
      const outcome = await onPunch(wasClockedIn ? 'clock_out' : 'clock_in', { locationId: location, departmentId: department, note, clientNonce: nonce.current, capturedTs });
      setNote('');
      nonce.current = newNonce();
      if (outcome === 'queued') {
        flash('ok', wasClockedIn
          ? "Saved on your phone — we'll send your clock-out the moment you're back online. ✓"
          : "Saved on your phone — we'll send your clock-in the moment you're back online. ✓");
      } else {
        flash('ok', wasClockedIn ? 'Clocked out' : 'Clocked in');
      }
    } catch (e) {
      // Only real rejections land here now (network failures are queued, not thrown).
      flash('err', e instanceof Error ? e.message : 'Punch could not be recorded. Please try again.');
    } finally { setBusy(false); }
  };

  function flash(kind: 'ok' | 'err', msg: string) { setToast({ kind, msg }); setTimeout(() => setToast(null), 3500); }

  const dateStr = useMemo(() => now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' }), [now]);

  return (
    <div className="min-h-full flex flex-col items-center px-4 safe-top safe-bottom bg-brand-cream">
      {!online && (
        <div className="w-full max-w-md mt-2 rounded-xl bg-amber-100 border border-amber-300 text-amber-900 text-sm text-center px-4 py-2">
          📶 You're offline — but you can still clock in and out. Your punches save on this phone and send automatically when you reconnect.
        </div>
      )}
      {pending > 0 && (
        <div className="w-full max-w-md mt-2 rounded-xl bg-blue-50 border border-blue-200 text-blue-900 text-sm text-center px-4 py-2">
          ⏳ {pending} punch{pending === 1 ? '' : 'es'} saved on your phone, waiting to send{online ? '…' : ' when you reconnect'}.
        </div>
      )}
      <header className="w-full max-w-md pt-6 pb-3 flex items-center justify-between">
        <div className="text-brand-ink font-semibold tracking-wide">SAMPLE SALON CO</div>
        <div className="flex items-center gap-3 text-xs">
          <button onClick={() => setShowHelp(true)} className="rounded-full bg-brand-ink text-white px-3 py-1 font-medium">? Help</button>
          {onSignOut && <button onClick={onSignOut} className="text-neutral-500 underline">Sign out</button>}
        </div>
      </header>

      <main className="w-full max-w-md flex-1 flex flex-col gap-4">
        <div className="text-center">
          <div className="text-2xl font-semibold text-brand-ink">Hi, {firstName}</div>
          <div className="text-sm text-neutral-500">{dateStr}</div>
          <div className="text-4xl font-bold tabular-nums text-brand-ink mt-1">{timeStr(now)}</div>
        </div>

        <div className={['rounded-2xl px-5 py-4 border text-center', status.isClockedIn ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-neutral-200'].join(' ')}>
          <div className={['text-sm font-bold tracking-wide', status.isClockedIn ? 'text-emerald-700' : 'text-neutral-500'].join(' ')}>
            {status.isClockedIn ? 'CLOCKED IN' : 'CLOCKED OUT'}
          </div>
          {status.isClockedIn && (
            <>
              <div className="text-3xl font-bold tabular-nums text-emerald-800 mt-1">{formatElapsed(elapsed)}</div>
              <div className="text-xs text-neutral-500 mt-1">{locName(status.locationId)} · {deptName(status.departmentId)} · since {startedAt ? timeStr(startedAt) : ''}</div>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select label="Location" value={location} onChange={setLocation} options={locations} disabled={status.isClockedIn} highlight={locations.length > 1 && !status.isClockedIn} />
          <Select label="Department" value={department} onChange={setDepartment} options={departments} disabled={status.isClockedIn} />
        </div>
        {locations.length > 1 && !status.isClockedIn && (
          <p className="-mt-1 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">📍 You work at more than one salon — make sure <b>Location</b> above is the salon you’re at <b>right now</b> before you clock in.</p>
        )}

        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)"
          className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-base bg-white" aria-label="Optional note" />

        <button onClick={submit} disabled={busy} aria-live="polite"
          className={['w-full rounded-2xl py-6 text-2xl font-bold text-white transition active:scale-[0.99] disabled:opacity-60', status.isClockedIn ? 'bg-red-600' : 'bg-emerald-600'].join(' ')}>
          {busy ? 'Working…' : status.isClockedIn ? 'Clock Out' : 'Clock In'}
        </button>

        {recent.length > 0 && (
          <section className="mt-1">
            <h2 className="text-xs uppercase tracking-wide text-neutral-500 mb-1">Recent punches</h2>
            <ul className="divide-y divide-neutral-200 rounded-xl bg-white border border-neutral-200">
              {recent.map((r) => (
                <li key={r.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="font-medium">{label(r.event_type)}</span>
                  <span className="text-neutral-500">{[r.location, r.department].filter(Boolean).join(' · ')}</span>
                  <span className="tabular-nums text-neutral-700">{timeStr(new Date(r.server_ts))}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {onOpenHours && (
          <button onClick={onOpenHours}
            className="w-full rounded-2xl border-2 border-brand-ink/20 bg-white py-3 text-base font-semibold text-brand-ink mt-1">
            📊 My Hours — see my totals
          </button>
        )}
        {canManageOwnTime && onOpenTimeCard && (
          <button onClick={onOpenTimeCard}
            className="w-full rounded-2xl border-2 border-brand-ink/20 bg-white py-3 text-base font-semibold text-brand-ink mt-1">
            🗓️ My Time Card — add or fix my hours
          </button>
        )}

        <button onClick={() => setShowCorrection(true)}
          className="text-sm text-neutral-500 underline self-center mt-1">
          Report a missed or incorrect punch
        </button>

        <div className="mt-2 rounded-2xl bg-white/70 border border-neutral-200 px-5 py-4 text-center">
          <div className="text-[11px] uppercase tracking-wide text-brand-gold font-semibold">{standardLine ? 'The Standard — Daily' : 'Thought of the day'}</div>
          <p className="text-brand-ink mt-1 leading-snug">&ldquo;{standardLine ?? quote.text}&rdquo;</p>
          <div className="text-xs text-neutral-500 mt-1">— {standardLine ? 'Our Standard' : quote.author}</div>
          <div className="text-xs text-neutral-400 mt-3">Thank you for being part of the Team family. You're amazing. 💛</div>
        </div>

        <footer className="text-[11px] text-neutral-400 text-center mt-3 mb-2">
          Team Time Clock {APP_VERSION} · updated {BUILT_AT}
        </footer>
      </main>

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {showCorrection && (
        <CorrectionModal
          onClose={() => setShowCorrection(false)}
          onDone={() => { setShowCorrection(false); flash('ok', 'Correction request sent to your manager'); }}
          onError={(m) => flash('err', m)}
        />
      )}

      {toast && (
        <div className={['fixed bottom-5 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl text-white text-sm font-medium shadow-lg', toast.kind === 'ok' ? 'bg-emerald-700' : 'bg-red-700'].join(' ')} role="status">
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Select({ label, value, onChange, options, disabled, highlight }: { label: string; value: string; onChange: (v: string) => void; options: Option[]; disabled?: boolean; highlight?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={['text-xs uppercase tracking-wide', highlight ? 'text-amber-600 font-semibold' : 'text-neutral-500'].join(' ')}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
        className={['rounded-xl border px-3 py-3 text-base bg-white disabled:bg-neutral-100 disabled:text-neutral-500', highlight ? 'border-amber-400 ring-2 ring-amber-200' : 'border-neutral-300'].join(' ')}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
  );
}

const CORRECTION_KINDS: Array<{ value: string; label: string }> = [
  { value: 'missed_clock_in', label: 'I forgot to clock in' },
  { value: 'missed_clock_out', label: 'I forgot to clock out' },
  { value: 'incorrect_time', label: 'A punch time is wrong' },
  { value: 'wrong_location', label: 'Wrong location' },
  { value: 'wrong_department', label: 'Wrong department' },
  { value: 'other', label: 'Something else' },
];

function CorrectionModal({ onClose, onDone, onError }: { onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [kind, setKind] = useState('missed_clock_out');
  const [when, setWhen] = useState('');
  const [explanation, setExplanation] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (explanation.trim().length < 3) { onError('Please add a short explanation.'); return; }
    setBusy(true);
    try {
      await requestCorrection({
        kind,
        // Interpret the picker value as salon (Eastern) time — NOT the browser's
        // timezone — so a phone set to another zone can't shift the time.
        requestedTs: when ? etLocalToIso(when) : null,
        explanation: explanation.trim(),
      });
      onDone();
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not send request.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-2xl p-5 safe-bottom" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-brand-ink mb-3">Request a correction</h2>
        <label className="block text-sm mb-2">What happened?
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full rounded-xl border border-neutral-300 px-3 py-2 mt-1 bg-white">
            {CORRECTION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>
        <label className="block text-sm mb-2">Correct date &amp; time (set BOTH — Eastern time)
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-full rounded-xl border border-neutral-300 px-3 py-2 mt-1" />
          <span className="block text-xs text-neutral-400 mt-1">Please set the actual time, not just the date. You can also type it in the note (e.g. “clocked out 11:06 AM”).</span>
        </label>
        <label className="block text-sm mb-3">Explanation
          <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={3} placeholder="Tell your manager what should be fixed"
            className="w-full rounded-xl border border-neutral-300 px-3 py-2 mt-1" />
        </label>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl border border-neutral-300 py-3 font-medium">Cancel</button>
          <button onClick={submit} disabled={busy} className="flex-1 rounded-xl bg-emerald-600 text-white py-3 font-bold disabled:opacity-60">{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}

const label = (t: string) => t === 'clock_in' ? 'Clock in' : t === 'clock_out' ? 'Clock out' : t.replace(/_/g, ' ');
function timeStr(d: Date): string { return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); }
function newNonce(): string { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
// Interpret a datetime-local string ("YYYY-MM-DDTHH:MM") as Eastern time -> UTC ISO.
function etLocalToIso(local: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(new Date(`${local}:00Z`)).find((p) => p.type === 'timeZoneName')?.value;
  return new Date(`${local}:00${name === 'EST' ? '-05:00' : '-04:00'}`).toISOString();
}
