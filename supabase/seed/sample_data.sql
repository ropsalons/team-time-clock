-- FAKE sample data for trying the app. Every name, address and id here is made up.
set search_path = otc, public;
insert into locations (id, display_name, short_name, address) values
 ('10000000-0000-4000-8000-000000000001','Downtown — Springfield','Downtown','100 Main St, Springfield, ST 00000'),
 ('10000000-0000-4000-8000-000000000002','Uptown — Springfield','Uptown','200 Oak Ave, Springfield, ST 00000'),
 ('10000000-0000-4000-8000-000000000003','Lakeside — Shelbyville','Lakeside','300 Lake Rd, Shelbyville, ST 00000')
on conflict do nothing;
insert into departments (id, title) values
 ('20000000-0000-4000-8000-000000000001','Stylist'),
 ('20000000-0000-4000-8000-000000000002','Associate'),
 ('20000000-0000-4000-8000-000000000003','Front Desk')
on conflict do nothing;
insert into employees (gusto_company_uuid, gusto_employee_uuid, first_name, last_name, email, timekeeping_access, home_location_id, home_department_id) values
 ('00000000-0000-4000-8000-0000000000aa','30000000-0000-4000-8000-000000000001','Alex','Sample','alex@example.com','enabled','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-0000000000aa','30000000-0000-4000-8000-000000000002','Blair','Example','blair@example.com','enabled','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002'),
 ('00000000-0000-4000-8000-0000000000aa','30000000-0000-4000-8000-000000000003','Casey','Demo','casey@example.com','enabled','10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003')
on conflict do nothing;
