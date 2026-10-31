-- 0005 — Fix runaway duplicate rows in otc.user_roles.
--
-- Bug: the unique index on (auth_user_id, role, location_id) was a PLAIN unique
-- index. For the bootstrap admins, roles are stored with location_id = NULL, and
-- Postgres treats every NULL as distinct — so the index never blocked duplicate
-- (user, 'system_admin', NULL) rows. link-account / set-password grant the
-- bootstrap admin role on every login via `upsert(..., onConflict:
-- 'auth_user_id,role,location_id', ignoreDuplicates)`, but ON CONFLICT never
-- fired (NULL != NULL), so each login inserted another row. Two admins piled up
-- ~992 duplicate rows (1003 total for 11 real grants). That pushed the admin
-- UI's `select auth_user_id, role from user_roles` past PostgREST's 1000-row
-- default, so other users' roles (e.g. another admin's role) never loaded and
-- showed as "Employee" — and re-saving couldn't fix what it couldn't read back.
--
-- Fix: dedupe, then recreate the unique index with NULLS NOT DISTINCT (PG15+) so
-- the existing onConflict upserts actually collapse NULL-location duplicates.

begin;

delete from otc.user_roles ur
using otc.user_roles keep
where ur.auth_user_id = keep.auth_user_id
  and ur.role = keep.role
  and ur.location_id is not distinct from keep.location_id
  and ur.id > keep.id;

alter table otc.user_roles drop constraint if exists user_roles_auth_user_id_role_location_id_key;
drop index if exists otc.user_roles_auth_user_id_role_location_id_key;
create unique index user_roles_auth_user_id_role_location_id_key
  on otc.user_roles (auth_user_id, role, location_id) nulls not distinct;

commit;
