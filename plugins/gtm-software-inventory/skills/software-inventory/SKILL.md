---
name: software-inventory
description: Use when anyone at GTM Talent wants to build, refresh or query the company's software/SaaS inventory - "update the software inventory", "what tools are we paying for", "scan the inbox for invoices", "what renews this month", "what's our notice period on Loxo", "where are we double-paying", or a monthly scheduled refresh. Scans Gmail for receipts, invoices and renewal notices from software vendors, extracts plan, cost, billing cycle, renewal date, notice period, payment card, owner, purpose and overlaps, and writes the result to the "GTM Talent - Software Inventory" Google Sheet.
---

# GTM Talent Software Inventory

Builds and maintains one inventory of every paid tool GTM Talent uses, sourced from the billing emails in Gmail. Output is a Google Sheet; the chat reply is only a short summary of what changed.

## 0. Check the sources first

The tool reads two sources:
- **The Drive invoice archive**: the folder **"GTM Talent - Invoices"**. The Invoice Archiver Apps Script (`scripts/invoice-archiver.gs`) fills it from every inbox that receives bills, Navin's included. It holds one `.txt` per billing email (`<date> - <vendor> - <subject> m<id>.txt`) whose header gives the original mailbox, sender, date, subject, Gmail link, `Retrieval:` (attachment / link / email-body / none), `Saved files:`, `Portal links:` and `Sender check:`, plus the invoice files themselves, each named after its `.txt` (`<same name> - <attachment> h<code>.pdf`).
- **The connected Gmail account**, for bills sent to whoever is running the skill.

Before scanning, find the folder with Drive `search_files` (by name), and run one cheap Gmail search (`receipt OR invoice newer_than:12m`, `THREAD_VIEW_IDS_ONLY`). If the folder is missing or empty *and* Gmail returns almost nothing, stop. Tell the user which account is connected, and point them to `setup/invoice-archiver-setup.md`. Do not produce an inventory from empty sources.

Then read every `_archiver-status - <mailbox>.txt` in the folder and carry these into the summary flags:
- **Archiver stopped**: `Last run` more than 26 hours ago. That inbox's bills since then are missing; its owner should run `setup` again.
- **Gave up** lines: emails the archiver could not save. Name them so someone fetches them by hand.
- **Possible invoices in spam** above 0: someone should check that inbox's spam folder.
- A `Note` about the quota or time limit is normal during the first backlog; only flag it if it repeats for more than a day.

## 1. Discover billing emails

Look back **18 months** on a first run, or since the "Last scanned" date on the sheet's `About` tab on a refresh. Run these searches with `pageSize: 50` and paginate until no `pageToken` is left. Search previews show only the 5 oldest messages per thread, so collect thread IDs here and read the threads in step 2.

1. **Known vendors**: for each vendor in `references/vendors.md`, search `from:(<sender domains>) newer_than:18m` and the vendor name together with `(receipt OR invoice OR renew OR subscription OR payment OR plan)`.
2. **Unknown vendors**: run these generic sweeps:
   - `category:purchases newer_than:18m`
   - `subject:(receipt OR invoice OR "payment received" OR "payment confirmation" OR "your subscription" OR "renewal" OR "renews" OR "upcoming charge" OR "trial ends") newer_than:18m`
   - `from:(stripe.com OR paddle.com OR chargebee.com OR recurly.com OR billing OR invoice OR receipts) newer_than:18m`
   - `filename:pdf (invoice OR receipt) newer_than:18m`
3. Drop marketing mail, newsletters, webinar invites, product announcements and team invites. A thread counts only if it shows money moving or about to move: an amount, a charge, a renewal, or a failed payment.
4. **Drive archive**: list every `.txt` in "GTM Talent - Invoices" whose date prefix falls in the scan window. Each one is a billing email; treat it exactly like a Gmail thread. Use the `Gmail link` and `Mailbox` lines from its header as the source and the original recipient.
5. **De-duplicate**: the archiver already saves an email that reached two inboxes only once (same Message-ID), and an identical file only once (a `.txt` then says `same file as ...`). An email can still show up both in the archive and in the connected Gmail, and a vendor can send the same invoice twice as separate emails. Treat matching vendor + date + amount (or the same invoice number) as one email.
6. Group the emails by vendor. Many invoices come through Stripe or Paddle, so take the vendor from the merchant name in the body, not from the sender domain.

Any vendor found here that is not in `references/vendors.md` is a **new tool**. Add it to the sheet and flag it in the summary.

## 2. Read and extract

For each vendor, read the **3 most recent** billing emails: Gmail threads with `get_thread` (`PLAIN_TEXT`), archive `.txt` files with Drive `read_file_content`. Read more if the cycle or price is unclear. For every other billing email, keep only the date, the amount and the message link; these go in the `Invoice log` tab.

**PDF fallback.** If the email body is missing the amount, plan, billing period, invoice number or payment method, and the `.txt` header lists saved files, open the matching file in the same folder with `read_file_content`: its name starts with the `.txt` name (without `.txt`), or is the one named in `same file as ...`. Use its values and mark the source as "PDF". If it reads as empty (a scanned image or a photo), mark the field "PDF unreadable - check manually"; a password-protected PDF the same. An `.xml` file is a structured e-invoice: read the amount, VAT and invoice number from it directly. A Gmail thread that is not in the archive can't have its PDF opened. If it has a PDF and the body lacks the values, say so in Confidence: "PDF not archived". This usually means its inbox doesn't run the archiver yet.

**Do not trust an email that fails the sender check.** If `Sender check:` shows `dmarc=fail` (or the From domain does not belong to the vendor it claims to be), do not use it for prices or renewal dates; list it under the flag "Possible fake invoice".

Extract each field below. Use the method that applies, in the order listed, and record which method you used in the `Confidence` column.

| Field | How to determine |
|---|---|
| **Tool / Vendor** | The merchant name, e.g. "Claude (Anthropic)". |
| **Used for** | One line on what GTM Talent uses the tool for. Start from `references/vendors.md`; refine it from the plan name or line items. |
| **Owner** | The person the invoice is addressed to ("Billed to", "Hi Navin") or the recipient address. If the bill is forwarded, the owner is the original recipient, not the person who forwarded it. |
| **Plan** | The plan or tier name and seat count, e.g. "Team - 3 seats" or "Recruiter Lite". |
| **Cost (as billed)** | The amount and currency exactly as invoiced, with VAT noted separately when it is shown. |
| **Monthly cost (EUR)** | Normalise to per month: annual ÷ 12, quarterly ÷ 3. Convert USD or GBP to EUR at the rate on the invoice date and say it is converted. Usage-based tools such as Clay credits or Zapmail mailboxes: use the average of the last 3 invoices and mark it "variable". |
| **Billing cycle** | (a) Stated on the invoice ("billed monthly", or a period like "Oct 1 - Nov 1"). Otherwise (b) inferred from the gaps between invoices: 25-35 days is monthly, 85-95 quarterly, 355-375 annual. With only one invoice, write "Unknown (1 invoice)". |
| **Renewal date** | (a) Stated in a renewal or "upcoming charge" email, or the period end on the invoice. Otherwise (b) last invoice date + cycle, marked "projected". If the projected date is in the past and no newer invoice exists, set Status to "Possibly cancelled". |
| **Notice period** | (a) Stated in the terms ("cancel at least 30 days before renewal"). Otherwise (b) **the time between a renewal-reminder email and the renewal date it names**: a reminder 7 days before renewal gives a notice period of "7 days (from reminder)". If neither exists, write "Before renewal (self-serve, assumed)" for monthly card-billed SaaS and "Unknown - check contract" for annual or sales-led contracts such as Loxo, LinkedIn Recruiter or WeWork. Never present an assumption as fact. |
| **Cancel-by date** | Renewal date minus notice period. This is the date that matters most. |
| **Invoice retrieval** | How the accountant's copy is obtained, from the `Retrieval:` lines of the vendor's last 3 archived emails. **Auto - attachment**, **Auto - link** or **Auto - email** when the last real invoice came that way. **Manual - portal** when invoices only say `none`, with the billing page from `Portal links:` (e.g. "Manual - portal: linkedin.com/premium/billing"). **Manual - no billing email** for a tool that costs money but sends nothing (seen only on the bank or card statement, e.g. a Revolut plan fee). If the pattern changed (Auto before, Manual lately), use the latest and say so. Failed-payment notices, reminders and renewal notices say `none` by nature: ignore them here. |
| **Billed to (entity)** | The customer name and VAT number on the invoice. Flag it when it is a person (e.g. "Navin Premkumar") or a personal address instead of "GTM Talent BV" with VAT number NL866145801B01: the accountant cannot deduct VAT on an invoice not addressed to the company. Also flag app-store receipts (Apple, Google Play), which are not VAT invoices. |
| **Payment method** | The card brand and last 4 digits ("Visa •• 4242"), "SEPA direct debit", "bank transfer" or "Revolut card •• 1234". Never record a full card number, even if an email contains one. |
| **Overlaps with** | Other tools in the inventory with the same job, using the categories in `references/vendors.md`, plus a one-line note on whether it is real duplication or complementary. |
| **Status** | Active, Trial, Possibly cancelled (no invoice when one was expected), Payment failed, or Cancelled (a confirmation email exists). |
| **Last invoice / Source** | The date of the most recent invoice and a link to it: the Drive link of the archived `.txt` or PDF, which the whole team can open, or else the Gmail `viewUrl`, which only that inbox's owner can open. |
| **Confidence** | High (stated on the invoice), Medium (inferred from the pattern) or Low (assumed). Name the fields that are inferred. |

Flag these in the summary, not just in the sheet:
- **Price change**: the latest amount differs from the previous one by more than 5%.
- **Cancel-by within 30 days**.
- **Payment failed** or card-expiring emails.
- **New vendor** that is not in the reference list.
- **Silent vendor**: a known tool with no invoice where one was expected. It may be cancelled, or billed to another inbox.
- **Overlap clusters** where more than one paid tool does the same job.
- **Manual retrieval**: every tool whose `Invoice retrieval` is Manual, with where to download it. These are the ones someone has to fetch each period.
- **Billed to a person** or missing the company VAT number (see above), and app-store receipts.
- **Possible fake invoice** (failed sender check).
- **Archiver stopped / gave up / invoices in spam**, from step 0.

## 3. Write the Google Sheet

Load the `google-workspace` skill before making any Sheets or Drive call.

Search Drive for **"GTM Talent - Software Inventory"**. If it exists, update it in place; if not, create it. Tabs:

1. **Inventory**: one row per tool, with the columns in the order of the table above. Sort by Monthly cost (EUR), highest first. Put a total-monthly and total-annual row at the bottom, using formulas.
2. **Renewals**: Tool, Renewal date, Cancel-by date, Monthly cost, Owner. Sort by cancel-by date and cover only the next 90 days.
3. **Overlaps**: Category, Tools, Combined monthly cost, Note (duplication or complementary), Suggested action.
4. **Invoice log**: Date, Vendor, Amount, Currency, Invoice #, Recipient mailbox, Retrieval (attachment / link / email-body / none), Source (email body / PDF), Link. Add one row per billing email, skipping any email already in the log (same Gmail link or same invoice number) so a refresh adds no duplicates.
5. **About**: Last scanned date, sources scanned (the connected inbox, plus the mailboxes that appear in the archive, each with its archiver's last run), and how many emails were found versus used.

On a refresh, never overwrite a cell a human has edited in the `Owner`, `Used for` or `Notes` columns. Only fill those columns when they are blank. Keep a `Notes` column that the tool never writes to.

## 4. Reply

Keep the reply short:
- The sheet link.
- The headline numbers: tool count, total monthly spend, total annual spend.
- The flags from step 2, as a bullet list.
- Any field marked Low confidence for a tool costing over €100/month, named so someone can check the contract.

## Scheduling

To keep the inventory current, suggest a monthly scheduled task on the 2nd of each month, at a time outside 06:00-09:00 Pacific, with this prompt: "Run the software-inventory skill as a refresh since the last scan and post the summary." Set it up only when the user says yes.
