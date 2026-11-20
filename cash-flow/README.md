# Cash flow model

The Google Sheet **GTM Talent - Cash Flow Model** (owner Praveen) projects cash
month by month for 24 months: money in from placements, fixed and variable
costs, software from the inventory, VAT, an optional hire, and the runway.
The figures live in the sheet only; nothing financial is stored in this repo.

```
Software Inventory sheet ──IMPORTRANGE──► Software (from inventory)  ─┐
  (Charge calendar: every software charge, next 12 months)            │
Placements (invoices: Paid / Open / Check / Forecast) ────────────────┼─► Cash flow (24 months) ─► Summary
Costs (fixed and variable, DKB's breakdown) ──────────────────────────┤      runway, break-even,
Inputs (bank balance, base case, hire, VAT, EUR/USD) ─────────────────┘      hiring impact
                                   ▲
cashflow-monthly.gs (1st of each month, 08:00) ── reads Revolut invoice emails, updates Placements,
                                                  adds a Monthly check-ins row, emails a summary
```

## Tabs

| Tab | What it holds | Who edits it |
|---|---|---|
| Summary | Runway (no new deals and base case), cash in 12 months, break-even placements per month, hiring impact, what is still missing | nobody (formulas) |
| Cash flow | 24 months: opening cash, money in, money out, VAT per quarter, closing cash, three scenarios | nobody (formulas) |
| Inputs | Bank balance and its date, base-case deal flow, payment delay, VAT, hire assumptions, EUR/USD | people: yellow cells |
| Placements | One row per invoice. Status Paid, Open (sent, not paid), Check (no payment seen, not counted) or Forecast (weighted by probability) | the monthly script and people |
| Costs | Salary, DKB, Revolut, insurance, phone, travel, freelancers, marketing | people, from DKB's breakdown |
| Software (from inventory) | Live copy of the inventory's charge calendar | nobody |
| Monthly check-ins | Forecast vs real month-end cash, one row a month | the script adds the row, people type the real balance |

**First time only:** open the *Software (from inventory)* tab, click cell A1
and **Allow access**. Until then software costs fall back to the inventory's
monthly total, or 0.

## Every month (5 minutes)

1. The script's email arrives on the 1st.
2. Type the Revolut balance (all accounts) on **Inputs**: date in B5, amount
   in B6. The whole forecast restarts from that balance.
3. On **Monthly check-ins**, type last month's real month-end balance in
   column B. Column D shows how far off the forecast was.
4. Look at anything listed under *Money not in yet* and *Skipped*: fix the
   client name and fee on new Placements rows (the script writes "Unknown"),
   and change Check to Paid or remove the row once you know.

## Install the monthly script (Praveen, once)

1. Open the **GTM Talent - Cash Flow Model** sheet.
2. **Extensions → Apps Script**. Name the project "Cash flow monthly".
3. Replace the sample code with everything in `cashflow-monthly.gs`.
4. Optional: to email Navin too, set
   `RECIPIENTS: ['praveen@gtmtalent.tech', 'nav@gtmtalent.tech']`.
5. Save, choose **setup**, click **Run**, allow the permissions (this
   spreadsheet, read the invoice folder in Drive, send email as you).
6. Done. It sends a first email now and then runs on the 1st of every month
   at 08:00 Amsterdam time.

The account that installs it needs read access to the "GTM Talent - Invoices"
Drive folder that Nav's Invoice Archiver fills.

## What the script reads

Revolut Business sends two emails per sales invoice, and the Invoice Archiver
saves both as `.txt` files:

- `€7,500 invoice from GTM Talent B.V.` → invoice number, invoice date, due
  date, amount. A new invoice is added to Placements as **Open**, expected on
  its due date.
- `Your Invoice for €7,500 was paid` (older: `An invoice for … was paid`) →
  invoice number, date paid. The row becomes **Paid** with that date; if the
  invoice was not on Placements it is added as Paid.

Both amount styles (`€15,000`, `€ 15.000`) and both date styles
(`7 October 2026`, `June 6, 2025`) are understood. Each file is read once.
Emails archived before 20 Nov 2026 (`START_DATE`) are ignored: those invoices
were entered by hand when the model was built. Emails without an invoice
number are listed under *Skipped* and nothing is changed.

## Limits

- The amount in Revolut's email is the invoice total. All current invoices are
  0% reverse charge, so it equals the fee; for a Dutch client (21% VAT) set
  the VAT rate in column G and the fee excl. VAT in F.
- Payments that do not come through a Revolut invoice (a bank transfer
  without one) are not seen; add them by hand.
- Costs come from Costs and the inventory, not from the bank. Monthly
  check-ins is where a drift shows up.
- Corporate tax and EUR/USD moves beyond the rate on Inputs are not modelled.

## Tests

```bash
node cash-flow/tests/monthly.test.js
```

48 checks against fake Sheets, Drive and Mail services: both Revolut email
formats, amount and date styles, invoice sent and paid in the same month,
known invoices, emails without an invoice number, old emails ignored, re-runs
change nothing, stale bank balance warning, Drive failure, months before the
forecast starts, and setup with a missing tab.
