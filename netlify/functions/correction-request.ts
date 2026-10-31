import { requireEmployee } from './_shared/auth';
import { json, error, readJson, requireMethod } from './_shared/http';
import { postChannel } from './_shared/teamchat';

type Kind = 'missed_clock_in' | 'missed_clock_out' | 'incorrect_time' | 'wrong_location' | 'wrong_department' | 'other';

interface Body {
  kind: Kind;
  targetEventId?: string | null;
  requestedTs?: string | null;
  requestedLocationId?: string | null;
  requestedDepartmentId?: string | null;
  explanation: string;
}

const KINDS: Kind[] = ['missed_clock_in', 'missed_clock_out', 'incorrect_time', 'wrong_location', 'wrong_department', 'other'];

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { admin, employee } = await requireEmployee(req);
    const body = await readJson<Body>(req);

    if (!KINDS.includes(body.kind)) return error(400, 'bad_kind', 'Unknown correction kind.');
    if (!body.explanation || body.explanation.trim().length < 3)
      return error(400, 'explanation_required', 'Please explain the correction.');

    // If a target event is named, it must belong to this employee.
    if (body.targetEventId) {
      const { data: ev } = await admin.from('punch_events').select('employee_id').eq('id', body.targetEventId).maybeSingle();
      if (!ev || ev.employee_id !== employee.id)
        return error(403, 'not_your_event', 'That punch does not belong to you.');
    }

    const { data, error: iErr } = await admin.from('correction_requests').insert({
      employee_id: employee.id,
      target_event_id: body.targetEventId ?? null,
      kind: body.kind,
      requested_ts: body.requestedTs ?? null,
      requested_location_id: body.requestedLocationId ?? null,
      requested_department_id: body.requestedDepartmentId ?? null,
      explanation: body.explanation.trim(),
      status: 'pending',
    }).select('id, status, created_at').maybeSingle();
    if (iErr) return error(500, 'db_error', `Could not submit request: ${iErr.message}`);

    await admin.from('audit_logs').insert({
      actor_label: `employee:${employee.first_name}`, action: 'correction_requested',
      entity: 'correction_requests', entity_id: data?.id ?? null,
      after_value: { kind: body.kind },
    });

    // Notify the admins in Team Chat only — the payroll channel (tagging the owner
    // III) plus a DM to him. Email was removed per the owner (no email on every missed
    // punch); Team Chat is the single notification channel now. Best-effort —
    // never blocks the request.
    const { data: emp } = await admin.from('employees').select('first_name, last_name, email').eq('id', employee.id).maybeSingle();
    const who = emp ? `${emp.first_name} ${emp.last_name}` : 'An employee';
    const kindLabel = body.kind.replace(/_/g, ' ');
    const when = body.requestedTs ? new Date(body.requestedTs).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '(not given)';
    const chatBody =
      `New missed-punch / correction request from ${who} (${emp?.email ?? ''}).\n` +
      `Type: ${kindLabel}\nRequested time: ${when}\n` +
      `Reason: ${body.explanation.trim()}\n\n` +
      `Review it in the admin panel: https://timeclock.example.com`;
    // Post to the payroll channel ONLY — no @-mention and no DM. the owner asked
    // not to be tagged or DM'd on every punch change; the untagged channel post
    // stays so the request is still visible to whoever watches #payroll.
    const chatChannel = await postChannel('payroll', chatBody);

    // Persist the send outcome so failures are visible.
    await admin.from('audit_logs').insert({
      action: 'correction_notify_result', entity: 'correction_requests', entity_id: data?.id ?? null,
      after_value: { chat_channel: chatChannel.ok },
    });

    return json({ ok: true, request: data }, 201);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] correction error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/correction-request' };
