# FAQ and troubleshooting

## Questions
**Does it cost anything?** It runs on free tiers of Supabase and Netlify for a small team. Texts and emails cost whatever those services charge.

**Does it pay people?** No. Your payroll service runs payroll. This app supplies the hours.

**Does it do schedules?** No. It records actual time worked.

**Can staff change their own punches?** No. They ask for a fix and a manager approves it.

**Can a phone fake the time?** No. The server's clock is used for every punch.

**What if someone works at two locations or in two roles?** They clock out and back in with the new choice. The payroll file shows one line per job.

**How is overtime figured?** Over 40 hours in a Sunday-to-Saturday week. Daily overtime rules are not built in.

**Does it work offline?** Punches made offline are saved on the phone and sent when back online.

**Does it work with payroll services other than Gusto?** Yes. The file is a standard CSV. See [PAYROLL-AND-GUSTO.md](PAYROLL-AND-GUSTO.md).

**Is location tracked?** Only at the moment of a punch, if the phone allows it.

## Troubleshooting
| Problem | What to do |
|---|---|
| Staff cannot sign in | Check their number is on file and their access is enabled. Have them use Forgot PIN. |
| PIN code text never arrives | Check the Twilio settings and that your Twilio number is registered for US texting. |
| New person cannot clock in | New people start as pending review. Enable them in Admin. |
| Someone is still "on the clock" from yesterday | Clock them out from the live list, then fix the time in Timecards. |
| Hours look too low | Look for an overnight span on the Payroll screen. Those hours are left out until fixed. |
| A person is missing from the payroll file | They have no Gusto id, or no hours in the period. Add the Gusto id on their staff record. |
| `NO_GUSTO_JOB` or `*` in the file | Add the matching job in Gusto, or set the role's Gusto title in Setup. |
| Gusto will not match a column | Re-do the column match in Gusto's import. Column names never change between files. |
| Reminders are not sent | Check Twilio settings, that the reminder is on in Setup, and that the person has a phone number. |
| Gusto sync says "not configured" | Add the Gusto settings and redeploy. Sync is optional. |
| Site shows an error after changing settings | Redeploy in Netlify. Settings only take effect after a new deploy. |
