# Payroll file, Gusto, and other payroll services

## The short version
At payday, Team Time Clock builds one spreadsheet file (CSV) with everyone's hours for the pay period, already split into regular and overtime, one line per person per job. You import it into Gusto. Gusto still holds pay rates and runs payroll.

## How hours are counted
- Only punches inside the pay period (dates in Eastern time by default) and not removed by a manager.
- A clock-in on one day with a clock-out the next day is treated as a forgotten clock-out and **not counted** until fixed.
- **Overtime:** hours over 40 in a Sunday-to-Saturday week (the federal rule). Overtime is credited to the job the person was doing when they passed 40.
- **Week 1 / Week 2:** for a two-week pay period, hours are also split into the first 7 days and the second 7 days, so Gusto pays overtime in the week it was earned.
- Hours are decimals rounded to 2 places (7 hours 30 minutes = 7.5).
- People with no Gusto link are left out.

## Exactly what is in the file
One header row, then one row per person per job. Columns, in order:

| Column | What it holds |
|---|---|
| Gusto Employee UUID | The person's Gusto id (how Gusto matches people) |
| Employee Name | First and last name |
| Email | Work email on file |
| Pay Period Start / Pay Period End | The dates you picked (YYYY-MM-DD) |
| Job Title | The exact Gusto job name (see below) |
| Location | Location short name |
| Department | Role name |
| Regular Hours | Hours up to 40 per week |
| Overtime Hours | Hours over 40 per week |
| Double OT Hours | Always 0 (not used) |
| Week 1 Regular Hours / Week 1 Overtime Hours | First 7 days of the period |
| Week 2 Regular Hours / Week 2 Overtime Hours | Second 7 days |
| Extra pay columns | One column per Gusto earning type: Paycheck Tips, Commission, Bonus, Paid Time, Missed Punch, Extra Time, Time Off, Severance Pay, Cash Tips (edit the list in `src/lib/gusto/extras.ts` to match your payroll account). Filled only when you supply amounts in the optional extras tables; otherwise blank. Only on the person's main job row, so nothing is paid twice. |
| Exceptions | Blank, `OPEN_SHIFT` (still clocked in), or `NO_GUSTO_JOB` (no matching Gusto job) |

**How Job Title is chosen** (first that applies):
1. The person's exact Gusto job for that role and location (pulled from Gusto by the sync).
2. The **Gusto title** you set for the role in Setup.
3. Role plus location, for example "Stylist Uptown".

The file never contains pay rates or pay amounts for hours. Cells that start with `=`, `+`, `-` or `@` are made safe so spreadsheets do not run them as formulas.

## Importing into Gusto
1. In Team Time Clock: **Payroll** > pick the period > clear any flags > **Download Gusto CSV**.
2. In Gusto: start the regular payroll for the same pay period.
3. Choose to import hours from a file (Gusto's "Smart Import" / upload hours option).
4. Upload the CSV.
5. Match columns the first time: Employee to Gusto Employee UUID (or name), job to Job Title, regular hours, overtime hours, and each extra pay column to the Gusto earning of the same name. Gusto remembers this for next time. The column list never changes, so the saved match keeps working.
6. Check Gusto's review screen. Fix any person or job Gusto could not match.
7. Finish payroll in Gusto as usual.

Gusto's menus change from time to time. If a step looks different, search Gusto's help for "import hours" or "Smart Import".

## Optional: automatic Gusto sync
With Gusto keys set (see [SETUP.md](SETUP.md)), a nightly job pulls your staff list from Gusto:
- New hires appear as "pending review" (you must enable them to punch).
- People ended in Gusto are blocked from punching.
- Name and email changes update without making duplicates.
Without keys, everything still works. You add staff by hand and type their Gusto id if you want them in the file.

## Using any other payroll service
The file is a plain CSV, so most payroll services can read it. Three ways to adapt it:

**1. Map columns in your payroll service (no code).** Many services let you match columns when you upload. Use Employee Name or Email to match people, and Regular Hours / Overtime Hours for hours. Ignore the rest.

**2. Tidy it in a spreadsheet (no code).** Open the file, delete or rename columns to match your provider's template, save as CSV, upload.

**3. Change the export (small code change).** Everything lives in `src/lib/gusto/csv.ts`:
- `HEADERS` is the list of column names. Rename, remove or reorder them.
- `buildPayrollCsv` writes each row in the same order as `HEADERS`. Keep both in step.
- `GUSTO_EARNING_COLUMNS` in `src/lib/gusto/extras.ts` is the list of extra pay columns. Change it to your provider's earning names, or empty it.
- To match people by your provider's id instead of Gusto's, add an id column to the staff table and write it in the first column.
- The overtime rule (40 hours a week) is in `src/lib/domain/segments.ts` if your state needs daily overtime.
- Run `npm test` after changing it.

Example of a minimal file for a provider that wants only name and hours:
```
Employee Name,Regular Hours,Overtime Hours
Sample Person,38.5,0
```

## Other exports
- **Reports > Download CSV:** Date, Employee, Email, Gusto Employee UUID, Source, Total Hours, Regular Hours, Overtime Hours, per person per day. Handy for any payroll service or bookkeeping.
- **Setup > Data backups:** a full copy of your data. A backup also runs weekly.
