# Employee Payroll & Timekeeping

W-2 staff only — hourly crews on the payroll, salaried office people, foremen and
inspectors. Subcontractor crew pay stays in the separate crew portal; nothing here
touches it.

Two screens, one system:

| Who | Where | What they do there |
|---|---|---|
| Employee | `/?mode=timecard` | Log the days they worked, time off, doctor visits, arriving late / leaving early. See holidays and what's left of their vacation + comp days. |
| Department manager | same screen, **Team** tab | Monday morning: review last week for their team, fix anything wrong, sign it off. Approve/deny their team's time-off requests. |
| Office / HR | `/?mode=payroll` (manager PIN) | The roster, departments and who signs each one off, PTO allotments, holidays, the comp-day bank, and the payroll export. |

Both are also tiles in **My Tools** (`/?mode=mytools`) under *People & Payroll*.

## Turning it on

1. **Run the schema.** In Supabase → SQL editor, paste and run `sql/payroll_timekeeping.sql`.
   It's safe to re-run. It seeds the 2026–2027 holiday calendar.
2. **Deploy** (this repo's normal Netlify deploy — the two functions and both pages
   ship with it).
3. **Open `/?mode=payroll`** and, in this order:
   - **Teams** → add each department (Warehouse, Production, Office…). Leave the
     manager blank for now.
   - **People** → add each employee. The *work email is their login*. Set pay type +
     rate, vacation days per year, and tick **can sign off a department** for anyone
     who runs a team (and **office/HR** for whoever should see everyone).
   - **Teams** again → set each department's manager now that they exist.
4. **Tell people to open `/?mode=timecard`.** First sign-in: they type their work
   email, then pick their own 4–8 digit passcode. If they forget it, the office hits
   **Reset PIN** on the People tab and they set a new one.

## The weekly rhythm

- The payroll week runs **Monday → Sunday**.
- Employees fill in days as they go and tap **My week is done** at the end.
- **Monday 8:00 AM ET** every department manager whose last week is still unsigned
  gets a text + email naming anyone who hasn't marked their week done
  (`cron-payroll-signoff`). Stragglers get pinged again at 11:00 AM.
- The manager opens the **Team** tab, fixes blanks, and signs off. Signing:
  - locks every day in that week so the numbers can't move afterwards,
  - snapshots the totals onto the approval record,
  - credits comp days to anyone comp-eligible who ran past their standard week.
- The office pulls **Export** for the period → CSV for whoever runs payroll.
  Only the office can edit a signed-off day (Sign-off tab → *Fix one person's week*),
  and doing so is stamped as an office edit.

## How the pieces behave

**Days.** One row per person per date. A day is *worked*, or a type of *off*
(vacation, sick, doctor, comp day, unpaid, bereavement, jury), or both — 6 hours
worked plus 2 hours at the doctor is one day. Hours come from the in/out times when
they're filled in, otherwise from a typed number. Arriving late and leaving early are
minute counts on a worked day, so they show up as flags for the manager without
changing the hours.

**Time off.** A request goes to the department manager. Approving it writes the days
straight onto the time card — weekends and company holidays inside the range are
skipped and never counted against an allotment. Balances are always counted off the
time cards, so a day the office keyed in by hand counts exactly the same as one that
came from a request. A half day off burns half a day.

**Comp days** ("extra days worked banked for time off later). Only for employees
ticked **banks comp days**. They accrue automatically when a signed-off week runs past
that person's standard week hours (extra hours ÷ their standard day = days), and the
credit is idempotent — re-approving a week never pays twice. Anything else — a
Saturday you promised back, a correction — is posted by hand on the **Balances** tab
(negative days to take some away). Taking a comp day is a normal time-off request of
type *Comp day*, which draws the bank down when approved.

**Holidays** are company-wide, editable on the Holidays tab, and visible to every
employee on their time card.

## Settings

`app_settings.payroll_config` holds the defaults (standard day 8h, standard week 40h,
OT after 40, Monday deadline hour 11). Per-person overrides live on the employee
record — *Day hours* and *Week hours (OT after)*.

## Files

| File | What it is |
|---|---|
| `sql/payroll_timekeeping.sql` | Schema + the seeded holiday calendar |
| `netlify/functions/payroll-me.js` | Employee + manager API (passcode login, timecard, time off, sign-off) |
| `netlify/functions/payroll-api.js` | Office API (roster, departments, holidays, balances, export) |
| `netlify/functions/cron-payroll-signoff.js` | Monday 8 + 11 AM ET manager reminder |
| `src/TimeCard.jsx` | `/?mode=timecard` |
| `src/PayrollAdmin.jsx` | `/?mode=payroll` |

A dry run of the Monday nudge, without sending anything:
`/.netlify/functions/cron-payroll-signoff?dry=1`

## Notes / limits

- Passcodes are stored salted + hashed. Sessions last 30 days per device.
- The export's `gross_estimate` is an unburdened check figure — hourly rate × hours
  with OT at 1.5×, or salary ÷ 52. No taxes, deductions or benefits. It's for
  eyeballing a week, not for filing.
- Nothing pushes to QuickBooks yet; the CSV is the handoff.
