# Reconciliation Engine

A weekly run that sends your accountant **only real invoices and receipts**,
each matched to the bank payment it belongs to, with a short summary of what
is attached and which payments still lack a document. Everything is in one
script, `reconcile.py`.

```
PDFs (folder / Gmail)
  │
  ├─ not an invoice? ── set aside, with the reason      (failed-payment notices,
  │                                                      reminders, invoice summaries,
  │                                                      statements, quotes)
  ▼
real invoice / receipt / credit note
  │
  ├─ matched to a bank line ──────── FORWARD (PDF attached to the draft)
  ├─ matched, but name is a guess
  │  or the document has no date ─── HOLD for your check (--approve to send)
  └─ no bank line yet ────────────── WAIT (retried next week)

bank lines without a document ────── MISSING (in the email, with precedent hints)
recurring invoices due but unseen ── EXPECTED (in your report)
```

## Setup

Python 3.10 or newer.

```bash
python -m pip install -r requirements.txt
```

## Weekly use

```bash
# Download this period's PDFs from Gmail, then run the week
python reconcile.py --bank-csv dkb.csv --gmail --docs-dir documents \
    --company "Your Company BV" --accountant Anna --sender "Your Name" \
    --accountant-email your-inbox@exact.example

# Same, from a folder you filled yourself
python reconcile.py --bank-csv dkb.csv --docs-dir documents --company "Your Company BV"

# A document was held (fuzzy bank name / no date) and you checked it: send it
python reconcile.py --bank-csv dkb.csv --docs-dir documents --approve Loxo_Invoice_Sep.pdf

# Try it on the built-in sample data
python reconcile.py

# Which document belongs to one statement line?
python reconcile.py --docs-dir documents --find "12 Sep | -€180.00 | LOXO"

# Self-check (no Gmail account or real documents needed)
python tests/smoke_test.py
```

Each run prints your report and writes:

| File | Purpose |
|---|---|
| `forward_<week>.eml` | Draft to the accountant with **only** the forwarded PDFs attached; opens as an unsent draft in Outlook/Apple Mail |
| `forward_<week>.txt` | Same email as plain text |
| `weekly_report_<week>.txt` | Your full report: forwarded, held, missing, expected, set aside, waiting |
| `ledger.json` | What has been forwarded so far (see below) |

**Nothing is ever sent.** Review the draft and send it yourself. The report is
deliberately *not* attached: an Exact Online inbox turns every attachment into
a document to book, so the email carries invoice PDFs and nothing else.

`<week>` is the ISO week of `--week-ending` (default: today), e.g. `2026-W45`.

## Answering the accountant's missing-documents request

Every ~6 weeks the accountant asks for documents for a list of payments. Put
the list in a file (one `date | amount | bank text` per line, or a CSV) and run:

```bash
python reconcile.py --request request.txt --docs-dir documents --ledger ledger.json \
    --accountant Anna --sender "Your Name"
```

Same decision and matching as the weekly run, with two differences: documents
that were already forwarded are sent again (the accountant is asking for them,
the note says when they went before), and the subject reads
"Missing documents: 3 of 5 found, 2 still open". `--eml-dir DIR` first pulls
the PDF attachments out of raw emails (`*.eml`), e.g. fetched through a Gmail
connector. A scheduled Claude session does all of this unattended; see
`RUNBOOK_accountant_request.md`.

## Step 1 – is it a real invoice or receipt?

Every PDF is checked before matching. It is **set aside** (listed in your
report with the reason, never matched, never forwarded) when:

| Kind | Recognised by (title area or email subject) |
|---|---|
| failed-payment notice | "payment failed", "card declined", "couldn't charge", "update your payment method", "betaling mislukt", "Zahlung fehlgeschlagen" |
| payment reminder | "reminder", "herinnering", "aanmaning", "Zahlungserinnerung", "Mahnung", "overdue" |
| invoice summary / statement | "invoice summary", "billing summary", "statement", "Kontoauszug", "Kreditkartenabrechnung", "overzicht", "upcoming invoice" |
| quote / pro forma | "quote", "offerte", "Angebot", "order confirmation"; anywhere: "pro forma", "this is not an invoice" |
| not an invoice | no invoice / receipt / credit note wording at all |

The *title area* is the file name, the email subject (saved by `--gmail` in
`documents/_gmail_index.json`) and the short lines (≤ 7 words) among the first
12 lines of the PDF. Small print such as "if a payment fails we will send a
reminder" on a real invoice is therefore not mistaken for a title.

This matters for matching too: a failed-payment notice or reminder carries the
same vendor and amount as the real invoice, and used to be matched to the bank
line in its place. Add patterns to `REJECT_RULES` when a new kind of notice
turns up.

## Step 2 – match to the bank line

Every transaction is split into **date, amount and vendor**, and a document
only qualifies if all three agree:

- **vendor** – same name after normalising (case, punctuation, legal suffixes
  like BV/Inc/GmbH), via the `VENDOR_ALIASES` table (`AMZN MKTP` → Amazon),
  a bank text learned from earlier weeks, or a close fuzzy match.
- **amount** – document total equals the bank amount, sign included
  (supplier invoices are outflows, sales invoices inflows).
- **date** – document dated at most `PAYMENT_LAG_DAYS` (45) before the payment
  and `EARLY_PAYMENT_DAYS` (7) after it; the closest date wins. A document
  named only by month (`Invoice_Sep.pdf`) covers that whole month.

Then, in order, each pass only seeing what is still open: **exact** (1 ↔ 1),
**netted** (invoice + credit note = payment), **partial** (payment is part of
an invoice; the rest is noted as outstanding). **Every document is used at
most once**, so September's invoice can never be reused for October's charge.

## Step 3 – forward, hold or wait

- **Forward**: matched by exact name, alias table or learned bank text, with a
  dated document. Part payments and net settlements are forwarded with a
  one-line note.
- **Hold** (not sent, listed in your report): the bank name only *resembles*
  the vendor (fuzzy), or the document has no date. Check it, then re-run with
  `--approve <file name>`.
- **Wait**: a real document with no bank payment yet. Nothing to do; it goes
  out in the week the payment appears.
- `--purchases-only` stops your own sales invoices from being forwarded.

## Ledger and precedents

`ledger.json` (in `--out-dir`, or `--ledger PATH`) records every forwarded
document and the bank line it settled. Because of it:

- **Nothing is sent twice.** Next week's Gmail window overlaps this week's, and
  the bank export may too; documents and bank lines already in the ledger are
  skipped.
- **Re-running a week is safe**: entries of the same week are replaced, so you
  can fix something and run again. `--dry-run` doesn't touch the ledger.
- **Precedents** from past weeks:
  - a bank text that was matched before (e.g. after an `--approve`) is
    recognised next time,
  - a payment without a document gets a hint such as *"bills monthly, usually
    €180.00; last: Loxo_Invoice_Oct.pdf (01 Oct) – same amount, so most likely
    the regular invoice"*,
  - a vendor that bills weekly/monthly/quarterly/yearly and whose next invoice
    is more than `EXPECT_GRACE_DAYS` (10) late – with neither an invoice nor a
    payment since – is listed as **expected, not seen**.

The built-in sample never writes a ledger unless you pass `--ledger`.

## Bank statements

`--bank-csv FILE` (repeatable, e.g. current account + credit card) reads
Revolut Business, DKB, ING, Rabobank, bunq and most generic exports: the header row is found
automatically, amounts like `-1.234,56` are understood, `Af/Bij` and
`Soll/Haben` columns set the sign, and pending (`Vorgemerkt`) lines and
declined/reverted card payments (Revolut `State`) are skipped. `--since` drops older lines. Without `--bank-csv` the sample
`TRANSACTIONS` in `reconcile.py` are used.

## VAT check

Every expense (supplier invoice or receipt, not credit notes or client
invoices) **over €100** whose document shows **no VAT** gets a VAT note: in
your report with what to do, and in the email as "no VAT shown on the
invoice". It never stops a document from being forwarded.
If the invoice says the VAT is reverse-charged ("reverse charge",
"btw verlegd"), the note asks you to confirm the supplier's VAT number instead.

- The VAT amount is read from lines mentioning VAT / BTW / TVA / MwSt / USt /
  IVA / Tax; a VAT *number*, a percentage or a "Total incl. VAT" line is not
  VAT, but "Total VAT €21.00" is.
- Non-invoices (notices, reminders, summaries) are set aside before this check,
  so they no longer produce VAT flags.
- Documents whose VAT was never read (the built-in sample list) are not judged,
  so the rule only fires with `--docs-dir`.
- Change the limit with `VAT_CHECK_THRESHOLD`.

## Edge cases

`tests/edge_cases.csv` holds scenarios as spreadsheet rows (bank lines,
documents, and what should happen). Run them with:

```bash
python tests/run_cases.py
```

`must_pass` cases have to keep working; `known_bug` cases document problems
that are allowed to fail until fixed.

## Gmail setup (only for `--gmail`)

1. In [Google Cloud Console](https://console.cloud.google.com/) create a
   project, enable the **Gmail API**, and create an **OAuth client ID** of
   type *Desktop app*.
2. Download its JSON as `credentials.json` next to `reconcile.py`
   (or pass `--gmail-credentials PATH`).
3. On the first run a browser window asks you to allow **read-only** Gmail
   access; the sign-in is cached in `token.json`.

The search covers emails with PDF attachments in a 6-week window ending a
week after the last transaction (override with `--gmail-since` /
`--gmail-until`). Attachments are de-duplicated by content.

> `credentials.json` and `token.json` give access to your mailbox. They are
> in `.gitignore` – never share them. Each person sets up their own.

## Adapting it to your data

- **Vendor aliases** – add your bank's abbreviations to `VENDOR_ALIASES`.
- **Your company name** – pass `--company` so the PDF parser can tell your
  sales invoices from supplier invoices. Without it, files named `INV-…` /
  `CN-…` are treated as your own.
- **Tolerances** – `PAYMENT_LAG_DAYS`, `EARLY_PAYMENT_DAYS`, `FUZZY_CUTOFF`,
  `GMAIL_WINDOW_WEEKS`, `EXPECT_GRACE_DAYS` at the top of their sections.
- **What counts as a non-invoice** – `REJECT_RULES`.

## Known limitations

- PDF parsing is heuristic (labelled totals/dates, common layouts); unusual
  invoices may need tweaks. Scanned PDFs without a text layer are listed for
  manual entry.
- A partially paid invoice is closed after its first payment; a later
  payment of the remaining balance is not matched against it yet.
- The invoice/non-invoice decision is keyword-based; an unusual notice can
  slip through (add a rule) and an invoice with an odd title can be set aside
  (it is listed in your report, so you will see it).
- Bank lines that never get an invoice (bank fees, tax, salaries, transfers
  between your own accounts) are listed as missing; there is no ignore list yet.
- No colour in the terminal output.
- The live Gmail connection has only been tested against a mock service.

See `CLAUDE.md` for notes aimed at working on the code with Claude.
