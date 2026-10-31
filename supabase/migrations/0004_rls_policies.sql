-- Scoped RLS policies. Model: the browser uses the anon key + the employee's
-- authenticated JWT and may only READ its own data (plus shared reference data);
-- admins read everything. ALL WRITES go through service-role Netlify Functions
-- (service role bypasses RLS), except the two low-risk employee UX writes at the
-- bottom (mark message read / acknowledge).

set search_path to otc, public;

-- ---- helper functions (security definer so they can read role tables) -------
create or replace function otc.current_employee_id()
returns uuid language sql stable security definer set search_path = otc, pg_temp as $$
  select id from otc.employees where auth_user_id = auth.uid()
$$;

create or replace function otc.is_admin()
returns boolean language sql stable security definer set search_path = otc, pg_temp as $$
  select exists (
    select 1 from otc.user_roles
    where auth_user_id = auth.uid() and role in ('payroll_admin','system_admin')
  )
$$;

create or replace function otc.is_staff()
returns boolean language sql stable security definer set search_path = otc, pg_temp as $$
  select exists (
    select 1 from otc.user_roles
    where auth_user_id = auth.uid()
      and role in ('payroll_admin','system_admin','location_manager')
  )
$$;

-- location_manager scoped to a location (null location_id => all locations);
-- admins always true.
create or replace function otc.manages_location(loc uuid)
returns boolean language sql stable security definer set search_path = otc, pg_temp as $$
  select exists (
    select 1 from otc.user_roles r
    where r.auth_user_id = auth.uid()
      and ( r.role in ('payroll_admin','system_admin')
         or (r.role = 'location_manager' and (r.location_id is null or r.location_id = loc)) )
  )
$$;

-- ---- shared reference data: any authenticated user may read ----------------
create policy ref_read on locations   for select to authenticated using (true);
create policy ref_read on departments for select to authenticated using (true);
create policy ref_read on pay_periods for select to authenticated using (true);
create policy settings_read on app_settings for select to authenticated using (true);

-- ---- employees --------------------------------------------------------------
create policy emp_self_or_staff on employees for select to authenticated
using (
  id = otc.current_employee_id()
  or otc.is_admin()
  or ( otc.is_staff() and exists (
        select 1 from otc.employee_location_assignments a
        where a.employee_id = employees.id and otc.manages_location(a.location_id)))
);

create policy empassign_loc_read on employee_location_assignments for select to authenticated
using (employee_id = otc.current_employee_id() or otc.is_staff());
create policy empassign_dept_read on employee_department_assignments for select to authenticated
using (employee_id = otc.current_employee_id() or otc.is_staff());

-- ---- time data: own rows, or staff scoped to managed locations --------------
create policy punch_self_or_staff on punch_events for select to authenticated
using (
  employee_id = otc.current_employee_id()
  or otc.is_admin()
  or (otc.is_staff() and location_id is not null and otc.manages_location(location_id))
);

create policy seg_self_or_staff on shift_segments for select to authenticated
using (
  employee_id = otc.current_employee_id()
  or otc.is_admin()
  or (otc.is_staff() and location_id is not null and otc.manages_location(location_id))
);

create policy corr_self_or_staff on correction_requests for select to authenticated
using (employee_id = otc.current_employee_id() or otc.is_staff());

create policy tca_staff on timecard_approvals for select to authenticated
using (employee_id = otc.current_employee_id() or otc.is_staff());

-- ---- messages: recipients see theirs; admins see all ------------------------
create policy msg_recip_read on message_recipients for select to authenticated
using (employee_id = otc.current_employee_id() or otc.is_admin());
create policy msg_read on messages for select to authenticated
using (
  otc.is_admin()
  or exists (select 1 from otc.message_recipients mr
             where mr.message_id = messages.id and mr.employee_id = otc.current_employee_id())
);
create policy msg_ack_read on message_acknowledgments for select to authenticated
using (employee_id = otc.current_employee_id() or otc.is_admin());

-- ---- admin-only read surfaces ----------------------------------------------
create policy admin_read on payroll_export_runs  for select to authenticated using (otc.is_admin());
create policy admin_read on payroll_export_items for select to authenticated using (otc.is_admin());
create policy admin_read on gusto_connections    for select to authenticated using (otc.is_admin());
create policy admin_read on gusto_sync_runs       for select to authenticated using (otc.is_admin());
create policy admin_read on gusto_webhook_events  for select to authenticated using (otc.is_admin());
create policy admin_read on audit_logs            for select to authenticated using (otc.is_admin());
create policy admin_read on security_events       for select to authenticated using (otc.is_admin());
create policy admin_read on user_roles            for select to authenticated using (otc.is_admin());
create policy admin_read on device_sessions       for select to authenticated
  using (employee_id = otc.current_employee_id() or otc.is_admin());

-- ---- two low-risk employee UX writes (everything else is service-role) ------
create policy msg_recip_mark_read on message_recipients for update to authenticated
using (employee_id = otc.current_employee_id())
with check (employee_id = otc.current_employee_id());

create policy msg_ack_insert on message_acknowledgments for insert to authenticated
with check (employee_id = otc.current_employee_id());
