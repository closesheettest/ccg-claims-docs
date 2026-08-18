# Employee Payroll & Timekeeping

W-2 staff only — hourly crews on the payroll, salaried office people, foremen and
inspectors. Subcontractor crew pay stays in the separate crew portal; nothing here
touches it.

It is not a punch clock. The day is **two taps**: check in when your shift starts,
and file a **recap of what you got done** when it ends. The recap is what closes the
day out and sets the hours — and it's what a manager reads every evening to see what
the whole team actually did.

Two screens, one system:

| Who | Where | What they do there |
|---|---|---|
| Employee | `/?mode=timecard` | Sign in with their **mobile number** + a passcode they set. Check in at shift start, recap at shift end, or mark the day off. See holidays and what's left of their vacation days. |
| Department manager | same screen, **Team** tab | **Today:** who's on shift, who never checked in, and every recap. **Week sign-off:** Monday morning, review last week, fix anything wrong, sign it off. Also approves time-off requests. |
| Office / HR | `/?mode=payroll` (manager PIN) | Shifts, the roster, departments and who signs each one off, PTO allotments, holidays, a company-wide daily recap board, and the payroll export. |

Both are also tiles in **My Tools** (`/?mode=mytools`) under *People & Payroll*.

## Turning it on

1. **Run the schema.** In Supabase → SQL editor, paste and run `sql/payroll_timekeeping.sql`.
   It's safe to re-run. It seeds the 2026–2027 holiday calendar.
2. **Deploy** (this repo's normal Netlify deploy — the two functions and both pages
   ship with it).
3. **Open `/?mode=payroll`** and, in this order:
   - **Shifts** → check the two seeded shifts (Day 7:00a–3:30p, Night 6:00p–6:00a),
     fix the times to match reality, add any others. *Grace* is how many minutes late
     is forgiven before it's recorded as late.
   - **Teams** → add each department (Warehouse, Production, Office…). Leave the
     manager blank for now.
   - **People** → add each employee, or use **⬆ Import roster** to paste a whole
     spreadsheet at once (see below). Their **mobile number is their login** and where
     the nudge texts go — without one they cannot sign in at all. Email is optional.
     Assign a **shift**, set pay type + rate and vacation days per year, and tick
     **can sign off a department** for anyone who runs a team (and **office/HR** for
     whoever should see everyone).

### Importing a roster

**People → ⬆ Import roster** takes a paste straight out of a spreadsheet — headers and
all, tabs or commas. It reads *name, dept, who to ask, mobile*, and optionally *email*
and *title*, in any column order; names can be `LAST, FIRST` or `First Last`, and
ALL-CAPS gets tidied to normal case.

It **always previews first** and writes nothing until you press the button. The preview
tells you who will be added, who is already on the roster, who has no mobile number,
which departments will be created, and — because one person signs off a whole
department — who ends up signing each one. If a department's rows name different
people, the most common name wins and every row that disagrees is listed for you.

A manager named in the sheet who isn't themselves a row (an owner, or someone in
another department) can't be linked automatically: add them on the People tab, then set
that department's manager on **Teams**.
   - **Teams** again → set each department's manager now that they exist.
4. **Tell people to open `/?mode=timecard`.** First sign-in: they type their work
   email, then pick their own 4–8 digit passcode. If they forget it, the office hits
   **Reset PIN** on the People tab and they set a new one.

## The daily rhythm

- **Shift start.** They open the app and tap **Check in**. If they're out that day
  they tap *I'm off today* and pick why — no request or approval needed, and it still
  counts against their balance.
- **During the shift** the card shows how long they've been on.
- **Shift end.** They write what they got done and tap **End shift & send recap**.
  That stamps the end, computes the hours (check-in → now, minus breaks), and closes
  the day. The recap is required — there's no way to close a day without one.
- **Nudges.** A cron runs every 15 minutes and texts only the people who haven't done
  it yet: one text once their shift start + grace has passed with no check-in, and one
  after their shift ends if they checked in but never recapped. Each fires at most
  once per person per day, and never to someone marked off or on a paid holiday.
- **The manager** opens **Team → Today** any time: who's on shift, who never checked
  in, who's off, and every recap in full.

### Night shift

A shift whose end time is earlier than its start (6:00p → 6:00a) crosses midnight.
Everything it produces is filed under **the date the shift started**, so someone who
checks in Monday 6pm and recaps Tuesday 6am files *one* day, on Monday. Their app says
so out loud ("You're still on Mon, Aug 17's night shift") and lateness is measured
against the shift, not the clock date — 2:00am on a 6pm shift reads as 8 hours late,
not as being early for the next one.

## The weekly rhythm

- The payroll week runs **Monday → Sunday**.
- Employees can still open **My Week** to fix a day or fill in one they missed, and
  tap **My week is done** at the end.
- **Monday 8:00 AM ET** every department manager whose last week is still unsigned
  gets a text + email naming anyone who hasn't marked their week done
  (`cron-payroll-signoff`). Stragglers get pinged again at 11:00 AM.
- The manager opens the **Team** tab, fixes blanks, and signs off. Signing:
  - locks every day in that week so the numbers can't move afterwards,
  - snapshots the totals onto the approval record.
- The office pulls **Export** for the period → CSV for whoever runs payroll.
  Only the office can edit a signed-off day (Sign-off tab → *Fix one person's week*),
  and doing so is stamped as an office edit.

## How the pieces behave

**Days.** One row per person per date. A day is *worked*, or a type of *off*
(vacation, sick, doctor, unpaid, bereavement, jury), or both — 6 hours
worked plus 2 hours at the doctor is one day. Hours come from the in/out times when
they're filled in, otherwise from a typed number. Arriving late and leaving early are
minute counts on a worked day, so they show up as flags for the manager without
changing the hours.

**Time off.** A request goes to the department manager. Approving it writes the days
straight onto the time card — weekends and company holidays inside the range are
skipped and never counted against an allotment. Balances are always counted off the
time cards, so a day the office keyed in by hand counts exactly the same as one that
came from a request. A half day off burns half a day.

**Holidays** are company-wide, editable on the Holidays tab, and visible to every
employee on their time card.

## Settings

`app_settings.payroll_config` holds the defaults: standard day 8h, standard week 40h,
OT after 40, Monday deadline hour 11, and the two nudge delays
(`checkin_nudge_after_minutes` 20, `recap_nudge_after_minutes` 15). Per-person
overrides live on the employee record — *Day hours* and *Week hours (OT after)* —
and shift times live on the shift.

## Files

| File | What it is |
|---|---|
| `sql/payroll_timekeeping.sql` | Schema + the seeded holiday calendar |
| `netlify/functions/payroll-me.js` | Employee + manager API (passcode login, timecard, time off, sign-off) |
| `netlify/functions/payroll-api.js` | Office API (roster, departments, holidays, balances, export) |
| `netlify/functions/payroll-nudge.js` | The check-in / recap texts, only to whoever hasn't done it (HTTP worker) |
| `netlify/functions/cron-shift-nudge.js` | Schedules the above, every 15 min |
| `netlify/functions/payroll-signoff-run.js` | The Monday manager reminder (HTTP worker) |
| `netlify/functions/cron-payroll-signoff.js` | Schedules the above, Mon 8 + 11 AM ET |
| `src/TimeCard.jsx` | `/?mode=timecard` |
| `src/PayrollAdmin.jsx` | `/?mode=payroll` |

Dry runs — these show exactly who would be texted and why, and send nothing:

- `/.netlify/functions/payroll-nudge?dry=1`
- `/.netlify/functions/payroll-signoff-run?dry=1`

(Call the **workers**, not the `cron-…` functions. Netlify returns 403 for a manual
call to a scheduled function, which is why each schedule is a thin wrapper around a
plain HTTP worker — the same split `cron-harvest-nosits` uses.)

## Notes / limits

- Passcodes are stored salted + hashed. Sessions last 30 days per device.
- There is no comp-time / banked-days feature — extra hours show as overtime on the
  week and in the export, and that's it.
- The export's `gross_estimate` is an unburdened check figure — hourly rate × hours
  with OT at 1.5×, or salary ÷ 52. No taxes, deductions or benefits. It's for
  eyeballing a week, not for filing.
- Nothing pushes to QuickBooks yet; the CSV is the handoff.
