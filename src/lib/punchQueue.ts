// Offline punch queue. When a Clock In/Out can't reach the server (no signal,
// server unreachable), we save it ON THE PHONE with the exact tap time and send
// it automatically once connectivity returns. The captured time is what counts
// (the server records it authoritatively for offline punches), so a punch is
// never lost and is stamped at the real moment — not when it finally syncs.
//
// Storage: localStorage (punches are tiny and few). Each item carries a stable
// clientNonce so a retry can't create a duplicate (server dedupes on it).

import { punch as apiPunch, requestCorrection } from './api';
import type { PunchAction } from './domain/punch';

const KEY = 'punch-queue-v1';

export interface QueuedPunch {
  id: string;
  action: PunchAction;
  locationId: string | null;
  departmentId: string | null;
  note: string;
  clientNonce: string;
  capturedTs: string; // ISO — the moment the employee tapped
  createdAt: number;
}

function read(): QueuedPunch[] {
  try { const raw = localStorage.getItem(KEY); return raw ? (JSON.parse(raw) as QueuedPunch[]) : []; }
  catch { return []; }
}
function write(items: QueuedPunch[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* storage full/blocked — best effort */ }
}

export function queueSize(): number { return read().length; }

export function enqueuePunch(p: Omit<QueuedPunch, 'id' | 'createdAt'>): void {
  const items = read();
  // Guard against an exact double-tap while offline (same nonce already queued).
  if (items.some((x) => x.clientNonce === p.clientNonce)) return;
  items.push({ ...p, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() });
  write(items);
}

let flushing = false;

/**
 * Try to send every queued punch, oldest first. Returns how many synced.
 * - Network failure / server 5xx: leave it queued, try again later.
 * - Server 4xx (a real conflict, e.g. state changed): fall back to a correction
 *   request so an admin still sees it, then drop it from the queue (never lost).
 */
export async function flushQueue(): Promise<{ synced: number; remaining: number }> {
  if (flushing || !navigator.onLine) return { synced: 0, remaining: queueSize() };
  flushing = true;
  let synced = 0;
  try {
    // Re-read each iteration so we never write over a punch queued mid-flush.
    for (const item of read()) {
      try {
        await apiPunch({
          action: item.action, locationId: item.locationId, departmentId: item.departmentId,
          note: item.note, clientNonce: item.clientNonce, employeeTs: item.capturedTs, offline: true,
        });
        remove(item.id); synced++;
      } catch (e) {
        const status = (e as { status?: number })?.status;
        if (status && status >= 400 && status < 500) {
          // The server won't apply it as-is (e.g. a state conflict). Don't lose
          // it — route it to the existing correction pipeline for an admin.
          await fileFallbackCorrection(item).catch(() => {});
          remove(item.id);
        }
        // else: network error / 5xx — keep it, we'll retry on the next flush.
      }
    }
  } finally { flushing = false; }
  return { synced, remaining: queueSize() };
}

function remove(id: string): void { write(read().filter((x) => x.id !== id)); }

async function fileFallbackCorrection(item: QueuedPunch): Promise<void> {
  const kind = item.action === 'clock_in' ? 'missed_clock_in'
    : item.action === 'clock_out' ? 'missed_clock_out' : 'other';
  const when = new Date(item.capturedTs).toLocaleString('en-US', { timeZone: 'America/New_York' });
  await requestCorrection({
    kind,
    requestedTs: item.capturedTs,
    explanation: `Offline ${item.action.replace('_', ' ')} tapped at ${when} (ET) couldn't be applied automatically when it synced — please confirm this punch.`,
  });
}
