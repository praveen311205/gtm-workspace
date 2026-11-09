# Invoice Archiver - setup (about 10 minutes)

This copies software invoices and receipts from your Gmail into a shared Drive folder, so the inventory tool can read them, PDFs included. Set it up once and it runs on its own every hour. Nothing is forwarded or deleted. The script only adds an "Invoice-archived" label to the emails it has saved.

Do this in **each Gmail account that receives software bills**: Navin's first, then anyone else who gets a few.

## Praveen does this once

1. In Google Drive, create a folder called **GTM Talent - Invoices**.
2. Share it with everyone who will install the script, as **Editor**.
3. Open the folder and copy its ID: the part of the URL after `/folders/`. Send it to them.

## Each inbox owner does this

1. Go to **script.google.com**, signed in as the account that receives the bills, and click **New project**.
2. Rename the project "Invoice Archiver" (click "Untitled project" at the top).
3. Delete the sample code and paste in everything from `invoice-archiver.gs`.
4. Near the top, replace `PASTE_FOLDER_ID_HERE` with the folder ID from Praveen. Keep the quote marks.
5. Click **Save** (the disk icon).
6. In the function menu next to **Run**, choose **setup**, then click **Run**.
7. Google asks for permission. Click **Review permissions**, choose your account, then **Advanced → Go to Invoice Archiver (unsafe) → Allow**. The "unsafe" warning appears for any script you write yourself; this one only reads Gmail, writes to that one Drive folder, and adds a label.
8. Done. The first run starts on the last 18 months and the hourly runs finish the backlog, usually within a few hours. Files appear in the shared folder as `2026-10-01 - Loxo - Your invoice.txt` and `... .pdf`.

## Checking it works

- In the script editor, click **Executions** (left sidebar). Each run should show "Done. X matching threads, Y new emails saved."
- In Gmail, the label **Invoice-archived** should appear on billing emails.

## If a tool's bills aren't being picked up

Open the script and add the vendor's email domain to the `VENDOR_SENDERS` list, then save. Bills with "invoice" or "receipt" in the subject are caught anyway.

## To stop it

In the script editor, open **Triggers** (the clock icon) and delete the `archiveInvoices` trigger.
