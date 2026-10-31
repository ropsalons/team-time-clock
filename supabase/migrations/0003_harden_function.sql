-- Pin the trigger function's search_path (satisfies the Supabase security linter
-- 0011_function_search_path_mutable).
alter function otc.set_updated_at() set search_path = otc, pg_temp;
