// Clock-in/out state machine. Server-authoritative: the caller passes the
// employee's current open state (derived from punch_events) and the requested
// action; this decides whether the action is legal and what event to write.
// Pure — no I/O — so every branch is unit-testable.

export type PunchAction = 'clock_in' | 'clock_out' | 'location_transfer' | 'department_transfer';

export interface ClockState {
  isClockedIn: boolean;
  locationId: string | null;
  departmentId: string | null;
}

export interface PunchRequest {
  action: PunchAction;
  locationId?: string | null;
  departmentId?: string | null;
  requireLocation: boolean;   // from app_settings
  requireDepartment: boolean; // from app_settings
}

export type PunchDecision =
  | { ok: true; eventType: 'clock_in' | 'clock_out' | 'location_transfer' | 'department_transfer';
      closesSegment: boolean; opensSegment: boolean }
  | { ok: false; code: PunchErrorCode; message: string };

export type PunchErrorCode =
  | 'already_clocked_in' | 'not_clocked_in'
  | 'location_required' | 'department_required'
  | 'no_change' | 'invalid_action';

export function decidePunch(state: ClockState, req: PunchRequest): PunchDecision {
  const needsLoc = req.requireLocation && !req.locationId;
  const needsDept = req.requireDepartment && !req.departmentId;

  switch (req.action) {
    case 'clock_in': {
      if (state.isClockedIn)
        return err('already_clocked_in', 'You are already clocked in.');
      if (needsLoc) return err('location_required', 'Select a location to clock in.');
      if (needsDept) return err('department_required', 'Select a department to clock in.');
      return { ok: true, eventType: 'clock_in', closesSegment: false, opensSegment: true };
    }
    case 'clock_out': {
      if (!state.isClockedIn)
        return err('not_clocked_in', 'You are not clocked in.');
      return { ok: true, eventType: 'clock_out', closesSegment: true, opensSegment: false };
    }
    case 'location_transfer': {
      if (!state.isClockedIn) return err('not_clocked_in', 'Clock in before transferring.');
      if (!req.locationId) return err('location_required', 'Choose the new location.');
      if (req.locationId === state.locationId)
        return err('no_change', 'That is already your current location.');
      // A transfer closes the current segment and opens a new one atomically.
      return { ok: true, eventType: 'location_transfer', closesSegment: true, opensSegment: true };
    }
    case 'department_transfer': {
      if (!state.isClockedIn) return err('not_clocked_in', 'Clock in before transferring.');
      if (!req.departmentId) return err('department_required', 'Choose the new department.');
      if (req.departmentId === state.departmentId)
        return err('no_change', 'That is already your current department.');
      return { ok: true, eventType: 'department_transfer', closesSegment: true, opensSegment: true };
    }
    default:
      return err('invalid_action', 'Unknown action.');
  }
}

function err(code: PunchErrorCode, message: string): PunchDecision {
  return { ok: false, code, message };
}

/**
 * Idempotency key for a punch submission. The client sends a stable key per
 * intended action (regenerated only when the user changes the action), so a
 * double-tap or a network retry collapses to a single event server-side.
 */
export function punchIdempotencyKey(
  employeeId: string, action: PunchAction, clientNonce: string,
): string {
  return `${employeeId}:${action}:${clientNonce}`;
}

// Minimal shape of a stored event needed to reconstruct clock state.
export interface StoredEvent {
  event_type: string;
  location_id: string | null;
  department_id: string | null;
  server_ts: string; // ISO
}

/**
 * Server-authoritative clock state derived by replaying the ordered event log.
 * clock_in / *_transfer set (and update) the open location/department;
 * clock_out closes it. Events are sorted by server_ts ascending defensively.
 */
export function deriveClockState(events: StoredEvent[]): ClockState & { startedAt: string | null } {
  const ordered = [...events].sort((a, b) => a.server_ts.localeCompare(b.server_ts));
  let isClockedIn = false;
  let locationId: string | null = null;
  let departmentId: string | null = null;
  let startedAt: string | null = null;

  for (const e of ordered) {
    switch (e.event_type) {
      case 'clock_in':
        isClockedIn = true; locationId = e.location_id; departmentId = e.department_id; startedAt = e.server_ts;
        break;
      case 'location_transfer':
        if (isClockedIn) locationId = e.location_id;
        break;
      case 'department_transfer':
        if (isClockedIn) departmentId = e.department_id;
        break;
      case 'clock_out':
        isClockedIn = false; locationId = null; departmentId = null; startedAt = null;
        break;
      default:
        break; // corrections/approvals/etc. do not change live clock state here
    }
  }
  return { isClockedIn, locationId, departmentId, startedAt };
}
