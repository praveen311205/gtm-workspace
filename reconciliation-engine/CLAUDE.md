# CLAUDE.md

Context for Claude when working on this project. User-facing docs are in README.md.

## What this is

A single-file weekly invoice run (`reconcile.py`): ingest PDFs (Gmail → local
folder), **decide** which are real invoices/receipts/credit notes (`classify`,
`REJECT_RULES`), match those to bank `Transaction`s (bank CSV import), decide
FORWARD / HOLD / WAIT per match (`decide`), and export an email draft with only
the forwarded PDFs attached plus a short summary. `ledger.json` records what was
forwarded, prevents double sending and provides precedents.

## Layout of reconcile.py (top to bottom)

1. Data structures – `Transaction`, `Document` (with `date_range`, `source_path`,
   `sha256`), `Match`, `DocumentCheck`, `MissingDocument`, `ReconciliationResult`.
2. Input data – sample `TRANSACTIONS` and `DOCUMENTS` (used without `--bank-csv` / `--docs-dir`).
3. Vendor resolution – `normalize_vendor`, `VENDOR_ALIASES`, `resolve_vendor` (+ learned aliases).
4. Date window – `date_gap`, `date_fits`, `check_document`.
5. Matching – `reconcile()`: exact → netted → partial → missing passes; `vat_check`.
6. Amount/date parsing – shared by the PDF parser and `--find`; `extract_vat`.
7. Invoice-or-not – `REJECT_RULES`, `classify` (raises `NotAnInvoice`).
8. Local PDF parsing – `parse_pdf`, `load_documents` → `LoadedDocuments`.
9. Gmail ingestion – `connect_gmail`, `download_gmail_pdfs` (+ `_gmail_index.json` subjects).
10. Raw-email PDFs and bank CSV import – `import_eml_pdfs`, `load_bank_csv`, `load_request`.
11. Ledger and precedents – `load_ledger`, `build_precedents`, `learned_aliases`.
12. Weekly run – `decide`, `run_week` → `WeeklyRun`, `record_week`.
13. Output – `render_weekly_report`, `render_lookup`.
14. Forward email – `build_forward_email`, `export_forward_email`.
15. CLI (`if __name__ == "__main__"`).

## Rules that must keep holding

- **Money is `Decimal`**, never float. Transaction amounts are signed
  (negative = outflow); `Document.expected_bank_amount` gives the signed
  amount a document should produce on the statement.
- **A document qualifies only if date, amount and vendor all agree**, and
  **each document is used at most once** (passes remove matched docs from
  `open_docs`). Ties go to the closest date.
- **Never send email.** Gmail scope is `gmail.readonly`; output is an
  `X-Unsent` `.eml` draft the user reviews. The owner wants to cross-check
  before anything reaches the accountant – don't add sending unless asked.
- **Only real invoices/receipts/credit notes are matched or forwarded.**
  Notices, reminders, summaries, statements and quotes are set aside in
  `load_documents` (listed with a reason in the report, never in the email).
- **Forward** only matched documents; **HOLD** when the vendor is a fuzzy guess
  or a document is undated (unless `--approve`d). Unmatched documents WAIT.
- The email carries **only invoice PDFs** as attachments (an Exact inbox books
  every attachment); the full report stays local.
- **Never forward twice**: `run_week` skips documents/bank lines in the ledger
  from other weeks; same-week entries are replaced on re-run.
- Downloaded attachments are untrusted: keep `safe_filename`, the `%PDF`
  check and content-hash de-duplication.
- Never read, print or commit `credentials.json` / `token.json` or files
  under `documents/`.

- **VAT rule:** expenses (payable, not credit notes) strictly over
  `VAT_CHECK_THRESHOLD` (€100) with `vat_amount == 0` get a VAT note on their
  `Decision` (action in the report, "no VAT shown" in the email); it never
  blocks forwarding. `vat_amount is None` means "not read" and is never flagged.
  Client invoices are never flagged.

- **Accountant requests** (`--request`, `resend=True`) send previously forwarded
  documents again; the unattended procedure is `RUNBOOK_accountant_request.md`.

## Testing

```bash
python tests/smoke_test.py
python tests/run_cases.py      # edge cases from tests/edge_cases.csv
```

Add every new real-world edge case as rows in `tests/edge_cases.csv`
(`known_bug` until fixed, then `must_pass`).

Generates synthetic invoice PDFs (including a Sep and an Oct Loxo invoice, a
duplicate copy and a scanned page), runs parsing + reconciliation, checks the
Loxo date logic, the `--find` parser and Gmail download against a fake
service. Run it after any change to matching or parsing, and add a case for
any bug you fix.

## Open items (from the owner's checklist)

- Colour-coded console output (keep the saved report/email plain text).
- Track remaining balances so a second partial payment settles the invoice.
- Ignore list for bank lines that never have an invoice (fees, tax, salaries).
- VAT rule treats non-EU suppliers (no VAT is normal, reverse charge applies)
  the same as EU/Dutch ones – owner to decide on a per-supplier VAT table.
- Live Gmail run has not been verified with real credentials yet.
