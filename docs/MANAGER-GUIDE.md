# Manager guide

Managers (admins) see an **Admin** screen. Use **My clock** to switch to your own clock, **Help** for tips, **Sign out** to leave.

## Who is working now
The live list shows each person on the clock: name, location, role (department) and how long they have been on.
You can clock someone out from here if they forgot. Use the real end time if you know it, or fix it afterwards in Timecards.

You can switch the view between **Today**, **Yesterday** and **This week**, with totals by location and an overall total.

## Staff
- See everyone with phone, access and role.
- **Access** controls who can punch. New people start as "pending review" and cannot clock in until you enable them.
- **Invite** by **Text**, **Email**, or **Team Chat** (only the options you have set up will work).
- **Staff setup progress** shows who was invited, who registered, and who has clocked in.
- **Add an employee (not yet in Gusto)** lets you add someone by hand. They can be matched to Gusto later; Gusto's spelling of the name wins.
- If Gusto sync is on, new hires show up as pending review and people ended in Gusto are blocked from punching.

## Timecards and Timesheet
- **Timecards:** one person's punches for a period. Add, change or remove punches. Every change is recorded, not silently overwritten.
- **Timesheet:** everyone's hours for the period in one table.

## Fix requests (Corrections)
Each request shows what the person asked for and why.
- **Approve** applies their requested time as written.
- **Reject** turns it down. You can add a short note to the person.

## Reports
Pick a start and end date, all or active staff only. Shows hours by person and day with totals. **Print** or **Download CSV** (date, person, total, regular and overtime hours).

## Payroll file (payday)
1. Open **Payroll**. Pay periods line up with your Gusto pay schedule.
2. Pick the period and check **Totals (for Gusto)**. One line per person per job.
3. Fix anything flagged first:
   - **Overnight spans** (red box): someone forgot to clock out. Not counted until fixed. Fix in Timesheet or Timecards.
   - **OPEN_SHIFT**: someone is still clocked in.
   - **NO_GUSTO_JOB** or a `*` next to a job: no matching job in Gusto. Add that job in Gusto, or set the **Gusto title** for the role in Setup.
   - People not linked to Gusto are left out of the file (the screen says how many).
4. Click **Download Gusto CSV** and import it into Gusto. Full details: [PAYROLL-AND-GUSTO.md](PAYROLL-AND-GUSTO.md).

The pay amounts on screen are an estimate only. Gusto works out the real pay from its own pay rates.

## Setup screen
- **Locations:** add, rename, turn off.
- **Departments (roles):** add roles. **Gusto title** sets the exact Gusto job name to send for that role.
- **Gusto sync:** shows when it last synced; run it now.
- **Data backups:** download a backup copy of your data.
- Reminder settings: turn forgotten-clock-out texts on or off and set after how many hours.

## Labor detail and What's new
**Labor detail** shows hours by location and role. **What's new** lists recent changes to the app.
