import { useCallback, useEffect, useState } from 'react';
import { punch as apiPunch, clockBootstrap, type StatusResponse } from '../../lib/api';
import { deriveClockState, type PunchAction, type StoredEvent } from '../../lib/domain/punch';
import { enqueuePunch, flushQueue, queueSize } from '../../lib/punchQueue';
import ClockScreen, { type Option, type RecentItem, type PunchPayload } from './ClockScreen';
import MyTimeCard from './MyTimeCard';
import MyHours from './MyHours';

export default function EmployeeHome({ firstName, employeeId, defaultLocationId, defaultDepartmentId, canManageOwnTime, onSignOut }: { firstName: string; employeeId: string; defaultLocationId?: string | null; defaultDepartmentId?: string | null; canManageOwnTime?: boolean; onSignOut: () => void }) {
  const [showTimeCard, setShowTimeCard] = useState(false);
  const [showHours, setShowHours] = useState(false);
  const [locations, setLocations] = useState<Option[]>([]);
  const [departments, setDepartments] = useState<Option[]>([]);
  const [status, setStatus] = useState<StatusResponse>({ isClockedIn: false, locationId: null, departmentId: null, startedAt: null });
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(() => queueSize());
  // The salon/role this person last clocked into — so the pickers default to
  // where they were last, not always their home salon (a two-salon person kept
  // silently defaulting to home and recording the wrong salon).
  const [lastLoc, setLastLoc] = useState<string | null>(null);
  const [lastDept, setLastDept] = useState<string | null>(null);

  const load = useCallback(async () => {
    // One authenticated call (works for chat + legacy sessions); no direct DB reads.
    const b = await clockBootstrap();
    const allLoc: Option[] = b.locations;
    const allDept: Option[] = b.departments;
    // Restrict to the jobs this person actually holds in Gusto (their assignments).
    // If they have none on file, fall back to all active so no one is ever blocked.
    const permLoc = new Set(b.myLocationIds);
    const permDept = new Set(b.myDepartmentIds);
    let locOpts = permLoc.size ? allLoc.filter((l) => permLoc.has(l.id)) : allLoc;
    let deptOpts = permDept.size ? allDept.filter((d) => permDept.has(d.id)) : allDept;
    if (!locOpts.length) locOpts = allLoc;
    if (!deptOpts.length) deptOpts = allDept;
    setLocations(locOpts); setDepartments(deptOpts);

    const events = b.events;
    const derived = deriveClockState((events as unknown as StoredEvent[]) ?? []);
    setStatus(derived);
    const locName = (id: string | null) => locOpts.find((o) => o.id === id)?.name;
    const deptName = (id: string | null) => deptOpts.find((o) => o.id === id)?.name;
    setRecent((events ?? []).map((e) => ({ id: e.id, event_type: e.event_type, server_ts: e.server_ts, location: locName(e.location_id), department: deptName(e.department_id) })));
    // Events come back newest-first — remember the most recent salon/role used.
    setLastLoc((events ?? []).find((e) => e.location_id)?.location_id ?? null);
    setLastDept((events ?? []).find((e) => e.department_id)?.department_id ?? null);
  }, [employeeId]);

  // Send anything sitting in the offline queue, then refresh true state.
  const flushNow = useCallback(async () => {
    const before = queueSize();
    if (!before || !navigator.onLine) return;
    const r = await flushQueue();
    setPending(queueSize());
    if (r.synced > 0) await load().catch(() => {});
  }, [load]);

  useEffect(() => { load().catch((e) => setErr(e.message)).finally(() => { setLoading(false); flushNow(); }); }, [load, flushNow]);

  // Flush the queue the instant the connection comes back.
  useEffect(() => {
    const onOnline = () => { flushNow(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flushNow]);

  // Keep the screen honest: re-sync from the server whenever the tab regains
  // focus (a tab left open for hours goes stale otherwise — the client would
  // show "clocked in" long after the real state changed elsewhere).
  useEffect(() => {
    const resync = () => { if (!document.hidden) { flushNow(); load().catch(() => {}); } };
    window.addEventListener('focus', resync);
    document.addEventListener('visibilitychange', resync);
    const iv = setInterval(resync, 45000); // self-heal if the screen sits open
    return () => { window.removeEventListener('focus', resync); document.removeEventListener('visibilitychange', resync); clearInterval(iv); };
  }, [load, flushNow]);

  const onPunch = async (action: PunchAction, payload: PunchPayload): Promise<'synced' | 'queued'> => {
    const capturedTs = payload.capturedTs;
    try {
      const res = await apiPunch({ action, locationId: payload.locationId, departmentId: payload.departmentId, note: payload.note, clientNonce: payload.clientNonce, employeeTs: capturedTs });
      setStatus(res.status);
      await load();
      return 'synced';
    } catch (e) {
      const httpStatus = (e as { status?: number })?.status;
      // Couldn't reach the server (offline, network error, or a 5xx) — DON'T lose
      // the punch: save it on the phone with the exact tap time and sync later.
      const networkish = !navigator.onLine || e instanceof TypeError || httpStatus === undefined || (typeof httpStatus === 'number' && httpStatus >= 500);
      if (networkish) {
        enqueuePunch({ action, locationId: payload.locationId || null, departmentId: payload.departmentId || null, note: payload.note, clientNonce: payload.clientNonce, capturedTs });
        setPending(queueSize());
        applyOptimistic(action, payload, capturedTs);
        return 'queued';
      }
      // A real rejection (e.g. "already clocked in", access disabled) — our view
      // is wrong, so re-sync and surface the message.
      await load().catch(() => {});
      throw e;
    }
  };

  // Reflect a queued punch immediately so the screen isn't stuck on the old state.
  const applyOptimistic = (action: PunchAction, payload: PunchPayload, capturedTs: string) => {
    if (action === 'clock_in') setStatus({ isClockedIn: true, locationId: payload.locationId || null, departmentId: payload.departmentId || null, startedAt: capturedTs });
    else if (action === 'clock_out') setStatus({ isClockedIn: false, locationId: null, departmentId: null, startedAt: null });
    const locName = (id: string | null) => locations.find((o) => o.id === id)?.name;
    const deptName = (id: string | null) => departments.find((o) => o.id === id)?.name;
    setRecent((prev) => [{ id: `pending-${payload.clientNonce}`, event_type: action, server_ts: capturedTs, location: locName(payload.locationId), department: deptName(payload.departmentId) }, ...prev]);
  };

  if (loading) return <Centered>Loading…</Centered>;
  if (err) return (
    <Centered>
      {navigator.onLine
        ? <>Something went wrong loading your clock. Pull down to refresh, or tap Retry.<br /><button onClick={() => { setLoading(true); setErr(null); load().catch((e) => setErr(e.message)).finally(() => setLoading(false)); }} className="mt-3 underline">Retry</button></>
        : <>📶 You're offline. The clock needs a connection to load your status. Reconnect and it'll load automatically.</>}
    </Centered>
  );

  if (showHours) {
    return <MyHours onBack={() => setShowHours(false)} />;
  }
  if (showTimeCard && canManageOwnTime) {
    return <MyTimeCard firstName={firstName} onBack={() => { setShowTimeCard(false); load().catch(() => {}); }} />;
  }

  return (
    <ClockScreen firstName={firstName} locations={locations} departments={departments}
      status={status} recent={recent} onPunch={onPunch} onSignOut={onSignOut} pending={pending}
      canManageOwnTime={canManageOwnTime} onOpenTimeCard={() => setShowTimeCard(true)}
      onOpenHours={() => setShowHours(true)}
      defaultLocationId={lastLoc ?? defaultLocationId} defaultDepartmentId={lastDept ?? defaultDepartmentId} />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="min-h-full flex items-center justify-center text-neutral-500 bg-brand-cream px-6 text-center">{children}</div>;
}
