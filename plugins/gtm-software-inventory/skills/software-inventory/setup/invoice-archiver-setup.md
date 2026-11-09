# Invoice Archiver - setup (about 10 minutes)

This copies invoices and receipts from your Gmail into a shared Drive folder,
so the inventory tool can read them and the accountant can get them. Set it up
once and it runs on its own every hour. Nothing is forwarded or deleted. The
script only adds an "Invoice-archived" label to the emails it has saved.

Do this in **every account that receives bills**: Navin's work account first,
then any **personal Gmail** that some company bills still go to, then anyone
else who gets a few. It works the same in a personal Gmail.

## Praveen does this once

1. In Google Drive, create a folder called **GTM Talent - Invoices**.
2. Share it as **Editor** with every account that will run the script,
   personal Gmail addresses included.
3. Open the folder and copy its ID (the part of the URL after `/folders/`).
   Send it to them.

## Each inbox owner does this

1. Go to **script.google.com**, signed in as the account that receives the
   bills, and click **New project**. Check the account picture top right: the
   script reads the mailbox of whoever is signed in.
2. Rename the project "Invoice Archiver" (click "Untitled project" at the top).
3. Delete the sample code and paste in everything from `invoice-archiver.gs`.
4. Near the top, replace `PASTE_FOLDER_ID_HERE` with the folder ID from
   Praveen. Keep the quote marks.
5. Optional: if this inbox also gets personal receipts (your own Amazon or
   Uber orders), add those senders to `EXCLUDE_SENDERS`, e.g.
   `['amazon.nl', 'uber.com']`. Anything that is not excluded and has
   "invoice/receipt/factuur" in the subject ends up in the shared folder.
6. Click **Save** (the disk icon).
7. In the function menu next to **Run**, choose **setup**, then click **Run**.
8. Google asks for permission. Click **Review permissions**, choose your
   account, then **Advanced → Go to Invoice Archiver (unsafe) → Allow**. The
   "unsafe" warning appears for any script you write yourself. It asks for:
   Gmail (read, and add one label), Drive (write to the shared folder), and
   "connect to an external service" (only to download invoice PDFs from
   Stripe/Paddle receipt links).
9. Done. The first run starts on the last 18 months and the hourly runs finish
   the backlog, usually within a few hours.

## What lands in the folder

For every billing email: `2026-10-01 - Loxo - Your invoice m1a2b3c4d.txt`, and
the invoice itself as `... - <attachment name> h<code>.pdf`. The `.txt` says how
the invoice was found:

| `Retrieval:` | Meaning |
|---|---|
| `attachment` | PDF attached (also PDFs inside a .zip, Dutch XML e-invoices, or a photo of a receipt) |
| `link` | PDF downloaded from a Stripe/Paddle receipt link that needs no login |
| `email-body` | The email itself is the receipt; it was saved as a PDF |
| `none` | Nothing to download - fetch it by hand. `Portal links:` lists the billing page links found in the email |

Also handled, so you don't need to:
- The same bill in two inboxes, or the same PDF sent twice, is saved once.
- Bills you already deleted (still in Trash) are found too.
- Your own replies in a billing thread are skipped. A bill a colleague forwards
  you is filed under the vendor, not the colleague.
- Full card numbers in an email are masked to the last 4 digits.
- One broken email never stops the rest: it is retried for 3 hours, then
  listed under "Gave up" in the status file.
- Google's daily limits: the run stops and continues the next hour.
- Two runs never overlap.

## Checking it works

- The folder gets a file **`_archiver-status - <your email>.txt`**, updated
  every run: last run time, emails saved, how each invoice was retrieved,
  failures, and **possible invoices in your spam folder** (these are never
  archived - have a look, and mark them "Not spam" if they are real).
- In the script editor, **Executions** (left sidebar) should show a run every
  hour.
- In Gmail, the label **Invoice-archived** appears on billing emails.

## When something goes wrong

| What you see | What to do |
|---|---|
| "Set CONFIG.FOLDER_ID..." when running setup | Step 4: paste the folder ID between the quotes. |
| "Exception: No item with the given ID could be found" / "Access denied" | The folder isn't shared with this account as Editor (Praveen's step 2), or the ID is wrong. |
| "This app is blocked" / "Your administrator has blocked..." | Google Workspace blocks home-made scripts. In admin.google.com → Security → API controls, allow it, or ask whoever manages the Workspace. |
| An email from Google "Summary of failures for Google Apps Script" | Open it: usually the folder was unshared or Drive is full. Fix that; the next hour retries automatically. |
| The status file's "Last run" is more than a day old | The hourly trigger stopped - this happens after a password change or revoking access. Run **setup** again. The inventory tool also warns about this. |
| A tool's bills aren't being picked up | Add the vendor's email domain to `VENDOR_SENDERS` and save. Bills with invoice/receipt/factuur/Rechnung in the subject are caught anyway. |
| A vendor emails a "download your invoice" link that needs a login | The `.txt` says `Retrieval: none` with the link. That tool is "Manual" in the inventory; download it from the portal. |

## To update the script

Replace the code with the new version, keep your `FOLDER_ID` and
`EXCLUDE_SENDERS`, save, and run **setup** once more.

## To stop it

In the script editor, open **Triggers** (the clock icon) and delete the
`archiveInvoices` trigger.
