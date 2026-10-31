# Setup: bring your own accounts

You use your own free accounts. Nothing is shared with anyone else.

## Accounts you need
| Account | What it does | Needed? |
|---|---|---|
| Supabase | Stores staff, punches and time cards; handles sign-in | Yes (free tier is fine) |
| Netlify | Hosts the website and its small back-end jobs | Yes (free tier is fine) |
| Gusto | Syncs your staff list; you import the payroll file | Optional |
| Twilio | Sends texts (invites, PIN codes, reminders) | Optional, but needed for Phone + PIN sign-in codes and text reminders |
| Resend | Sends emails (invites) | Optional |
| A team chat app with an API | Sends notices to managers | Optional |

## Step by step
1. **Database.** Make a Supabase account and a new project. Open its SQL editor. Run each file in `supabase/migrations` in number order (0001 to 0006).
2. **Try it with sample data (optional).** Run `supabase/seed/sample_data.sql` to load made-up locations and staff. See "Demo mode" below.
3. **Copy your database keys.** In Supabase project settings, copy the Project URL, the public "anon" key, and the private "service role" key.
4. **Website.** Make a Netlify account. Add this folder as a new site (connect your own Git copy, or drag and drop).
5. **Settings.** In Netlify: Site settings > Environment variables. Add the settings below. Start with the required ones.
6. **Deploy.** Open your site. Make yourself an admin, sign in, and replace sample locations, roles and staff with your own.
7. **Invite staff** from the Admin screen.
8. **Add optional services later** (Gusto, texts, email) by adding their settings and redeploying.

Keep keys private. Never put real keys in this folder, in screenshots, or in chat.

## Every setting, and what it does
Names match `.env.example`.

### Required
| Setting | What it does |
|---|---|
| `VITE_SUPABASE_URL` | Your database address, used by the website |
| `VITE_SUPABASE_ANON_KEY` | Your database's public key, used by the website |
| `SUPABASE_URL` | Same address, used by back-end jobs |
| `SUPABASE_ANON_KEY` | Same public key, used by back-end jobs |
| `SUPABASE_SERVICE_ROLE_KEY` | Private master key for back-end jobs. Never share it. |
| `APP_URL` | Your site's web address. Used in invite and reminder links. |
| `APP_PIN_SECRET` | Any long random text. Used to protect PINs. Do not change it later or everyone must reset their PIN. |

### Optional: shared login with another app
| Setting | What it does |
|---|---|
| `VITE_CENTRAL_AUTH_URL`, `VITE_CENTRAL_AUTH_ANON_KEY`, `CENTRAL_AUTH_URL` | Use another app's login instead of this one. Leave blank to use the built-in login. |

### Optional: Gusto
| Setting | What it does |
|---|---|
| `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET` | Your Gusto app keys. Turn on the nightly staff sync. |
| `GUSTO_API_BASE` | Gusto's address. Leave as is (use Gusto's demo address for testing). |
| `GUSTO_API_VERSION` | Gusto API version. Leave blank for the default. |

The payroll file works without these. They only add the automatic staff sync.

### Optional: texts (Twilio)
| Setting | What it does |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Your Twilio account keys |
| `TWILIO_FROM_NUMBER` | The number texts come from |

Turns on: text invites, PIN reset codes, forgotten clock-out reminders, next-morning overnight-shift texts. US texting needs a registered business number in Twilio.

### Optional: email (Resend)
| Setting | What it does |
|---|---|
| `RESEND_API_KEY` | Your Resend key |
| `RESEND_FROM` | Sender name and address, for example `Team Time Clock <timeclock@yourdomain>` |

### Optional: who gets admin notices
| Setting | What it does |
|---|---|
| `OWNER_NOTIFY_EMAIL` | Email (or several, comma-separated) of the owner or managers who get notices, such as Gusto sync changes. A manager can also set the list in the app. Leave blank for no notices. |

### Optional: team chat notices
| Setting | What it does |
|---|---|
| `TEAM_CHAT_GATEWAY_URL` | Address of your team chat service |
| `TEAM_CHAT_TOKEN` | Key used to send chat messages (notices, invites) |
| `TEAM_CHAT_API_KEY` | Password your chat service can use to read hours from this app |

They send managers notices (sync changes, overnight-shift flags) and chat invites. Leave blank if you do not use one.

### Optional: let other apps read hours
| Setting | What it does |
|---|---|
| `HOURS_API_KEY`, `TIMEKEEPING_API_KEY`, `KPI_SENTINEL_API_KEY` | Passwords other tools (dashboards, reports) use to read hours from this app. Make up long random values. Leave blank if unused. |

## Scheduled jobs (automatic)
| Job | When | What it does |
|---|---|---|
| Clock-out reminder | Every hour | Texts anyone clocked in longer than the limit (12 hours by default), once per shift |
| Overnight check | Every morning (about 11 AM Eastern) | Finds shifts that crossed midnight, texts the person for their real clock-out time, flags it to managers |
| Gusto sync | Nightly | Updates staff from Gusto (only if Gusto keys are set) |
| Backup | Weekly (Mondays) | Saves a backup copy of your data |
| Keep warm | Every minute | Keeps the app fast to open |

## Optional texts and emails for forgotten clock-outs
1. Add the Twilio settings and redeploy.
2. Make sure each person has a mobile number on file.
3. In Admin > Setup, turn the clock-out reminder on and choose the number of hours.
Texts only go to people with punching enabled and a phone number. Email is used for invites only.

## Demo mode (trying it out)
There is no separate demo switch. To try it safely:
1. Use a new, empty Supabase project.
2. Run the migrations, then `supabase/seed/sample_data.sql` for made-up locations and staff.
3. Leave all optional settings blank. Nothing is texted or emailed and nothing touches payroll.
4. Clock in and out, request fixes, and download a payroll file to see the format.
5. When ready, use a fresh project for real data, or delete the sample staff and locations.

## Time zone
Dates and day boundaries use Eastern time (`America/New_York`). To change it, edit the time zone in `src/lib/time.ts` (`APP_TZ`) and the Eastern references in the scheduled jobs.
