# Renewal calendar

Turns the software inventory into a calendar of bank charges, with a
reminder 30 days before each one.

```
Inventory tab ──► Charge schedule tab ──► Charge calendar tab ──► renewal-reminders.gs (daily, 07:00)
(renewal date,     (next 12 charges        (every charge in the        ├─ Google Calendar "GTM Talent - Renewals"
 billing cycle,     per tool)               next 12 months, reminder   │    charge day + 09:00 reminder 30 days before
 monthly cost,                              date, monthly totals)      └─ email when charges enter the 30-day window
 status)
```

## What is in the sheet

Both tabs are formulas over **Inventory** and update themselves when the
inventory skill (or a person) changes it. Do not type in them.

- **Charge schedule**: one row per Inventory row. Reads how often the tool
  charges from *Billing cycle* (Monthly = 1 month, Quarterly = 3, Annual =
  12), multiplies *Monthly cost* by it to get the amount per charge, and steps
  the *Renewal date* by whole cycles to the next charge from today, then the
  next 12 charges.
- **Charge calendar**: every expected charge in the next 12 months, in date
  order, with the reminder date, tool, amount, status, card and days to go.
  Rows inside the reminder window are shaded; failed-payment tools are in red.
  On the right: the total due inside the window, and charges and totals per
  month for the next 13 months.

Only tools with status **Active**, **Payment failed** or **Trial** and a known
cost, cycle and renewal date are included. "Possibly cancelled", "Cancelled",
"Awaiting invoices" and "Confirm still used" rows are left out until their
status changes.

**Lead time:** cell **K1** on Charge calendar (30). Change it and the reminder
dates, the shading and the script follow.

## Install the reminders (Praveen, once, about 5 minutes)

1. Open the **GTM Talent - Software Inventory** sheet, signed in as the
   account that should receive the reminders.
2. **Extensions → Apps Script**. Name the project "Renewal reminders".
3. Replace the sample code with everything in `renewal-reminders.gs`.
4. Optional: to also remind Navin, set
   `RECIPIENTS: ['praveen@gtmtalent.tech', 'nav@gtmtalent.tech']`.
5. Save, choose **setup** in the function menu, click **Run**, and allow the
   permissions: read this spreadsheet, manage your calendars (it creates one
   calendar of its own), and send email as you.
6. Done. The first run creates the calendar "GTM Talent - Renewals" with every
   charge for the next 12 months, and sends one catch-up email listing the
   charges already inside the 30-day window. From then on it runs every day
   at 07:00 Amsterdam time.

To share the calendar with Navin: Google Calendar → GTM Talent - Renewals →
Settings and sharing → Share with specific people.

## What it does every day

- **Calendar:** an all-day event "Charge: Loxo €190.14" on each charge date
  (no notification) and an event "In 30 days: Loxo €190.14 on 10 Dec" at 09:00
  on the reminder date, with a pop-up. Events are created, updated (amount,
  date or lead time changed) or removed (tool cancelled) to match the sheet.
  The script only touches events it created; past events stay as a record.
- **Email:** when charges reach their reminder date, one email lists them with
  date, amount, card and a warning for tools whose last payment failed, plus
  the total due in the whole window. A charge is emailed once. If a day's run
  is missed, the next run includes what was due on the missed days.

## Google's calendar rate limit

Google refuses a burst of event creations ("You have been creating or deleting
too many calendars or calendar events in a short time"). The first run has
about 200 events to create (12 months of charges plus reminders), so the
script paces its calendar writes and, when Google still refuses, stops
cleanly and schedules a one-off `continueSync` run 20 minutes later (1 minute
if it only ran out of time). It repeats until the calendar is complete; this
can take a few rounds on the first day. Events already created are recognised
by their tag and never duplicated, and the reminder email is sent before the
calendar is touched, so it never waits on the calendar. After the first day
only a handful of events change per run.

## Limits

- Dates come from the inventory: a **projected** renewal date (marked in the
  Inventory *Confidence* column) can be a few days off the real charge.
- A tool billed on two dates a month (for example a Team plan and a separate
  Pro seat) shows one charge on its Inventory renewal date.
- LinkedIn's quarterly instalments are projected beyond the contract end
  (13 Apr 2027); once the non-renewal is confirmed, set its status to
  Cancelled and those charges disappear.
- Charges in USD are shown in EUR at the rate used in Inventory.

## Tests

```bash
node renewal-calendar/tests/reminders.test.js
```

53 checks against fake Calendar, Mail and Sheets services: first run and
catch-up email, idempotent re-runs, newly due charges, amount and date changes,
removed tools, lead-time changes, missed days, summer and winter time,
Google's rate limit with automatic continuation, and error cases.
