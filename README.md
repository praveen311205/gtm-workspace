# GTM Talent workspace

Internal tools and builds for GTM Talent.

| Folder | What |
|---|---|
| [`reconciliation-engine/`](reconciliation-engine/) | Forwards only real invoices/receipts to the accountant, each matched to its bank payment, with a weekly summary; answers the accountant's missing-documents request ([runbook](reconciliation-engine/RUNBOOK_accountant_request.md)). |

Financial documents, bank exports, ledgers and OAuth files never go in this
repo (see each tool's `.gitignore`).
