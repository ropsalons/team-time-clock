-- Phone + 4-digit PIN login: short-lived SMS reset codes.
-- Applied to project ickfhzjmmlcjhqlljjwb on 2026-08-12.
--
-- Staff without email sign in with mobile number + a 4-digit PIN. The PIN maps
-- to a Supabase auth user via a synthetic internal email (<digits>@pin.example.com)
-- with the password derived server-side from the PIN (HMAC APP_PIN_SECRET). This
-- table backs the "forgot PIN" flow: a texted 6-digit code, single-use, 15 min.
-- Written/read only by service-role Netlify functions (RLS on, no policies).

create table if not exists otc.pin_reset_codes (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references otc.employees(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists pin_reset_codes_emp_idx on otc.pin_reset_codes (employee_id, created_at desc);
alter table otc.pin_reset_codes enable row level security;
comment on table otc.pin_reset_codes is 'Short-lived SMS codes for resetting a staff 4-digit PIN. Written/read only by service-role Netlify functions.';
