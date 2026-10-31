-- Enable + force RLS on every otc table. With no permissive policies, anon and
-- authenticated roles get zero rows (deny-all); the Netlify service-role client
-- bypasses RLS. Scoped employee/admin policies are added alongside auth wiring.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'otc'
  loop
    execute format('alter table otc.%I enable row level security;', t);
    execute format('alter table otc.%I force row level security;', t);
  end loop;
end $$;
