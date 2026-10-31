-- Team Time Clock — core schema
-- Principles:
--   * punch_events is append-only and is the source of truth
--   * all timestamps stored UTC (timestamptz); display tz is America/New_York
--   * durations derived in seconds; no rounding of raw punches
--   * immutable link to Gusto via gusto_employee_uuid
-- Apply with: supabase db push  (or the Supabase MCP apply_migration)
--
-- Isolation: On the Clock lives in its own `otc` schema so it can safely share
-- the brand-command-center Postgres project without colliding with that app's
-- public tables. gen_random_uuid() is core in Postgres 13+ (pg_catalog), so no
-- extension is required.

create schema if not exists otc;
set search_path to otc, public;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type timekeeping_access as enum (
  'pending_review','enabled','suspended','disabled','terminated_in_gusto','sync_conflict'
);

create type app_role as enum (
  'employee','location_manager','payroll_admin','system_admin'
);

create type punch_event_type as enum (
  'clock_in','clock_out','location_transfer','department_transfer',
  'manual_entry','admin_correction','employee_correction_request',
  'time_entry_approved','time_entry_locked','time_entry_reopened',
  'gusto_synced','gusto_sync_failed'
);

create type punch_source as enum (
  'employee_mobile','employee_desktop','administrator','import','system'
);

create type approval_state as enum ('open','approved','locked','reopened');

create type correction_kind as enum (
  'missed_clock_in','missed_clock_out','incorrect_time',
  'wrong_location','wrong_department','other'
);

create type correction_status as enum ('pending','approved','rejected','modified');

create type message_priority as enum ('normal','important','urgent');

create type export_status as enum (
  'draft','exported','sync_initiated','sync_processing','sync_completed',
  'sync_partial','sync_failed'
);

-- ---------------------------------------------------------------------------
-- Config: locations & departments (admin-editable, seeded from Gusto/brief)
-- ---------------------------------------------------------------------------
create table locations (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  short_name    text not null,
  gusto_location_uuid uuid,               -- link back to Gusto work location if applicable
  address       text,
  time_zone     text not null default 'America/New_York',
  latitude      numeric(9,6),
  longitude     numeric(9,6),
  geofence_radius_m integer,
  punch_policy  text not null default 'none'
                check (punch_policy in ('none','capture','warn','block','allow_with_note')),
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table departments (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  gusto_department_uuid uuid,
  allow_other   boolean not null default true,
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Employees (identity from Gusto; access controlled locally)
-- ---------------------------------------------------------------------------
create table employees (
  id                    uuid primary key default gen_random_uuid(),
  auth_user_id          uuid unique,                    -- supabase auth.users.id, set on activation
  gusto_company_uuid    uuid not null,
  gusto_employee_uuid   uuid not null unique,           -- immutable identity link
  first_name            text not null,
  middle_initial        text,
  last_name             text not null,
  preferred_first_name  text,
  email                 text not null,
  phone                 text,
  employment_status     text,                           -- full_time / part_time_* / terminated
  hire_date             date,
  termination_date      date,
  primary_job_title     text,
  flsa_status           text,
  gusto_department_name text,
  gusto_work_location   text,
  timekeeping_access    timekeeping_access not null default 'pending_review',
  home_location_id      uuid references locations(id),
  home_department_id    uuid references departments(id),
  can_transfer_location boolean not null default true,
  can_transfer_department boolean not null default true,
  pin_hash              text,                           -- optional device PIN, hashed
  last_synced_at        timestamptz,
  gusto_version         text,                           -- Gusto record version for reconciliation
  raw_gusto             jsonb,                          -- last raw payload (no SSN/sensitive fields)
  last_login_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index employees_access_idx on employees(timekeeping_access);
create index employees_email_idx on employees(lower(email));

create table employee_location_assignments (
  employee_id uuid not null references employees(id) on delete cascade,
  location_id uuid not null references locations(id) on delete restrict,
  is_home     boolean not null default false,
  primary key (employee_id, location_id)
);

create table employee_department_assignments (
  employee_id   uuid not null references employees(id) on delete cascade,
  department_id uuid not null references departments(id) on delete restrict,
  is_default    boolean not null default false,
  primary key (employee_id, department_id)
);

-- ---------------------------------------------------------------------------
-- Roles / RBAC
-- ---------------------------------------------------------------------------
create table user_roles (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  role         app_role not null,
  -- location_manager scoping: null => all locations
  location_id  uuid references locations(id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (auth_user_id, role, location_id)
);
create index user_roles_user_idx on user_roles(auth_user_id);

-- ---------------------------------------------------------------------------
-- Pay periods (seeded from Gusto biweekly schedule; recomputable)
-- ---------------------------------------------------------------------------
create table pay_periods (
  id          uuid primary key default gen_random_uuid(),
  start_date  date not null,
  end_date    date not null,
  check_date  date,
  gusto_pay_period_ref text,
  status      approval_state not null default 'open',
  created_at  timestamptz not null default now(),
  unique (start_date, end_date)
);

-- ---------------------------------------------------------------------------
-- Punch events — APPEND ONLY. Never UPDATE/DELETE in normal operation.
-- ---------------------------------------------------------------------------
create table punch_events (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references employees(id) on delete restrict,
  gusto_employee_uuid uuid not null,
  event_type        punch_event_type not null,
  server_ts         timestamptz not null default now(),  -- authoritative for live punches
  employee_ts       timestamptz,                         -- device time / requested time
  location_id       uuid references locations(id),
  department_id     uuid references departments(id),
  note              text,
  source            punch_source not null,
  device_session_id uuid,
  browser_meta      jsonb,
  latitude          numeric(9,6),
  longitude         numeric(9,6),
  created_by_auth_id uuid,                                -- admin/actor when not the employee
  original_event_id uuid references punch_events(id),     -- for corrections
  correction_reason text,
  approval          approval_state not null default 'open',
  pay_period_id     uuid references pay_periods(id),
  idempotency_key   text unique,                          -- dedupe double-taps / retries
  created_at        timestamptz not null default now()
);
create index punch_events_emp_ts_idx on punch_events(employee_id, server_ts);
create index punch_events_pay_period_idx on punch_events(pay_period_id);
create index punch_events_type_idx on punch_events(event_type);

-- ---------------------------------------------------------------------------
-- Derived shift segments (recomputable from punch_events)
-- ---------------------------------------------------------------------------
create table shift_segments (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references employees(id) on delete cascade,
  location_id   uuid references locations(id),
  department_id uuid references departments(id),
  start_event_id uuid not null references punch_events(id),
  end_event_id   uuid references punch_events(id),
  started_at    timestamptz not null,
  ended_at      timestamptz,
  duration_seconds integer,                    -- null while open
  pay_period_id uuid references pay_periods(id),
  is_open       boolean not null default true,
  has_exception boolean not null default false,
  exception_note text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index shift_segments_emp_idx on shift_segments(employee_id, started_at);
create index shift_segments_open_idx on shift_segments(is_open) where is_open;

-- ---------------------------------------------------------------------------
-- Corrections
-- ---------------------------------------------------------------------------
create table correction_requests (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references employees(id) on delete cascade,
  target_event_id uuid references punch_events(id),
  kind          correction_kind not null,
  requested_ts  timestamptz,
  requested_location_id uuid references locations(id),
  requested_department_id uuid references departments(id),
  explanation   text not null,
  status        correction_status not null default 'pending',
  decided_by_auth_id uuid,
  decision_note text,
  resulting_event_id uuid references punch_events(id),
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index correction_requests_status_idx on correction_requests(status);

-- ---------------------------------------------------------------------------
-- Timecard approvals
-- ---------------------------------------------------------------------------
create table timecard_approvals (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references employees(id) on delete cascade,
  pay_period_id uuid not null references pay_periods(id) on delete cascade,
  state         approval_state not null default 'open',
  approved_by_auth_id uuid,
  approved_at   timestamptz,
  locked_by_auth_id uuid,
  locked_at     timestamptz,
  reopened_by_auth_id uuid,
  reopened_at   timestamptz,
  reopen_reason text,
  edited_after_lock boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (employee_id, pay_period_id)
);

-- ---------------------------------------------------------------------------
-- Payroll export / sync runs (CSV / Smart Import now; direct Gusto later)
-- ---------------------------------------------------------------------------
create table payroll_export_runs (
  id            uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references pay_periods(id),
  kind          text not null default 'csv_smart_import',   -- or 'gusto_time_tracking'
  status        export_status not null default 'draft',
  idempotency_key text unique,
  totals        jsonb,                     -- {employees, regular, overtime, double_ot, ...}
  external_ref  text,                      -- gusto timesheet/payroll-sync uuid when applicable
  created_by_auth_id uuid,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create table payroll_export_items (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references payroll_export_runs(id) on delete cascade,
  employee_id   uuid not null references employees(id),
  gusto_employee_uuid uuid not null,
  regular_seconds   integer not null default 0,
  overtime_seconds  integer not null default 0,
  double_ot_seconds integer not null default 0,
  location_breakdown jsonb,
  department_breakdown jsonb,
  exception_flags   text[],
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Gusto integration
-- ---------------------------------------------------------------------------
create table gusto_connections (
  id            uuid primary key default gen_random_uuid(),
  gusto_company_uuid uuid not null,
  api_version   text not null default '2024-04-01',
  -- tokens encrypted at rest by the edge/function layer; never returned to browser
  access_token_enc  text,
  refresh_token_enc text,
  token_expires_at  timestamptz,
  scopes        text,
  status        text not null default 'not_configured',  -- not_configured|healthy|needs_reauth|error
  last_ok_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table gusto_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'employees',      -- employees|reconcile
  status        text not null default 'running',        -- running|success|error
  added_count   integer not null default 0,
  updated_count integer not null default 0,
  inactive_count integer not null default 0,
  review_count  integer not null default 0,
  error_summary text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create table gusto_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  external_id   text unique,               -- dedupe / idempotency
  event_type    text,
  payload       jsonb,
  processed_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Messages / announcements
-- ---------------------------------------------------------------------------
create table messages (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  body          text not null,
  sender_auth_id uuid,
  audience      jsonb not null,            -- {type:'all'|'location'|'department'|'employees'|'clocked_in'|'enabled', ids:[...]}
  priority      message_priority not null default 'normal',
  require_ack   boolean not null default false,
  publish_at    timestamptz not null default now(),
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table message_recipients (
  message_id  uuid not null references messages(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  viewed_at   timestamptz,
  primary key (message_id, employee_id)
);

create table message_acknowledgments (
  message_id   uuid not null references messages(id) on delete cascade,
  employee_id  uuid not null references employees(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (message_id, employee_id)
);

-- ---------------------------------------------------------------------------
-- Settings, audit, sessions, security
-- ---------------------------------------------------------------------------
create table app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by_auth_id uuid,
  updated_at  timestamptz not null default now()
);

create table audit_logs (
  id            uuid primary key default gen_random_uuid(),
  actor_auth_id uuid,
  actor_label   text,
  action        text not null,
  entity        text,
  entity_id     uuid,
  before_value  jsonb,
  after_value   jsonb,
  pay_period_id uuid,
  is_security_event boolean not null default false,
  created_at    timestamptz not null default now()
);
create index audit_logs_entity_idx on audit_logs(entity, entity_id);
create index audit_logs_created_idx on audit_logs(created_at);

create table device_sessions (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid references employees(id) on delete cascade,
  auth_user_id  uuid,
  label         text,
  user_agent    text,
  trusted       boolean not null default false,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

create table security_events (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid,
  email_attempted text,
  kind          text not null,             -- login_fail|login_ok|pin_fail|lockout|token_refresh_fail|...
  ip_hash       text,
  detail        jsonb,
  created_at    timestamptz not null default now()
);
create index security_events_kind_idx on security_events(kind, created_at);

-- updated_at trigger helper
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger t_locations_updated before update on locations
  for each row execute function set_updated_at();
create trigger t_departments_updated before update on departments
  for each row execute function set_updated_at();
create trigger t_employees_updated before update on employees
  for each row execute function set_updated_at();
create trigger t_shift_segments_updated before update on shift_segments
  for each row execute function set_updated_at();
create trigger t_gusto_connections_updated before update on gusto_connections
  for each row execute function set_updated_at();
