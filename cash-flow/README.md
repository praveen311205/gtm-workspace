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
revolut-sync.gs (every day, 06:00) ── Revolut Business API (read only) → Bank, Bank transactions,
                                      Actuals; sets the cash balance on Inputs, marks invoices Paid,
                                      fills real month-end balances on Monthly check-ins
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
| Monthly check-ins | Forecast vs real month-end cash, one row a month | the monthly script adds the row, the Revolut sync fills the real balance |
| Bank | Revolut balances per account and in total, last sync time and status | the Revolut sync |
| Bank transactions | Every Revolut transaction of the last 13 months, one row per account leg, with a category | the Revolut sync |
| Bank rules | Text to category rules for bank lines (first match wins) | people |
| Actuals | Money in and out per category for the last 12 complete months, the average, and the model's figure next to it | nobody (formulas) |

**First time only:** open the *Software (from inventory)* tab, click cell A1
and **Allow access**. Until then software costs fall back to the inventory's
monthly total, or 0.

## Connect Revolut (once, about 15 minutes)

There is no Revolut connector for Claude, so the sheet talks to Revolut's
Business API itself, with a **read-only API key** from Revolut's API Console.
Revolut requires every request made with such a key to be signed with a
signing key; the sheet makes that signing key itself, so nobody needs to
install anything. The API Console needs a Revolut Business plan of Grow or
above and the **Manage API** permission (an Owner or Admin has it).

Two people, at the same time (on a call or in chat):

**Praveen (in the sheet):**

1. Open the cash flow sheet → Extensions → Apps Script. Add a file (+ →
   Script) named `revolut-sync` and paste everything in `revolut-sync.gs`.
   Save. Reload the sheet: a **Revolut** menu appears.
2. **Revolut → Connect Revolut…** Google asks for permission the first time
   (this spreadsheet, connect to an external service, send email as you, run
   on a schedule). If it says "Google hasn't verified this app", click
   Advanced → Go to the project: it is your own script. Open the menu item
   again.
3. Step 1 of the dialog shows a **public key** (it starts with
   `-----BEGIN PUBLIC KEY-----`). Click **Copy public key** and send it to
   Nav. It is safe to share; the private half stays in your Google account.

**Nav (in Revolut, on any computer):**

4. Go to the API Console: developer.revolut.com/console (or Revolut Business
   → Settings → Integrations → API → **Manage API Console**). Make sure the
   account switcher at the top right shows the real (Production) GTM Talent
   account, not Sandbox.
5. **API keys → New** (Add API key). Permissions, everything else **None**:
   - Accounts → **Accounts: Read** and **Transactions: Read**
   - Currency exchange → **Exchange: Read** (optional: only for converting a
     USD balance at today's rate)
6. Continue. On the signing step, paste the public key Praveen sent.
7. Name it `Cash flow sheet`. No expiry date is needed (if you set one, the
   sync stops on that date and needs a new key). Leave the IP allowlist empty:
   Google's servers don't have fixed addresses.
8. **Create API key**, confirm on your phone, and send Praveen the API key it
   shows. Because it only works together with the signing key in Praveen's
   Google account, it is useless on its own; still, send it in a direct
   message and delete the message afterwards.

**Praveen:**

9. Paste the API key in step 2 of the dialog and click **Connect and sync**.
   The first sync reads 13 months of history (up to a minute). Then it runs
   every day at 06:00 Amsterdam time; **Revolut → Sync now** runs it on demand.

Where the secrets live: the API key and the signing key are stored in
Praveen's private Apps Script user properties. Other editors of the sheet
cannot read them, and they are not in the sheet or the code. **Revolut →
Disconnect** deletes them and stops the daily run; **Revoke** on the key in the
API Console cuts access from Revolut's side, immediately.

What it calls: only `GET /accounts`, `GET /transactions` and `GET /rate` on
`b2b.revolut.com`. The key has no Write permission, so even a changed script
could not move money with it.

### What the sync changes in the model

- **Cash balance.** Inputs B5 and B6 take the date and total balance (all
  accounts, converted to EUR at Revolut's rate) from the Bank tab, so the
  forecast always starts from this morning's real balance. Set Inputs B39 to
  No to use the typed balance in B40:B41 instead; that is also the fallback
  until the first sync.
- **Invoices.** A payment whose reference or description holds an invoice
  number (INV-31) marks that invoice Paid with its date. A payment with no
  invoice number is matched by amount only when exactly one Open or Check
  invoice and one payment share that amount (within €1); two €5,000 retainers
  stay as they are and are listed in the email for a person to check. Payment
  emails come only when something was found.
- **Month-end balances.** Each Monthly check-ins row with an empty column B
  gets the real balance at the end of that month (today's balance minus every
  completed transaction since).
- **Costs (your choice).** The Actuals tab shows the real monthly average per
  category next to the model's figure. Inputs B42 decides what the forecast
  uses: **Costs tab** (default) or **Bank actuals**, which replaces the fixed
  and variable cost lines with the real average operating costs (excluding
  software, which still comes month by month from the inventory, tax, and
  transfers between your own accounts) over the number of months in B43.
  Check Actuals first: anything in **Other costs** has no rule yet, so add
  rules on Bank rules until that line is small.

### When the sync stops

If the key is revoked, expires or loses its permissions, the Bank tab's status
(B3) says so and an email goes out; the model keeps the last synced balance.
Nav makes a new key in the API Console with the same public key (Praveen can
show it again: Revolut → Connect Revolut, step 1) and Praveen pastes it in
step 2. "Make a new one" in step 1 replaces the signing key, after which keys
made with the old public key stop working.

## Every month (5 minutes)

1. The script's email arrives on the 1st.
2. With the Revolut sync on, the balance and last month's real month-end
   balance are already filled in. Without it, type the balance on **Inputs**
   (date in B40, amount in B41) and last month's real month-end balance on
   **Monthly check-ins**, column B. Column D shows how far off the forecast was.
3. Look at **Actuals**: sort anything new in Other costs with a rule on
   **Bank rules**.
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
- Without the Revolut sync, payments that do not come through a Revolut
  invoice are not seen; add them by hand.
- Bank categories come from simple text rules. A line can land in the wrong
  category until a rule is added; the forecast only uses them when Inputs B42
  is set to Bank actuals.
- The current month is not forecast: the forecast starts on the 1st of next
  month from today's balance, so money still due to come in or go out this
  month is not counted.
- Corporate tax and EUR/USD moves beyond the rate on Inputs are not modelled.

## Tests

```bash
node cash-flow/tests/monthly.test.js
```

```bash
node cash-flow/tests/revolut.test.js
```

48 checks against fake Sheets, Drive and Mail services: both Revolut email
formats, amount and date styles, invoice sent and paid in the same month,
known invoices, emails without an invoice number, old emails ignored, re-runs
change nothing, stale bank balance warning, Drive failure, months before the
forecast starts, and setup with a missing tab.

54 checks for the Revolut sync against a fake Revolut API that verifies every
request's signature the way Revolut does: Ed25519 signatures and public keys
identical to Node's own implementation, a signing key made in the dialog or
taken from an OpenSSL private.pem (other key types refused), connecting and
disconnecting, a rejected API key not kept, balances in several currencies,
inactive accounts, one row per leg, internal transfers and exchanges, fees,
declined payments, categories from rules, inventory names and invoice numbers,
invoices marked Paid by reference or a unique amount (and left alone when two
match), month-end balances, re-runs that change nothing and send no repeat
emails, more than 1,000 transactions, a retried server error, a revoked key, a
limit on history, and that only GET requests reach the API.
