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
Business API itself. Whoever is an admin on Revolut Business does steps 1-3;
the person whose Google account runs the sync does step 4 onwards (they can be
the same person, together at one screen).

1. **Make a key pair** in Terminal on a Mac:

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out privatekey.pem
   ```

   ```bash
   openssl req -new -x509 -key privatekey.pem -out publiccert.cer -days 1825 -subj "/CN=GTM Talent cash flow"
   ```

   `privatekey.pem` is a secret: never email it, commit it or paste it in a
   chat. It goes only into the sheet's Connect dialog (step 5).
2. **Revolut Business on the web** → Settings → APIs → Business API →
   **Add API certificate**. Title "Cash flow sheet". OAuth redirect URI:
   `https://example.com`. Paste the whole contents of `publiccert.cer`.
   Save, and copy the **Client ID**. If Revolut offers a choice of
   permissions, choose read only: the sheet never needs more.
3. Leave that page open: step 6 needs its **Enable access** button.
4. **Install the script.** Open the cash flow sheet → Extensions → Apps
   Script (the same project as "Cash flow monthly", if installed). Add a file
   (+ → Script) named `revolut-sync` and paste everything in
   `revolut-sync.gs`. Save. Reload the sheet: a **Revolut** menu appears.
5. **Revolut → Connect Revolut…** Fill in the Client ID, `https://example.com`
   and the contents of `privatekey.pem`. Google asks for permission the first
   time (this spreadsheet, connect to an external service, send email as you,
   run on a schedule).
6. In Revolut click **Enable access** and approve on your phone. Revolut
   sends the browser to `https://example.com/?code=oa_prod_...`. The page
   itself shows nothing; copy that whole address from the address bar, paste
   it in the dialog's Code field and click **Connect and sync** straight away
   (the code is only valid for about two minutes).
7. Done. The first sync reads 13 months of history; then it runs every day at
   06:00 Amsterdam time. **Revolut → Sync now** runs it on demand.

Where the secrets live: the Client ID, private key and Revolut tokens are
stored in the connecting person's private Apps Script user properties. Other
editors of the sheet cannot read them, and they are not in the sheet or the
code. **Revolut → Disconnect** deletes them and stops the daily run; removing
the certificate in Revolut cuts access from that side.

What it calls: only `GET /accounts`, `GET /transactions` and `GET /rate` on
`b2b.revolut.com`, plus the sign-in at `/auth/token`. It never makes payments
or changes anything in Revolut.

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

Revolut can ask for consent again (for example after 90 days, or when the
certificate is removed). The Bank tab's status (B3) then says so and an
email goes out; the model keeps the last synced balance until it is fixed.
Reconnect with a new code: Revolut → Connect Revolut, then Enable access in
Revolut again (step 6). If Revolut only gives the last 90 days of history, the
status says that too.

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

44 checks for the Revolut sync against a fake Revolut API: the signed sign-in
token (verified with the public key), connecting with a pasted redirect
address, PKCS#1 keys refused with a fix, balances in several currencies,
inactive accounts, one row per leg, internal transfers and exchanges, fees,
declined payments, categories from rules, inventory names and invoice numbers,
invoices marked Paid by reference or a unique amount (and left alone when two
match), month-end balances, re-runs that change nothing, more than 1,000
transactions, a retried server error, expired access, the 90-day limit, and
that only GET requests reach the API.
