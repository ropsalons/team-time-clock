# Team Time Clock

A simple, phone-friendly time clock for salons and other small teams with one or more locations.
Staff clock in and out on their own phone. Managers see who is working, fix mistakes, and download a payroll file at payday.

All names, places and numbers in this template are made up. Replace them with your own.

## Guides
| Guide | For |
|---|---|
| [docs/STAFF-GUIDE.md](docs/STAFF-GUIDE.md) | Team members: clocking in and out, hours, asking for a fix |
| [docs/MANAGER-GUIDE.md](docs/MANAGER-GUIDE.md) | Managers: who is working, time cards, fixes, reports, payroll file |
| [docs/PAYROLL-AND-GUSTO.md](docs/PAYROLL-AND-GUSTO.md) | The payroll file: what is in it, using it with Gusto or any other payroll service |
| [docs/SETUP.md](docs/SETUP.md) | Setting it up with your own accounts, every setting explained, optional texts and emails, trying it with sample data |
| [docs/FAQ.md](docs/FAQ.md) | Common questions and troubleshooting |

## What it is
A small website that works like an app on any phone. It has two sides:
- **Staff side:** a big Clock In / Clock Out button, a choice of location and role, "My Hours", "My Time Card", and a way to ask for a fix.
- **Manager side (Admin):** a live list of who is on the clock, time cards, fix requests, reports, setup, and a **Payroll** screen that builds the payroll file.

## What it is for
- Recording when people start and stop work, at which location, in which role.
- Catching forgotten clock-outs before they turn into wrong paychecks.
- Turning a pay period of punches into a file your payroll service can read, with overtime already worked out.

## Who it is for
Salons, spas, studios, shops and other small teams, especially ones where people work at more than one location or in more than one role (for example a stylist who also covers the front desk).

## What it replaces, and why
It replaces paid time clock services and scheduling-plus-time-clock apps (OnTheClock, Homebase-style apps and similar).
- **No per-person monthly fee.** It runs on free tiers of two common services that you own.
- **Your data stays in your own accounts.**
- **Built for payroll from the start.** The payroll file is shaped for Gusto's import, one line per person per job, overtime split by week.
- **Works with other payroll services too.** The file is a plain spreadsheet (CSV). See [docs/PAYROLL-AND-GUSTO.md](docs/PAYROLL-AND-GUSTO.md).
- **Things it does not do:** shift scheduling, and paying people. Your payroll service still runs payroll.

## How it works (in one minute)
1. Staff sign in with their mobile number and a 4-digit PIN (or email).
2. They pick location and role and tap **Clock In**. Later they tap **Clock Out**.
3. Each tap is saved with the server's time, so a phone's clock cannot change it. If the phone is offline, the tap waits and sends when it reconnects.
4. Hours over 40 in a Sunday-to-Saturday week count as overtime.
5. At payday a manager opens **Payroll**, picks the pay period, checks the preview, and clicks **Download Gusto CSV**.
6. The manager imports that file into Gusto (or another payroll service).

## For developers
- `npm install`, then `npm run dev` (website only) or `npx netlify dev` (website plus back-end jobs).
- `npm test` runs the tests.
- Database setup files: `supabase/migrations` (run in number order). Sample data: `supabase/seed/sample_data.sql`.
- Settings: copy `.env.example` and fill in your own values. Never commit real keys.

## License
MIT. See `LICENSE`.
