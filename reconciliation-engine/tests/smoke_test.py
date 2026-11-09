"""Self-check for reconcile.py - no Gmail account or real documents needed.

    python tests/smoke_test.py

Generates synthetic invoice PDFs, then checks PDF parsing, the invoice /
non-invoice decision, the date/amount/vendor matching (incl. the Sep vs Oct
Loxo case), bank CSV import, the weekly run with its ledger and precedents,
the --find parser and the Gmail download against a fake service.
"""

import base64
import email
import json
import shutil
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import reconcile as rc  # noqa: E402

TMP = Path(__file__).resolve().parent / "_tmp"
OWN = ["Acme Studio BV"]
passed = 0


def check(condition: bool, what: str) -> None:
    global passed
    if not condition:
        raise SystemExit(f"FAIL: {what}")
    passed += 1
    print(f"  ok  {what}")


# --------------------------------------------------------------------------
# Synthetic PDFs
# --------------------------------------------------------------------------

def make_pdf(path: Path, lines: list[str]) -> None:
    """Minimal one-page text PDF (Helvetica, WinAnsi so € works)."""
    def esc(s: str) -> bytes:
        return s.encode("cp1252").replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")

    stream = b"BT /F1 11 Tf 50 800 Td 15 TL\n" + b"".join(b"(" + esc(l) + b") Tj T*\n" for l in lines) + b"ET"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % off for off in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    path.write_bytes(bytes(out))


SAMPLE_PDFS = {
    "Anthropic_Receipt_2026-09-03.pdf": [
        "Anthropic, PBC", "Receipt #2291-0042", "Date paid: September 3, 2026",
        "Bill to: Acme Studio BV", "Claude Pro (monthly)   €90.00", "Amount paid   €90.00"],
    "lemlist_Invoice_Sep.pdf": [
        "lemlist SAS", "Invoice LM-88812", "Invoice date: 01/09/2026", "Billed to: Acme Studio BV",
        "Subtotal  €82.50", "VAT 20%  €16.50", "Total  €99.00"],
    "Loxo_Invoice_Sep.pdf": [
        "INVOICE", "From: Loxo Inc.", "Bill to: Acme Studio BV", "Invoice date: 1 Sep 2026",
        "Due date: 15 Sep 2026", "Loxo Pro subscription (Sep 2026)   €180.00", "Total due   €180.00"],
    "Loxo_Invoice_Oct.pdf": [
        "INVOICE", "From: Loxo Inc.", "Bill to: Acme Studio BV", "Invoice date: 1 Oct 2026",
        "Due date: 15 Oct 2026", "Loxo Pro subscription (Oct 2026)   €180.00", "Total due   €180.00"],
    "INV-041_ClientA.pdf": [
        "From: Acme Studio BV", "Invoice INV-041", "Invoice date: 2026-09-01", "Bill to: Client A",
        "Website project - milestone 1 & 2", "Total due  9.500,00 €"],
    "INV-043_ClientB.pdf": [
        "From: Acme Studio BV", "Invoice INV-043", "Invoice date: 2026-08-28", "Bill to: Client B BV",
        "Brand strategy", "Total due  €14,000.00"],
    "INV-044_ClientC.pdf": [
        "From: Acme Studio BV", "Invoice INV-044", "Invoice date: 2026-09-15", "Bill to: Client C",
        "Retainer Q3", "Total due  €7,500.00"],
    "CN-002_ClientC.pdf": [
        "From: Acme Studio BV", "Credit note CN-002 (against INV-044)", "Credit note date: 2026-09-20",
        "Bill to: Client C", "Discount agreed", "Total  -€1,250.00"],
    "scan_0001.pdf": [],   # no text layer, like a scanned image
}


def build_docs(folder: Path, skip: tuple[str, ...] = ()) -> Path:
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    for name, lines in SAMPLE_PDFS.items():
        if name not in skip:
            make_pdf(folder / name, lines)
    if "Loxo_Invoice_Sep.pdf" not in skip:
        shutil.copy(folder / "Loxo_Invoice_Sep.pdf", folder / "Loxo_Invoice_Sep (1).pdf")
    return folder


def matched(result: rc.ReconciliationResult) -> dict[str, list[str]]:
    return {m.transaction.id: [d.filename for d in m.documents] for m in result.matches}


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------

def test_parsing() -> list[rc.Document]:
    print("PDF parsing")
    loaded = rc.load_documents(build_docs(TMP / "docs"), OWN, 2026)
    docs, problems = loaded.documents, loaded.problems
    check(loaded.rejected == [], "no real invoice set aside")
    by_name = {d.filename: d for d in docs}
    check(len(docs) == 8, "8 documents parsed")
    check({p for p, _ in problems} == {"scan_0001.pdf", "Loxo_Invoice_Sep (1).pdf"},
          "scanned PDF and duplicate copy reported, original kept")
    check(by_name["INV-041_ClientA.pdf"].amount == Decimal("9500.00"), "EU amount 9.500,00 €")
    check(by_name["lemlist_Invoice_Sep.pdf"].amount == Decimal("99.00"), "total, not subtotal/VAT")
    check(by_name["Loxo_Invoice_Sep.pdf"].doc_date.isoformat() == "2026-09-01", "invoice date, not due date")
    check(by_name["CN-002_ClientC.pdf"].amount == Decimal("-1250.00"), "credit note is negative")
    check(by_name["INV-043_ClientB.pdf"].direction is rc.Direction.RECEIVABLE, "own invoice is receivable")
    check(by_name["Anthropic_Receipt_2026-09-03.pdf"].vendor == "Anthropic", "vendor from file name")
    return docs


def test_matching(docs: list[rc.Document]) -> None:
    print("Matching")
    r = rc.reconcile(rc.TRANSACTIONS, docs)
    m = matched(r)
    check(m["T3"] == ["Loxo_Invoice_Sep.pdf"], "12 Sep LOXO -> September invoice")
    check(m["T7"] == ["Loxo_Invoice_Oct.pdf"], "01 Oct LOXO -> October invoice")
    check(set(m["T8"]) == {"INV-044_ClientC.pdf", "CN-002_ClientC.pdf"}, "Client C netted")
    partial = next(x for x in r.matches if x.transaction.id == "T6")
    check(partial.match_type is rc.MatchType.PARTIAL and partial.outstanding == Decimal("4750.00"),
          "Client A 50% partial, 4,750 outstanding")
    check([md.transaction.id for md in r.missing_documents] == ["T5"], "only Amazon missing")
    used = [d.id for x in r.matches for d in x.documents]
    check(len(used) == len(set(used)), "no document used twice")

    print("Matching without the September Loxo invoice")
    no_sep = [d for d in docs if d.filename != "Loxo_Invoice_Sep.pdf"]
    r2 = rc.reconcile(rc.TRANSACTIONS, no_sep)
    check(matched(r2).get("T7") == ["Loxo_Invoice_Oct.pdf"], "October invoice stays with October")
    check("T3" in [md.transaction.id for md in r2.missing_documents], "12 Sep LOXO reported missing")


def test_vat(docs: list[rc.Document]) -> None:
    print("VAT rule (expenses over €100 without VAT)")
    by_name = {d.filename: d for d in docs}
    check(by_name["lemlist_Invoice_Sep.pdf"].vat_amount == Decimal("16.50"), "VAT line read (€16.50)")
    check(by_name["Loxo_Invoice_Sep.pdf"].vat_amount == Decimal("0"), "no VAT line -> VAT 0")
    flagged = {f.document.filename for f in rc.vat_check(docs)}
    check(flagged == {"Loxo_Invoice_Sep.pdf", "Loxo_Invoice_Oct.pdf"},
          "Loxo €180 flagged; lemlist/Anthropic under €100 and client invoices never flagged")
    check(rc.extract_vat(["VAT number: NL001234567B01", "Total incl. VAT €121.00"]) == (Decimal("0"), False),
          "VAT number and 'Total incl. VAT' are not a VAT amount")
    check(rc.extract_vat(["BTW 21%  € 21,00", "Totaal € 121,00"])[0] == Decimal("21.00"), "Dutch BTW line read")
    check(rc.extract_vat(["VAT 0%  €0.00", "Reverse charge applies"]) == (Decimal("0.00"), True),
          "reverse charge detected")
    check(rc.extract_vat(["Subtotal €100.00", "Total VAT €21.00", "Total €121.00"])[0] == Decimal("21.00"),
          "'Total VAT €21.00' is the VAT, not a total (was read as no VAT)")
    check(rc.extract_vat(["Tax (21%) €21.00", "Total €121.00"])[0] == Decimal("21.00"),
          "'Tax (21%)' line read (SaaS invoices)")
    check(rc.extract_vat(["VAT 21%  21.00", "Total  121.00 EUR"])[0] == Decimal("21.00"),
          "VAT amount without € sign read; the 21% is not the amount")
    exactly_100 = rc.Document("X", "x.pdf", "Shop", rc.DocType.INVOICE, rc.Direction.PAYABLE,
                              Decimal("100.00"), vat_amount=Decimal("0"))
    check(rc.vat_check([exactly_100]) == [], "exactly €100 is not over the threshold")
    unchecked = rc.Document("Y", "y.pdf", "Shop", rc.DocType.INVOICE, rc.Direction.PAYABLE, Decimal("500"))
    check(rc.vat_check([unchecked]) == [], "document whose VAT was never read is not flagged")



# Things that arrive by email but are not invoices. Each one names the same
# vendor and amount as a real invoice, so without the decision step it would
# be matched to the bank line (and forwarded) instead of the invoice.
NOT_INVOICES = {
    "Loxo_Payment_Failed.pdf": [
        "Loxo", "Your payment failed", "We couldn't charge your card for invoice LX-1043.",
        "Date: 1 Oct 2026", "Amount due  €180.00", "Update your payment method to keep access."],
    "Loxo_Invoice_Summary.pdf": [
        "Loxo Inc.", "Invoice Summary", "Invoice date: 1 Oct 2026", "LX-1001  Sep 2026  €180.00  paid",
        "LX-1043  Oct 2026  €180.00  open", "Total  €180.00"],
    "DKB_Zahlungserinnerung.pdf": [
        "DKB Deutsche Kreditbank AG", "Zahlungserinnerung", "Rechnung Nr. 4711 vom 01.10.2026",
        "Offener Betrag: 180,00 €"],
    "Welcome_to_Loxo.pdf": ["Loxo", "Welcome aboard!", "Getting started with your workspace"],
    "attachment.pdf": [            # looks like an invoice; the email subject says reminder
        "From: Loxo Inc.", "Invoice LX-1043", "Invoice date: 1 Oct 2026", "Total due  €180.00"],
}
REAL_WITH_TRAPS = {               # real invoices whose small print contains trap words
    "Figma_Invoice_Oct.pdf": [
        "From: Figma Inc.", "Invoice FG-2210", "Invoice date: 2 Oct 2026", "Bill to: Acme Studio BV",
        "Professional plan  €45.00", "Total due  €45.00",
        "Please quote the invoice number with your payment.",
        "If a payment fails we will send you a reminder by email."],
}


def test_classification() -> None:
    print("Invoice or not?")
    folder = TMP / "mixed"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    for name, lines in {**NOT_INVOICES, **REAL_WITH_TRAPS}.items():
        make_pdf(folder / name, lines)
    (folder / rc.GMAIL_INDEX).write_text(json.dumps(
        {"attachment.pdf": {"subject": "Reminder: invoice LX-1043 is overdue"}}))
    loaded = rc.load_documents(folder, OWN, 2026)
    kinds = {name: kind for name, kind, _ in loaded.rejected}
    check(kinds.get("Loxo_Payment_Failed.pdf") == "failed-payment notice", "failed-payment notice set aside")
    check(kinds.get("Loxo_Invoice_Summary.pdf") == "invoice summary / statement", "Loxo invoice summary set aside")
    check(kinds.get("DKB_Zahlungserinnerung.pdf") == "payment reminder", "DKB Zahlungserinnerung set aside")
    check(kinds.get("Welcome_to_Loxo.pdf") == "not an invoice", "PDF without invoice wording set aside")
    check(kinds.get("attachment.pdf") == "payment reminder", "email subject 'Reminder: ...' decides")
    check([d.filename for d in loaded.documents] == ["Figma_Invoice_Oct.pdf"],
          "real invoice mentioning 'quote' and 'reminder' in the small print is kept")


def test_bank_csv() -> None:
    print("Bank CSV import (DKB layout)")
    path = TMP / "dkb.csv"
    path.write_text(
        '"Girokonto";"DE12120300000000000000"\n""\n"Kontostand vom 09.11.2026:";"12.345,67 €"\n""\n'
        '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";'
        '"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)"\n'
        '"03.11.26";"03.11.26";"Gebucht";"Acme Studio BV";"LOXO INC";"Loxo Pro";"Ausgang";"";"-180,00"\n'
        '"04.11.26";"04.11.26";"Vorgemerkt";"Acme Studio BV";"AMZN MKTP";"";"Ausgang";"";"-12,00"\n'
        '"06.11.26";"06.11.26";"Gebucht";"Client A";"Acme Studio BV";"INV-041";"Eingang";"";"4.750,00"\n',
        encoding="utf-8")
    txns = rc.load_bank_csv(path)
    check([(t.date.isoformat(), t.amount, t.description) for t in txns] == [
        ("2026-11-03", Decimal("-180.00"), "LOXO INC"), ("2026-11-06", Decimal("4750.00"), "Client A")],
        "dates, EU amounts, payee/payer by direction; pending line skipped")
    ing = TMP / "ing.csv"
    ing.write_text('"Datum","Naam / Omschrijving","Rekening","Af Bij","Bedrag (EUR)"\n'
                   '"20261103","LOXO INC","NL00","Af","180,00"\n', encoding="utf-8")
    check(rc.load_bank_csv(ing)[0].amount == Decimal("-180.00"), "ING 'Af' column makes it an outflow")
    rev = TMP / "revolut.csv"
    rev.write_text(
        "Date started (UTC),Date completed (UTC),ID,Type,State,Description,Reference,Payer,Card number,"
        "Orig currency,Orig amount,Payment currency,Amount,Fee,Balance,Account\n"
        "2026-11-01 09:12:01,2026-11-02 10:00:00,a1,CARD_PAYMENT,COMPLETED,Loxo,,Praveen,4111,USD,"
        "-196.20,EUR,-180.00,0.00,1000.00,Main\n"
        "2026-11-01 09:10:00,,a2,CARD_PAYMENT,DECLINED,Loxo,,Praveen,4111,USD,-196.20,EUR,-180.00,"
        "0.00,1180.00,Main\n"
        "2026-11-04 08:00:00,2026-11-04 08:00:01,a3,TRANSFER,COMPLETED,Client A,INV-041,,,EUR,"
        "4750.00,EUR,4750.00,0.00,5930.00,Main\n", encoding="utf-8")
    check([(t.date.isoformat(), t.amount, t.description) for t in rc.load_bank_csv(rev)] == [
        ("2026-11-02", Decimal("-180.00"), "Loxo"), ("2026-11-04", Decimal("4750.00"), "Client A")],
        "Revolut Business export: completed date, EUR amount; declined card payment skipped")


def T(i, d, amount, text):
    return rc.Transaction(i, date.fromisoformat(d), Decimal(amount), text)


def eml_attachments(path: Path) -> list[str]:
    msg = email.message_from_bytes(path.read_bytes())
    return sorted(part.get_filename() for part in msg.walk() if part.get_filename())


def test_weekly_run() -> None:
    print("Weekly run: decide -> match -> forward, with ledger")
    folder = TMP / "week"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    for name in ["Anthropic_Receipt_2026-09-03.pdf", "Loxo_Invoice_Sep.pdf", "Loxo_Invoice_Oct.pdf"]:
        make_pdf(folder / name, SAMPLE_PDFS[name])
    for name in ["Loxo_Payment_Failed.pdf", "Loxo_Invoice_Summary.pdf", "DKB_Zahlungserinnerung.pdf"]:
        make_pdf(folder / name, NOT_INVOICES[name])
    loaded = rc.load_documents(folder, OWN, 2026)

    week1 = [T("B1", "2026-09-03", "-90.00", "ANTHROPIC"),
             T("B2", "2026-09-12", "-180.00", "LOXXO"),          # typo-ish bank text: fuzzy
             T("B3", "2026-10-01", "-180.00", "LOXO")]
    end1 = date(2026, 10, 4)

    run = rc.run_week(week1, loaded.documents, [], end1, loaded.rejected)
    fwd = sorted(d.filename for dec in run.forwarded for d in dec.documents)
    held = [d.filename for dec in run.with_action(rc.Action.HOLD) for d in dec.documents]
    check(fwd == ["Anthropic_Receipt_2026-09-03.pdf", "Loxo_Invoice_Oct.pdf"],
          "only real invoices matched to a bank line are forwarded")
    check(held == ["Loxo_Invoice_Sep.pdf"], "fuzzy bank name 'LOXXO' held for a check")
    check(len(run.rejected) == 3, "3 non-invoices set aside, none forwarded")

    run = rc.run_week(week1, loaded.documents, [], end1, loaded.rejected,
                      approved=["Loxo_Invoice_Sep.pdf"])
    check(len(run.forwarded) == 3 and not run.with_action(rc.Action.HOLD), "--approve forwards a held document")

    out = TMP / "out"
    written = rc.export_forward_email(run, out, rc.render_weekly_report(run), "Anna", "inbox@exact", "Praveen")
    check(eml_attachments(written["eml"]) == sorted(
        ["Anthropic_Receipt_2026-09-03.pdf", "Loxo_Invoice_Sep.pdf", "Loxo_Invoice_Oct.pdf"]),
        "email draft carries exactly the forwarded PDFs (no report, no notices)")
    subject, body = rc.build_forward_email(run, "Anna", "Praveen")
    check(subject.startswith("Invoices & receipts 2026-W40") and "3 attached" in subject, "subject line")
    check("Loxo_Payment_Failed" not in body and "Summary" not in body, "non-invoices not mentioned to the accountant")

    ledger = rc.record_week(run, [], today=end1)
    check(len(ledger) == 3, "3 documents recorded in the ledger")
    check(len(rc.record_week(rc.run_week(week1, loaded.documents, ledger, end1, approved=["Loxo_Invoice_Sep.pdf"]),
                             ledger)) == 3, "re-running the same week replaces it, no double entries")

    print("Next weeks: no double forwarding, precedents")
    week2 = week1 + [T("B4", "2026-11-02", "-180.00", "LOXXO")]
    run2 = rc.run_week(week2, loaded.documents, ledger, date(2026, 11, 8))
    check(run2.forwarded == [] and run2.already_forwarded == 3 and run2.already_settled == 3,
          "documents and bank lines from week 40 are not forwarded again")
    check(run2.n_documents == 0, "Gmail folder still holds them, but they are skipped")
    (txn, vendor), = run2.missing
    check(txn.id == "B4" and vendor.key == "LOXO" and vendor.method is rc.ResolutionMethod.ALIAS,
          "'LOXXO' now recognised as Loxo (learned from the approved week)")
    hint = run2.missing_hints["B4"]
    check("monthly" in hint and "same amount" in hint, f"precedent hint: {hint}")
    check(run2.expected == [], "Loxo not 'expected' - its payment is already listed as missing")

    run3 = rc.run_week(week1, loaded.documents, ledger, date(2026, 11, 15))
    check([(p.vendor, due.isoformat()) for p, due in run3.expected] == [("Loxo Inc.", "2026-10-31")],
          "monthly Loxo invoice due ~31 Oct, no invoice and no payment -> flagged as expected")

    print("PDFs from raw emails (--eml-dir)")
    from email.message import EmailMessage
    emls = TMP / "emls"
    emls.mkdir(exist_ok=True)
    m = EmailMessage()
    m["Subject"] = "Your payment failed"
    m.set_content("see attached")
    m.add_attachment((folder / "Loxo_Payment_Failed.pdf").read_bytes(), maintype="application",
                     subtype="pdf", filename="../notice.pdf")
    m.add_attachment(b"<html>not a pdf", maintype="application", subtype="pdf", filename="fake.pdf")
    (emls / "1.eml").write_bytes(m.as_bytes())
    (emls / "2.eml").write_bytes(m.as_bytes())
    dest = TMP / "from_eml"
    saved, skipped = rc.import_eml_pdfs(sorted(emls.glob("*.eml")), dest)
    check([p.name for p in saved] == ["notice.pdf"] and skipped == 1,
          "PDF saved under a safe name, fake PDF ignored, duplicate skipped")
    check([k for _, k, _ in rc.load_documents(dest, OWN, 2026).rejected] == ["failed-payment notice"],
          "email subject travels with it")

    print("Accountant's missing-documents request")
    req = TMP / "request.txt"
    req.write_text("# from the accountant, 2026-11-09\n"
                   "1 Oct 2026 | -180.00 | LOXO\n"           # already sent in week 40
                   "22 Sep 2026 | -45.99 | AMZN MKTP\n", encoding="utf-8")
    lines = rc.load_request(req, 2026)
    check([(t.date.isoformat(), t.amount) for t in lines] ==
          [("2026-10-01", Decimal("-180.00")), ("2026-09-22", Decimal("-45.99"))], "request lines read")
    run4 = rc.run_week(lines, loaded.documents, ledger, date(2026, 11, 9), loaded.rejected,
                       label="request-2026-11-09", resend=True)
    sent = [d.filename for dec in run4.forwarded for d in dec.documents]
    check(sent == ["Loxo_Invoice_Oct.pdf"], "a document sent before is sent again when asked for")
    check(any("already sent in 2026-W40" in n for n in run4.forwarded[0].notes), "...with a note when")
    check([t.description for t, _ in run4.missing] == ["AMZN MKTP"], "Amazon still open")
    subject, body = rc.build_forward_email(run4, "Anna", "Praveen")
    check(subject == "Missing documents: 1 of 2 found, 1 still open", f"subject: {subject}")
    check(len(rc.record_week(run4, ledger)) == len(ledger) + 1, "request answer recorded in the ledger")

    print("Without the decision step the failed-payment notice would steal the bank line")
    fake = rc.Document("N", "Loxo_Payment_Failed.pdf", "Loxo", rc.DocType.INVOICE, rc.Direction.PAYABLE,
                       Decimal("180.00"), date(2026, 10, 1))
    r = rc.reconcile([week1[2]], [fake])
    check(r.matches and r.matches[0].documents[0].filename == "Loxo_Payment_Failed.pdf",
          "(old behaviour: notice matched to the 01 Oct LOXO payment)")

def test_find_parser() -> None:
    print("--find parser")
    q = rc.parse_transaction_line("- 12 Sep | –€180.00 | LOXO", 2026)
    check((q.date.isoformat(), q.amount, q.description) == ("2026-09-12", Decimal("-180.00"), "LOXO"),
          "splits into date, amount, vendor")


def test_gmail(docs_folder: Path) -> None:
    print("Gmail download (fake service)")
    pdf = (docs_folder / "Loxo_Invoice_Oct.pdf").read_bytes()
    b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")   # noqa: E731
    messages = {
        "m1aaaaaaaa": {"payload": {"headers": [{"name": "Subject", "value": "Your Loxo invoice"}],
                                   "parts": [{"mimeType": "multipart/mixed", "filename": "", "parts": [
            {"filename": "Loxo_Invoice_Oct.pdf", "body": {"attachmentId": "A1"}}]}]}},
        "m2bbbbbbbb": {"payload": {"parts": [{"filename": "copy.pdf", "body": {"attachmentId": "A1"}}]}},
        "m3cccccccc": {"payload": {"parts": [{"filename": "..\\..\\evil:name?.pdf", "body": {"data": b64(pdf + b" ")}}]}},
        "m4dddddddd": {"payload": {"parts": [{"filename": "fake.pdf", "body": {"data": b64(b"<html>")}}]}},
    }
    queries = []

    class Req:
        def __init__(self, fn): self.execute = fn

    class Attachments:
        def get(self, userId, messageId, id): return Req(lambda: {"data": b64(pdf)})

    class Messages:
        def list(self, userId, q, maxResults):
            queries.append(q)
            return Req(lambda: {"messages": [{"id": i} for i in messages]})
        def list_next(self, request, response): return None
        def get(self, userId, id, format): return Req(lambda: messages[id])
        def attachments(self): return Attachments()

    class Service:
        def users(self):
            return type("Users", (), {"messages": lambda self: Messages()})()

    dest = TMP / "gmail"
    shutil.rmtree(dest, ignore_errors=True)
    since, until = rc.gmail_window(rc.TRANSACTIONS)
    saved, skipped = rc.download_gmail_pdfs(Service(), dest, since, until)
    check(queries[0] == "has:attachment filename:pdf after:2026/08/29 before:2026/10/11",
          "6-week query window")
    check(sorted(p.name for p in saved) == ["Loxo_Invoice_Oct.pdf", "evil_name_.pdf"],
          "PDFs saved with safe names, fake PDF ignored")
    check(skipped == 1, "same attachment twice saved once")
    index = json.loads((dest / rc.GMAIL_INDEX).read_text())
    check(index["Loxo_Invoice_Oct.pdf"]["subject"] == "Your Loxo invoice", "email subject kept for the decision step")
    check(rc.download_gmail_pdfs(Service(), dest, since, until)[0] == [], "re-run downloads nothing new")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        docs = test_parsing()
        test_matching(docs)
        test_vat(docs)
        test_classification()
        test_bank_csv()
        test_weekly_run()
        test_find_parser()
        test_gmail(TMP / "docs")
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    print(f"\nAll {passed} checks passed.")
