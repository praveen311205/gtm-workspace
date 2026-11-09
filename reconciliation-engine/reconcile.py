"""Weekly invoice run: real invoices/receipts -> bank line -> accountant.

Every week:
  1. Collect documents  - PDFs from a folder (optionally downloaded from Gmail).
  2. Decide             - is this a real invoice, receipt or credit note? Failed-
                          payment notices, payment reminders, invoice summaries,
                          statements, quotes and pro formas are set aside with a
                          reason and never forwarded or matched.
  3. Match              - each real document to a bank line (date, amount and
                          vendor must all agree; each document is used once):
                          exact -> netted (invoice + credit note) -> partial.
  4. Forward            - matched documents go into one email draft (PDFs
                          attached) with a short summary of what is included
                          and which bank payments still lack a document.
  5. Remember           - forwarded documents and the bank lines they settle are
                          written to a ledger, so nothing is forwarded twice and
                          past weeks become precedents: learned bank-text names,
                          the usual amount per vendor, and recurring invoices
                          that are due but have not shown up.
"""

from __future__ import annotations

import base64
import calendar
import csv
import dataclasses
import difflib
import hashlib
import json
import re
import statistics
import textwrap
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from email.message import EmailMessage
from enum import Enum
from itertools import combinations
from pathlib import Path


# --------------------------------------------------------------------------
# Data structures
# --------------------------------------------------------------------------

class DocType(Enum):
    RECEIPT = "receipt"
    INVOICE = "invoice"
    CREDIT_NOTE = "credit_note"


class Direction(Enum):
    PAYABLE = "payable"        # we pay a supplier -> money leaves the bank
    RECEIVABLE = "receivable"  # a client pays us  -> money enters the bank


@dataclass(frozen=True)
class Transaction:
    id: str
    date: date
    amount: Decimal            # signed: negative = outflow, positive = inflow
    description: str           # raw bank counterparty text


@dataclass(frozen=True)
class Document:
    id: str
    filename: str
    vendor: str                # counterparty name (supplier or client)
    doc_type: DocType
    direction: Direction
    amount: Decimal            # as printed on the document (credit notes negative)
    doc_date: date | None = None
    period: tuple[int, int] | None = None   # (year, month) when only the month is known
    vat_amount: Decimal | None = None       # VAT shown on the document; 0 = none shown, None = not checked
    reverse_charge: bool = False            # document says VAT is reverse-charged / "btw verlegd"
    source_path: Path | None = None         # the PDF, attached when the document is forwarded
    sha256: str | None = None               # content hash, identifies the file across weeks

    @property
    def expected_bank_amount(self) -> Decimal:
        """Signed amount we expect to see on the bank statement."""
        return -self.amount if self.direction is Direction.PAYABLE else self.amount

    @property
    def date_range(self) -> tuple[date, date] | None:
        """The day the document is dated, or the whole month for month-only documents."""
        if self.doc_date:
            return self.doc_date, self.doc_date
        if self.period:
            year, month = self.period
            return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])
        return None

    @property
    def date_label(self) -> str:
        if self.doc_date:
            return f"{self.doc_date:%d %b %Y}"
        if self.period:
            return f"{date(*self.period, 1):%b %Y}"
        return "no date"


class ResolutionMethod(Enum):
    EXACT = "exact"            # normalized name equals a known vendor
    ALIAS = "alias"            # bank descriptor found in the alias table
    FUZZY = "fuzzy"            # close string match to a known vendor
    UNRESOLVED = "unresolved"


@dataclass(frozen=True)
class VendorResolution:
    key: str                   # normalized vendor key used for comparisons
    name: str                  # display name
    method: ResolutionMethod


class MatchType(Enum):
    EXACT = "exact"
    NETTED = "netted"
    PARTIAL = "partial"


@dataclass(frozen=True)
class Match:
    transaction: Transaction
    documents: tuple[Document, ...]
    match_type: MatchType
    vendor: VendorResolution
    outstanding: Decimal = Decimal("0")   # signed amount still to be paid/received

    @property
    def document_total(self) -> Decimal:
        return sum((d.expected_bank_amount for d in self.documents), Decimal("0"))

    @property
    def date_confirmed(self) -> bool:
        """False when a document carries no date, so the period could not be checked."""
        return all(d.date_range is not None for d in self.documents)

    @property
    def is_certain(self) -> bool:
        """Exact amount on one dated document with an exactly-named vendor."""
        return (self.match_type is MatchType.EXACT
                and self.vendor.method is ResolutionMethod.EXACT
                and self.date_confirmed)


@dataclass(frozen=True)
class DocumentCheck:
    """How one document scores against a transaction's date, amount and vendor."""
    document: Document
    vendor_ok: bool
    amount_ok: bool
    date_ok: bool | None       # None: the document has no date to check
    date_gap: int | None       # days paid after (+) / before (-) the document date

    @property
    def is_match(self) -> bool:
        return self.vendor_ok and self.amount_ok and self.date_ok is not False

    def failures(self) -> list[str]:
        out = []
        if not self.vendor_ok:
            out.append("different vendor")
        if not self.amount_ok:
            out.append("amount differs")
        if self.date_ok is False:
            out.append(f"dated {self.document.date_label}, outside the payment window")
        elif self.date_ok is None:
            out.append("no date on document")
        return out


@dataclass(frozen=True)
class MissingDocument:
    transaction: Transaction
    vendor: VendorResolution
    candidates: tuple[DocumentCheck, ...]   # open docs for this vendor, and why they failed


@dataclass(frozen=True)
class VatFlag:
    """An expense document over the VAT threshold that shows no VAT."""
    document: Document
    reason: str


@dataclass
class ReconciliationResult:
    matches: list[Match] = field(default_factory=list)
    missing_documents: list[MissingDocument] = field(default_factory=list)
    unmatched_transactions: list[Transaction] = field(default_factory=list)
    unmatched_documents: list[Document] = field(default_factory=list)
    unreadable_documents: list[tuple[str, str]] = field(default_factory=list)  # (file, reason)
    vat_flags: list[VatFlag] = field(default_factory=list)


# --------------------------------------------------------------------------
# Input data
# --------------------------------------------------------------------------

TRANSACTIONS: list[Transaction] = [
    Transaction("T1", date(2026, 9, 3),  Decimal("-90.00"),    "ANTHROPIC"),
    Transaction("T2", date(2026, 9, 5),  Decimal("-99.00"),    "LEMLIST"),
    Transaction("T3", date(2026, 9, 12), Decimal("-180.00"),   "LOXO"),
    Transaction("T4", date(2026, 9, 15), Decimal("14000.00"),  "CLIENT B BV"),
    Transaction("T5", date(2026, 9, 22), Decimal("-45.99"),    "AMZN MKTP"),
    Transaction("T6", date(2026, 9, 30), Decimal("4750.00"),   "CLIENT A"),
    Transaction("T7", date(2026, 10, 1), Decimal("-180.00"),   "LOXO"),
    Transaction("T8", date(2026, 10, 3), Decimal("6250.00"),   "CLIENT C"),
]

# Used when no --docs-dir is given. Dates are only what the file names reveal;
# the client invoices carry none, so their matches are sent to review.
DOCUMENTS: list[Document] = [
    Document("D1", "Anthropic_Receipt_2026-09-03.pdf", "Anthropic", DocType.RECEIPT,
             Direction.PAYABLE, Decimal("90.00"), doc_date=date(2026, 9, 3)),
    Document("D2", "lemlist_Invoice_Sep.pdf", "lemlist", DocType.INVOICE,
             Direction.PAYABLE, Decimal("99.00"), period=(2026, 9)),
    Document("D3", "Loxo_Invoice_Sep.pdf", "Loxo", DocType.INVOICE,
             Direction.PAYABLE, Decimal("180.00"), period=(2026, 9)),
    Document("D4", "INV-041_ClientA.pdf", "Client A", DocType.INVOICE,
             Direction.RECEIVABLE, Decimal("9500.00")),
    Document("D5", "INV-043_ClientB.pdf", "Client B", DocType.INVOICE,
             Direction.RECEIVABLE, Decimal("14000.00")),
    Document("D6", "INV-044_ClientC.pdf", "Client C", DocType.INVOICE,
             Direction.RECEIVABLE, Decimal("7500.00")),
    Document("D7", "CN-002_ClientC.pdf", "Client C", DocType.CREDIT_NOTE,
             Direction.RECEIVABLE, Decimal("-1250.00")),
]


# --------------------------------------------------------------------------
# Vendor resolution
# --------------------------------------------------------------------------

# Legal-entity suffixes that banks often append but documents omit.
_LEGAL_SUFFIXES = {"BV", "NV", "LTD", "LIMITED", "LLC", "INC", "CORP", "CO", "PBC", "PLC",
                   "GMBH", "AG", "SA", "SAS", "SARL", "BVBA", "AB", "OY"}

# Bank descriptor prefixes (normalized) -> canonical vendor name.
# Longest prefix wins, so "AMZNMKTP" beats "AMZN".
VENDOR_ALIASES: dict[str, str] = {
    "AMZN": "Amazon",
    "AMZNMKTP": "Amazon",
    "AMAZONMKTP": "Amazon",
    "AWS": "Amazon Web Services",
    "GOOGLE": "Google",
    "MSFT": "Microsoft",
}

FUZZY_CUTOFF = 0.8   # difflib ratio needed to accept a fuzzy vendor match
MAX_NETTING_DOCS = 4  # largest document group tried when netting


def normalize_vendor(name: str) -> str:
    """Uppercase, drop punctuation and trailing legal suffixes, collapse spaces."""
    tokens = re.sub(r"[^A-Z0-9 ]", " ", name.upper()).split()
    while tokens and tokens[-1] in _LEGAL_SUFFIXES:
        tokens.pop()
    return "".join(tokens)


def resolve_vendor(raw: str, known_vendors: dict[str, str],
                   learned: dict[str, str] | None = None) -> VendorResolution:
    """Map a bank descriptor to a vendor key.

    known_vendors maps normalized key -> display name for every vendor that
    appears on a document (or in past weeks). learned maps a normalized bank
    text to the vendor it was matched to in an earlier week.
    """
    norm = normalize_vendor(raw)

    if norm in known_vendors:
        return VendorResolution(norm, known_vendors[norm], ResolutionMethod.EXACT)

    if learned and norm in learned:
        name = learned[norm]
        return VendorResolution(normalize_vendor(name), name, ResolutionMethod.ALIAS)

    for prefix in sorted(VENDOR_ALIASES, key=len, reverse=True):
        if norm.startswith(prefix):
            name = VENDOR_ALIASES[prefix]
            return VendorResolution(normalize_vendor(name), name, ResolutionMethod.ALIAS)

    close = difflib.get_close_matches(norm, known_vendors, n=1, cutoff=FUZZY_CUTOFF)
    if close:
        return VendorResolution(close[0], known_vendors[close[0]], ResolutionMethod.FUZZY)

    return VendorResolution(norm, raw, ResolutionMethod.UNRESOLVED)


# --------------------------------------------------------------------------
# Date window
# --------------------------------------------------------------------------

PAYMENT_LAG_DAYS = 45    # a payment may come up to this long after the document date
EARLY_PAYMENT_DAYS = 7   # ...or this long before it (card charged before the receipt is issued)


def date_gap(paid_on: date, doc: Document) -> int | None:
    """Days paid after (+) or before (-) the document's date; 0 inside a month-only period."""
    rng = doc.date_range
    if rng is None:
        return None
    lo, hi = rng
    if paid_on < lo:
        return -(lo - paid_on).days
    if paid_on > hi:
        return (paid_on - hi).days
    return 0


def date_fits(paid_on: date, doc: Document) -> bool | None:
    gap = date_gap(paid_on, doc)
    return None if gap is None else -EARLY_PAYMENT_DAYS <= gap <= PAYMENT_LAG_DAYS


def accepted_document_dates(paid_on: date) -> tuple[date, date]:
    return paid_on - timedelta(days=PAYMENT_LAG_DAYS), paid_on + timedelta(days=EARLY_PAYMENT_DAYS)


def check_document(txn: Transaction, vendor: VendorResolution, doc: Document) -> DocumentCheck:
    return DocumentCheck(
        document=doc,
        vendor_ok=normalize_vendor(doc.vendor) == vendor.key,
        amount_ok=doc.expected_bank_amount == txn.amount,
        date_ok=date_fits(txn.date, doc),
        date_gap=date_gap(txn.date, doc),
    )


def by_date_closeness(paid_on: date, docs: list[Document]) -> list[Document]:
    """Closest-dated first; undated documents last."""
    def key(d: Document) -> tuple[bool, int]:
        gap = date_gap(paid_on, d)
        return gap is None, abs(gap or 0)
    return sorted(docs, key=key)


# --------------------------------------------------------------------------
# Matching
# --------------------------------------------------------------------------

def reconcile(transactions: list[Transaction], documents: list[Document],
              learned_aliases: dict[str, str] | None = None,
              past_vendors: dict[str, str] | None = None) -> ReconciliationResult:
    """learned_aliases / past_vendors come from the ledger (see precedents)."""
    known_vendors = dict(past_vendors or {})
    known_vendors.update({normalize_vendor(d.vendor): d.vendor for d in documents})
    vendor_of = {t.id: resolve_vendor(t.description, known_vendors, learned_aliases)
                 for t in transactions}

    result = ReconciliationResult()
    open_docs = list(documents)
    open_txns = sorted(transactions, key=lambda t: t.date)

    def vendor_docs(txn: Transaction) -> list[Document]:
        key = vendor_of[txn.id].key
        return [d for d in open_docs if normalize_vendor(d.vendor) == key]

    def docs_for(txn: Transaction) -> list[Document]:
        """Open same-vendor documents inside the payment window, closest date first."""
        return by_date_closeness(txn.date, [d for d in vendor_docs(txn)
                                            if date_fits(txn.date, d) is not False])

    def record(match: Match) -> None:
        result.matches.append(match)
        open_txns.remove(match.transaction)
        for d in match.documents:
            open_docs.remove(d)

    # Pass 1: exact 1:1. Each document is used at most once, so a recurring
    # charge only consumes one invoice - the one closest in date.
    for txn in list(open_txns):
        doc = next((d for d in docs_for(txn) if d.expected_bank_amount == txn.amount), None)
        if doc:
            record(Match(txn, (doc,), MatchType.EXACT, vendor_of[txn.id]))

    # Pass 2: netting. Smallest group of same-vendor documents (e.g. invoice
    # + credit note) whose signed total equals the transaction.
    for txn in list(open_txns):
        candidates = docs_for(txn)
        group = next(
            (
                combo
                for size in range(2, min(len(candidates), MAX_NETTING_DOCS) + 1)
                for combo in combinations(candidates, size)
                if sum(d.expected_bank_amount for d in combo) == txn.amount
            ),
            None,
        )
        if group:
            invoices_first = tuple(sorted(group, key=lambda d: d.doc_type is DocType.CREDIT_NOTE))
            record(Match(txn, invoices_first, MatchType.NETTED, vendor_of[txn.id]))

    # Pass 3: partial payment. Same direction as an open invoice/receipt for
    # the same vendor, but smaller than it; the remainder is outstanding.
    for txn in list(open_txns):
        doc = next(
            (
                d for d in docs_for(txn)
                if d.doc_type is not DocType.CREDIT_NOTE
                and (d.expected_bank_amount > 0) == (txn.amount > 0)
                and abs(txn.amount) < abs(d.expected_bank_amount)
            ),
            None,
        )
        if doc:
            record(Match(txn, (doc,), MatchType.PARTIAL, vendor_of[txn.id],
                         doc.expected_bank_amount - txn.amount))

    # Pass 4: transactions with an identifiable vendor but no matching
    # document. List open docs for that vendor and why each one failed.
    for txn in open_txns:
        vendor = vendor_of[txn.id]
        if vendor.method is ResolutionMethod.UNRESOLVED:
            result.unmatched_transactions.append(txn)
        else:
            checks = tuple(check_document(txn, vendor, d)
                           for d in by_date_closeness(txn.date, vendor_docs(txn)))
            result.missing_documents.append(MissingDocument(txn, vendor, checks))

    result.unmatched_documents = open_docs
    result.vat_flags = vat_check(documents)
    return result


# --------------------------------------------------------------------------
# VAT rule
# --------------------------------------------------------------------------

VAT_CHECK_THRESHOLD = Decimal("100.00")   # expenses strictly above this must show VAT


def vat_check(documents: Sequence[Document]) -> list[VatFlag]:
    """Expense invoices/receipts over VAT_CHECK_THRESHOLD that show no VAT.

    Only documents whose VAT was actually read are judged: vat_amount None
    (e.g. the built-in sample list, which has no document contents) is skipped.
    Client invoices (money in) and credit notes are never flagged.
    """
    flags = []
    for d in documents:
        if (d.direction is Direction.PAYABLE
                and d.doc_type is not DocType.CREDIT_NOTE
                and abs(d.amount) > VAT_CHECK_THRESHOLD
                and d.vat_amount is not None
                and d.vat_amount == 0):
            reason = ("VAT reverse-charged - confirm the supplier's VAT number is on the invoice"
                      if d.reverse_charge else
                      "no VAT shown - request an invoice with VAT and the supplier's VAT number")
            flags.append(VatFlag(d, reason))
    return sorted(flags, key=lambda f: (f.document.date_range or (date.max,))[0])


# --------------------------------------------------------------------------
# Parsing amounts and dates (shared by PDF parsing and --find)
# --------------------------------------------------------------------------

_MONTH_RE = (r"(?P<mon>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|"
             r"aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)")
_DATE_PATTERNS = [
    re.compile(r"\b(?P<y>\d{4})-(?P<m>\d{1,2})-(?P<d>\d{1,2})\b"),
    re.compile(rf"\b(?P<d>\d{{1,2}})(?:st|nd|rd|th)?[ \-]+{_MONTH_RE}\.?,?(?:[ \-]+(?P<y>\d{{4}}))?\b", re.I),
    re.compile(rf"\b{_MONTH_RE}\.?[ ]+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?,?[ ]+(?P<y>\d{{4}})\b", re.I),
    re.compile(r"\b(?P<d>\d{1,2})[./](?P<m>\d{1,2})[./](?P<y>\d{4})\b"),   # European D/M/Y
]

_NUM = r"\d{1,3}(?:[.,  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?"
_MONEY_RE = re.compile(
    rf"(?<![\w.,])(?P<sign>[-–—−]\s*)?(?P<cur1>€|EUR\b)?\s*(?P<sign2>[-–—−]\s*)?"
    rf"(?P<num>{_NUM})(?![\d])\s*(?P<cur2>€|EUR\b)?",
    re.I,
)


def month_number(name: str) -> int:
    return [m.lower() for m in calendar.month_abbr].index(name[:3].lower())


def find_dates(text: str, default_year: int | None = None) -> list[date]:
    """All dates in text, in reading order. A missing year falls back to default_year."""
    found: list[tuple[int, date]] = []
    for pattern in _DATE_PATTERNS:
        for m in pattern.finditer(text):
            g = m.groupdict()
            year = int(g["y"]) if g.get("y") else default_year
            month = month_number(g["mon"]) if g.get("mon") else int(g["m"])
            if year is None:
                continue
            try:
                found.append((m.start(), date(year, month, int(g["d"]))))
            except ValueError:
                pass
    return [d for _, d in sorted(found, key=lambda f: f[0])]


def _to_decimal(num: str) -> Decimal:
    s = re.sub(r"[  ]", "", num)
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", s):              # 1.250 (EU thousands)
        s = s.replace(".", "")
    elif re.search(r",\d{1,2}$", s):                         # 1.250,00 (EU decimals)
        s = s.replace(".", "").replace(",", ".")
    else:                                                     # 1,250.00
        s = s.replace(",", "")
    return Decimal(s).quantize(Decimal("0.01"))


def find_amounts(text: str, require_currency: bool = True) -> list[Decimal]:
    out = []
    for m in _MONEY_RE.finditer(text):
        if require_currency and not (m["cur1"] or m["cur2"]):
            continue
        value = _to_decimal(m["num"])
        out.append(-value if (m["sign"] or m["sign2"]) else value)
    return out


def parse_transaction_line(text: str, default_year: int, txn_id: str = "Q") -> Transaction:
    """Split a statement line such as '12 Sep | –€180.00 | LOXO' into date, amount and vendor."""
    parts = [p.strip() for p in re.sub(r"^\s*[-•*]\s+", "", text).split("|")]
    if len(parts) != 3:
        raise ValueError(f"expected 'date | amount | vendor', got {text!r}")
    dates = find_dates(parts[0], default_year)
    amounts = find_amounts(parts[1], require_currency=False)
    if not dates:
        raise ValueError(f"could not read a date from {parts[0]!r}")
    if not amounts:
        raise ValueError(f"could not read an amount from {parts[1]!r}")
    return Transaction(txn_id, dates[0], amounts[0], parts[2])


# --------------------------------------------------------------------------
# Local PDF parsing
# --------------------------------------------------------------------------

_AMOUNT_LABELS = ["total due", "amount due", "balance due", "grand total", "total amount",
                  "amount paid", "total paid", "total"]
_DATE_LABELS = ["invoice date", "receipt date", "credit note date", "date of issue",
                "issue date", "date issued", "date paid", "payment date", "date"]
_ISSUER_LABELS = ["from", "issued by", "billed by", "vendor", "seller", "supplier"]
_CUSTOMER_LABELS = ["bill to", "billed to", "invoice to", "sold to", "customer", "client"]


class DocumentParseError(Exception):
    pass


def extract_pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        raise SystemExit("PDF parsing needs pypdf:  python -m pip install pypdf") from None
    reader = PdfReader(path)
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def split_camel(name: str) -> str:
    """'ClientA' -> 'Client A'; 'lemlist' stays as is."""
    return re.sub(r"(?<=[a-z])(?=[A-Z0-9])", " ", name).replace("_", " ").strip()


def labeled_value(lines: list[str], labels: list[str]) -> str | None:
    """Value after 'Label:' on the same line, or on the next line if empty."""
    for label in labels:
        for i, line in enumerate(lines):
            m = re.match(rf"\s*{re.escape(label)}\s*:\s*(.*)$", line, re.I)
            if m:
                value = m.group(1).strip() or next((l.strip() for l in lines[i + 1:] if l.strip()), "")
                if value:
                    return value
    return None


def extract_amount(lines: list[str]) -> Decimal | None:
    """The total from the highest-priority labelled line, else the largest € amount."""
    for label in _AMOUNT_LABELS:
        hits = [l for l in lines if label in l.lower()
                and not re.search(r"sub\s*-?\s*total|\bvat\b|\btax\b", l, re.I)]
        for line in reversed(hits):                      # the grand total is usually last
            amounts = find_amounts(line) or find_amounts(line, require_currency=False)
            if amounts:
                return amounts[-1]
    everything = find_amounts("\n".join(lines))
    return max(everything, key=abs) if everything else None


_VAT_LINE_RE = re.compile(r"\b(vat|btw|tva|mwst|ust|iva|tax)\b", re.I)
_VAT_ID_RE = re.compile(r"\b(vat|btw|tva|ust|tax)[\s.\-]*(?:id|no|nr|number|nummer|reg)", re.I)
_VAT_INCL_RE = re.compile(r"\bincl|\bexcl|including|excluding|\binkl|\bzzgl", re.I)
_TOTAL_RE = re.compile(r"total|totaal|gesamt|summe", re.I)
_VAT_TOTAL_RE = re.compile(r"(?:total|totaal|gesamt)\s*(?:vat|btw|tax|mwst|ust)"
                           r"|(?:vat|btw|tax|mwst|ust)\.?\s*(?:total|totaal|gesamt|betrag|bedrag)", re.I)
_PERCENT_RE = re.compile(r"\d+(?:[.,]\d+)?\s*%")
_REVERSE_CHARGE_RE = re.compile(
    r"reverse[\s\-]*charge|btw\s+verlegd|autoliquidation|steuerschuldnerschaft", re.I)


def _vat_line_amount(line: str) -> Decimal | None:
    """Last money amount on a VAT line: with a currency sign, else a plain 21.00 / 21,00."""
    amounts = find_amounts(line)
    if amounts:
        return abs(amounts[-1])
    plain = [m for m in _MONEY_RE.finditer(_PERCENT_RE.sub(" ", line))
             if re.search(r"[.,]\d{2}$", m["num"])]
    return _to_decimal(plain[-1]["num"]) if plain else None


def extract_vat(lines: list[str]) -> tuple[Decimal, bool]:
    """(VAT amount shown, reverse charge mentioned). No VAT line at all -> 0.

    Lines that only carry a VAT/BTW registration number are ignored, and
    percentages are not amounts, so 'VAT 21%' alone or 'VAT number NL..' is
    not VAT. 'Total incl. VAT' is the grand total, but 'Total VAT' is the VAT.
    """
    reverse = any(_REVERSE_CHARGE_RE.search(l) for l in lines)
    vat = Decimal("0")
    for line in lines:
        if not _VAT_LINE_RE.search(line):
            continue
        if _VAT_ID_RE.search(line) and not find_amounts(line):
            continue
        if _VAT_INCL_RE.search(line):
            continue                                  # "Total incl. VAT €121" is not the VAT
        if _TOTAL_RE.search(line) and not _VAT_TOTAL_RE.search(line):
            continue
        amount = _vat_line_amount(line)
        if amount is not None:
            vat = amount
    return vat, reverse


def extract_date(lines: list[str], default_year: int) -> date | None:
    usable = [l for l in lines if not re.search(r"\bdue\b", l, re.I)]   # skip due dates
    for label in _DATE_LABELS:
        for i, line in enumerate(usable):
            if re.match(rf"\s*{re.escape(label)}\b", line, re.I):
                dates = find_dates(line, default_year) or find_dates(
                    "\n".join(usable[i + 1:i + 2]), default_year)
                if dates:
                    return dates[0]
    dates = find_dates("\n".join(usable))   # unlabelled: needs an explicit year
    return dates[0] if dates else None


def date_from_filename(stem: str, default_year: int) -> tuple[date | None, tuple[int, int] | None]:
    """'Receipt_2026-09-03' -> exact date; 'Invoice_Sep' -> (year, 9) month period."""
    dates = find_dates(stem.replace("_", " "))
    if dates:
        return dates[0], None
    for token in re.split(r"[_\-\s.]+", stem):
        if re.fullmatch(_MONTH_RE, token, re.I):
            year = next((int(y) for y in re.findall(r"(?<!\d)(20\d{2})(?!\d)", stem)), default_year)
            return None, (year, month_number(token))
    return None, None


# --------------------------------------------------------------------------
# Is it a real invoice / receipt?
# --------------------------------------------------------------------------
# Only invoices, receipts and credit notes are bookable. Everything else that
# arrives as a PDF - failed-payment notices, payment reminders, "invoice
# summaries", statements, quotes - is set aside before matching, because it
# often carries the same vendor and amount as the real invoice and would
# otherwise be matched (or forwarded) in its place.

HEADING_LINES = 12      # titles are looked for in the first lines of the PDF...
HEADING_MAX_WORDS = 7   # ...that are short enough to be a title, not a sentence of small print


@dataclass(frozen=True)
class RejectRule:
    kind: str           # short label shown in the report
    where: str          # "heading" (file name, email subject, first lines) or "anywhere"
    pattern: re.Pattern
    reason: str


REJECT_RULES: list[RejectRule] = [
    RejectRule("failed-payment notice", "heading", re.compile(
        r"payment (?:has |had )?failed|failed payment|payment (?:was |has been )?(?:declined|unsuccessful)"
        r"|unsuccessful payment|card (?:was |has been )?declined|could ?n[o']t (?:be )?(?:charged?|process)"
        r"|update your (?:payment|billing|card)|betaling (?:is )?mislukt|mislukte betaling"
        r"|zahlung (?:ist )?fehlgeschlagen|lastschrift(?:rückgabe| zurück)", re.I),
        "the payment did not go through - there is no invoice to book"),
    RejectRule("payment reminder", "heading", re.compile(
        r"\breminder\b|herinnering|aanmaning|zahlungserinnerung|\berinnerung\b|\bmahnung\b"
        r"|overdue notice|past[- ]due|dunning|rappel", re.I),
        "a reminder about an invoice - the invoice itself is what gets booked"),
    RejectRule("invoice summary / statement", "heading", re.compile(
        r"invoice summary|billing summary|summary of (?:your )?(?:invoices|charges|payments)"
        r"|account summary|\bstatement\b|kontoauszug|kreditkartenabrechnung|rechnungsübersicht"
        r"|\bübersicht\b|overzicht|upcoming invoice|next invoice|invoice preview", re.I),
        "an overview of charges, not an invoice itself"),
    RejectRule("quote / pro forma", "heading", re.compile(
        r"\bquot(?:e|ation)\b|offerte|\bangebot\b|order confirmation|bestelbevestiging"
        r"|auftragsbestätigung", re.I),
        "a quote or order confirmation, not a final invoice"),
    RejectRule("quote / pro forma", "anywhere", re.compile(
        r"pro[- ]?forma|this is not (?:a|an) (?:tax |vat )?invoice|dit is geen factuur"
        r"|(?:dies ist )?keine rechnung", re.I),
        "the document says it is not a final invoice"),
]

# At least one of these must appear for a document to count as bookable.
_BOOKABLE_RE = re.compile(
    r"\b(?:invoice|receipt|credit\s*(?:note|memo)|factuur|kwitantie|creditnota|creditfactuur"
    r"|rechnung|quittung|gutschrift|facture|reçu|fattura|ricevuta|factura|recibo)\b"
    r"|\b(?:inv|cn)[-_ ]?\d", re.I)


class NotAnInvoice(Exception):
    def __init__(self, kind: str, reason: str):
        super().__init__(reason)
        self.kind = kind
        self.reason = reason


def classify(stem: str, subject: str, lines: Sequence[str]) -> None:
    """Raise NotAnInvoice unless the PDF looks like an invoice, receipt or credit note.

    stem is the file name without extension, subject the email subject it came
    with (if known), lines the PDF text.
    """
    titles = [l for l in lines[:HEADING_LINES] if len(l.split()) <= HEADING_MAX_WORDS]
    heading = "\n".join([stem.replace("_", " "), subject, *titles])
    everything = "\n".join([stem, subject, *lines])
    for rule in REJECT_RULES:
        if rule.pattern.search(heading if rule.where == "heading" else everything):
            raise NotAnInvoice(rule.kind, rule.reason)
    if not _BOOKABLE_RE.search(everything):
        raise NotAnInvoice("not an invoice",
                           "no invoice, receipt or credit note wording found")


def parse_pdf(path: Path, own_names: Sequence[str], default_year: int,
              subject: str = "") -> Document:
    """Raises NotAnInvoice for notices/reminders/summaries, DocumentParseError if unreadable."""
    text = extract_pdf_text(path)
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        raise DocumentParseError("no text layer (scanned image?) - enter it manually")
    stem = path.stem
    classify(stem, subject, lines)

    hay = f"{stem}\n{text[:1000]}".lower()
    if re.search(r"credit\s*(?:note|memo)", hay) or re.match(r"cn[-_ ]?\d", stem, re.I):
        doc_type = DocType.CREDIT_NOTE
    elif "receipt" in hay:
        doc_type = DocType.RECEIPT
    else:
        doc_type = DocType.INVOICE

    amount = extract_amount(lines)
    if amount is None:
        raise DocumentParseError("no total amount found")
    amount = -abs(amount) if doc_type is DocType.CREDIT_NOTE else abs(amount)

    doc_date, period = extract_date(lines, default_year), None
    if doc_date is None:
        doc_date, period = date_from_filename(stem, default_year)

    # Who is the counterparty, and do we pay them or do they pay us?
    own = {normalize_vendor(n) for n in own_names}
    is_own = lambda name: bool(name) and normalize_vendor(name) in own   # noqa: E731
    issuer = labeled_value(lines, _ISSUER_LABELS)
    customer = labeled_value(lines, _CUSTOMER_LABELS)
    sales_name = re.match(r"(?:inv|cn)[-_ ]?\d+[-_ ]+(.+)", stem, re.I)       # INV-041_ClientA
    purchase_name = re.match(r"(.+?)[-_ ]+(?:invoice|receipt|bill|credit[-_ ]?note)(?![a-z])", stem, re.I)

    # Our own name on the document decides; otherwise our INV-/CN- numbering does.
    if is_own(issuer):
        receivable = True
    elif is_own(customer):
        receivable = False
    else:
        receivable = bool(sales_name)

    if receivable:
        direction = Direction.RECEIVABLE
        vendor = (customer if customer and not is_own(customer) else None) or \
                 (split_camel(sales_name.group(1)) if sales_name else None)
    else:
        direction = Direction.PAYABLE
        vendor = (issuer if issuer and not is_own(issuer) else None) or \
                 (split_camel(purchase_name.group(1)) if purchase_name else None) or lines[0].strip()
    if not vendor:
        raise DocumentParseError("could not tell who the counterparty is")

    vat_amount, reverse_charge = extract_vat(lines)
    return Document(stem, path.name, vendor, doc_type, direction, amount, doc_date, period,
                    vat_amount, reverse_charge)


@dataclass
class LoadedDocuments:
    documents: list[Document] = field(default_factory=list)
    problems: list[tuple[str, str]] = field(default_factory=list)          # (file, reason)
    rejected: list[tuple[str, str, str]] = field(default_factory=list)     # (file, kind, reason)


GMAIL_INDEX = "_gmail_index.json"   # file name -> email subject/sender, written by --gmail


def load_documents(folder: Path, own_names: Sequence[str], default_year: int) -> LoadedDocuments:
    """Parse every PDF in folder into documents, unreadable files, and non-invoices."""
    out = LoadedDocuments()
    seen_hash: dict[str, str] = {}
    seen_fields: dict[tuple, str] = {}
    index = _read_json(folder / GMAIL_INDEX, {})

    # Shortest names first, so "Invoice.pdf" is kept over its copy "Invoice (1).pdf".
    pdfs = sorted((p for p in folder.iterdir() if p.suffix.lower() == ".pdf"),
                  key=lambda p: (len(p.name), p.name))
    for path in pdfs:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest in seen_hash:
            out.problems.append((path.name, f"identical copy of {seen_hash[digest]} - skipped"))
            continue
        seen_hash[digest] = path.name
        subject = str((index.get(path.name) or {}).get("subject", ""))
        try:
            doc = parse_pdf(path, own_names, default_year, subject)
        except NotAnInvoice as e:
            out.rejected.append((path.name, e.kind, e.reason))
            continue
        except DocumentParseError as e:
            out.problems.append((path.name, str(e)))
            continue
        except Exception as e:   # corrupt / encrypted PDFs
            out.problems.append((path.name, f"could not be read ({type(e).__name__})"))
            continue
        doc = dataclasses.replace(doc, source_path=path, sha256=digest)

        # Same vendor, amount, date and type as an earlier file: likely the same
        # invoice saved twice (e.g. emailed again) - keep it out of matching.
        fields = (normalize_vendor(doc.vendor), doc.amount, doc.date_range, doc.doc_type)
        if doc.date_range and fields in seen_fields:
            out.problems.append((path.name, f"same vendor, amount and date as {seen_fields[fields]} "
                                            f"- possible duplicate, left out of matching"))
            continue
        seen_fields[fields] = path.name
        out.documents.append(doc)
    return out


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as e:
        raise SystemExit(f"could not read {path}: {e}") from None


# --------------------------------------------------------------------------
# Gmail ingestion (read-only: this script never sends email)
# --------------------------------------------------------------------------

GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
GMAIL_WINDOW_WEEKS = 6
GMAIL_GRACE_DAYS = 7     # receipts often arrive a few days after the last payment


def gmail_window(transactions: Sequence[Transaction]) -> tuple[date, date]:
    """6 weeks ending a week after the last transaction on the statement."""
    until = max(t.date for t in transactions) + timedelta(days=GMAIL_GRACE_DAYS)
    return until - timedelta(weeks=GMAIL_WINDOW_WEEKS), until


def gmail_query(since: date, until: date) -> str:
    # Gmail's before: is exclusive, so add a day to include `until`.
    return (f"has:attachment filename:pdf after:{since:%Y/%m/%d} "
            f"before:{until + timedelta(days=1):%Y/%m/%d}")


def connect_gmail(credentials_file: Path, token_file: Path):
    """OAuth sign-in (browser on first run), cached in token_file afterwards."""
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError:
        raise SystemExit("Gmail needs: python -m pip install google-api-python-client "
                         "google-auth-oauthlib") from None

    creds = None
    if token_file.exists():
        creds = Credentials.from_authorized_user_file(str(token_file), GMAIL_SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not credentials_file.is_file():
                raise SystemExit(
                    f"Gmail OAuth client file not found: {credentials_file}\n"
                    "Create a Desktop OAuth client in Google Cloud Console (Gmail API enabled), "
                    "download its JSON and pass it with --gmail-credentials.")
            flow = InstalledAppFlow.from_client_secrets_file(str(credentials_file), GMAIL_SCOPES)
            creds = flow.run_local_server(port=0)
        token_file.write_text(creds.to_json(), encoding="utf-8")
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _pdf_parts(part: dict) -> Iterator[dict]:
    if part.get("filename", "").lower().endswith(".pdf"):
        yield part
    for sub in part.get("parts") or []:
        yield from _pdf_parts(sub)


def safe_filename(name: str) -> str:
    """Attachment names come from strangers: no paths, no odd characters."""
    name = Path(name.replace("\\", "/")).name
    name = re.sub(r"[^\w.\- ]", "_", name).strip(" .") or "attachment"
    return name if name.lower().endswith(".pdf") else f"{name}.pdf"


def download_gmail_pdfs(service, dest: Path, since: date, until: date) -> tuple[list[Path], int]:
    """Save PDF attachments from the window into dest. Returns (new files, duplicates skipped).

    Files are de-duplicated by content, so an invoice emailed twice (or a re-run)
    never produces a second document to match.
    """
    dest.mkdir(parents=True, exist_ok=True)
    known = {hashlib.sha256(p.read_bytes()).hexdigest()
             for p in dest.iterdir() if p.suffix.lower() == ".pdf"}
    saved: list[Path] = []
    skipped = 0
    messages = service.users().messages()
    index_file = dest / GMAIL_INDEX
    index: dict[str, dict] = _read_json(index_file, {})

    request = messages.list(userId="me", q=gmail_query(since, until), maxResults=100)
    while request is not None:
        response = request.execute()
        for ref in response.get("messages", []):
            msg = messages.get(userId="me", id=ref["id"], format="full").execute()
            headers = {h.get("name", "").lower(): h.get("value", "")
                       for h in msg.get("payload", {}).get("headers", [])}
            for part in _pdf_parts(msg.get("payload", {})):
                body = part.get("body", {})
                data = body.get("data")
                if "attachmentId" in body:
                    data = messages.attachments().get(
                        userId="me", messageId=ref["id"], id=body["attachmentId"]).execute()["data"]
                if not data:
                    continue
                content = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
                if not content.startswith(b"%PDF"):
                    continue
                digest = hashlib.sha256(content).hexdigest()
                if digest in known:
                    skipped += 1
                    continue
                known.add(digest)
                path = dest / safe_filename(part["filename"])
                if path.exists():
                    path = path.with_name(f"{path.stem}_{ref['id'][:8]}{path.suffix}")
                path.write_bytes(content)
                saved.append(path)
                # The subject ("Your payment failed", "Invoice summary") helps decide
                # whether the attachment is a real invoice.
                index[path.name] = {"subject": headers.get("subject", "")[:300],
                                    "from": headers.get("from", "")[:200]}
        request = messages.list_next(request, response)
    if saved:
        index_file.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    return saved, skipped


def import_eml_pdfs(eml_files: Sequence[Path], dest: Path) -> tuple[list[Path], int]:
    """Save PDF attachments of raw emails (.eml, e.g. fetched through a Gmail connector).

    Same rules as the Gmail download: safe file names, real PDFs only, content
    de-duplication, and the email subject kept for the invoice-or-not decision.
    """
    import email
    from email import policy
    dest.mkdir(parents=True, exist_ok=True)
    known = {hashlib.sha256(p.read_bytes()).hexdigest()
             for p in dest.iterdir() if p.suffix.lower() == ".pdf"}
    index_file = dest / GMAIL_INDEX
    index: dict[str, dict] = _read_json(index_file, {})
    saved, skipped = [], 0
    for eml in eml_files:
        msg = email.message_from_bytes(eml.read_bytes(), policy=policy.default)
        for part in msg.walk():
            name = part.get_filename() or ""
            if not name.lower().endswith(".pdf"):
                continue
            content = part.get_payload(decode=True) or b""
            if not content.startswith(b"%PDF"):
                continue
            digest = hashlib.sha256(content).hexdigest()
            if digest in known:
                skipped += 1
                continue
            known.add(digest)
            path = dest / safe_filename(name)
            if path.exists():
                path = path.with_name(f"{path.stem}_{digest[:8]}{path.suffix}")
            path.write_bytes(content)
            saved.append(path)
            index[path.name] = {"subject": str(msg.get("subject", ""))[:300],
                                "from": str(msg.get("from", ""))[:200]}
    if saved:
        index_file.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    return saved, skipped


# --------------------------------------------------------------------------
# Bank statement import (CSV)
# --------------------------------------------------------------------------
# Column names seen in Revolut (Business), DKB, ING, Rabobank, bunq and generic exports. The
# header row is found automatically (DKB puts account details above it).

_CSV_COLUMNS: dict[str, list[str]] = {
    "date":   ["date completed (utc)", "completed date", "date started (utc)", "started date",
               "buchungsdatum", "buchungstag", "booking date", "transaction date", "date",
               "datum", "boekingsdatum", "rentedatum", "wertstellung", "valutadatum"],
    "amount": ["betrag (€)", "betrag (eur)", "betrag", "amount (eur)", "amount", "bedrag (eur)",
               "bedrag"],
    "payee":  ["zahlungsempfänger*in", "zahlungsempfänger", "empfänger",
               "auftraggeber / begünstigter", "begünstigter / auftraggeber",
               "naam / omschrijving", "naam tegenpartij", "tegenpartij", "counterparty",
               "payee", "name", "naam"],
    "payer":  ["zahlungspflichtige*r", "zahlungspflichtiger", "auftraggeber"],
    "text":   ["verwendungszweck", "omschrijving", "description", "beschreibung", "mededelingen",
               "details", "reference", "omschrijving-1"],
    "sign":   ["af bij", "debit/credit", "soll/haben"],
    "status": ["status", "state"],
}
_DEBIT_MARKS = {"af", "debit", "d", "soll", "s"}
# Not (or not yet) money that moved: pending, and Revolut's declined/reverted/failed card payments.
_PENDING_MARKS = {"vorgemerkt", "pending", "gepland", "declined", "reverted", "failed", "cancelled"}


def _column(cells: list[str], kind: str) -> int | None:
    for name in _CSV_COLUMNS[kind]:
        if name in cells:
            return cells.index(name)
    return None


def _bank_date(text: str) -> date:
    from datetime import datetime
    text = text.strip()[:10]                 # Revolut: "2026-11-03 14:02:11" -> the date
    for fmt in ("%d.%m.%Y", "%d.%m.%y", "%Y-%m-%d", "%Y%m%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    raise ValueError(f"unrecognised date {text!r}")


def _bank_amount(text: str) -> Decimal:
    s = re.sub(r"€|EUR|\s| ", "", text, flags=re.I).replace("−", "-")
    negative = s.startswith("-")
    value = _to_decimal(s.lstrip("+-"))
    return -value if negative else value


def load_bank_csv(path: Path, first_id: int = 1) -> list[Transaction]:
    """Read a bank export into Transactions (pending/'vorgemerkt' lines are skipped)."""
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252")
    lines = text.splitlines()

    for start, line in enumerate(lines):
        delim = max(";,\t", key=line.count)
        cells = [c.strip().lower() for c in next(csv.reader([line], delimiter=delim), [])]
        if _column(cells, "date") is not None and _column(cells, "amount") is not None:
            break
    else:
        raise SystemExit(f"{path}: no header row with a date and an amount column found")
    col = {kind: _column(cells, kind) for kind in _CSV_COLUMNS}

    def cell(row: list[str], kind: str) -> str:
        i = col[kind]
        return row[i].strip() if i is not None and i < len(row) else ""

    out: list[Transaction] = []
    for n, row in enumerate(csv.reader(lines[start + 1:], delimiter=delim), start=start + 2):
        if not any(c.strip() for c in row):
            continue
        if cell(row, "status").lower() in _PENDING_MARKS:
            continue
        try:
            when, amount = _bank_date(cell(row, "date")), _bank_amount(cell(row, "amount"))
        except (ValueError, ArithmeticError) as e:
            raise SystemExit(f"{path} line {n}: {e}") from None
        if amount > 0 and cell(row, "sign").lower() in _DEBIT_MARKS:
            amount = -amount
        name = (cell(row, "payee") if amount < 0 else cell(row, "payer")) or \
            cell(row, "payee") or cell(row, "payer") or cell(row, "text") or "(no counterparty)"
        out.append(Transaction(f"B{first_id + len(out):03d}", when, amount, " ".join(name.split())))
    return out


def load_request(path: Path, default_year: int) -> list[Transaction]:
    """The accountant's list of bank lines without a document.

    A .csv is read like a bank export; anything else is one line per item as
    'date | amount | bank text' (e.g. '12 Sep 2026 | -180.00 | LOXO'). Lines
    starting with # are comments.
    """
    if path.suffix.lower() == ".csv":
        return load_bank_csv(path)
    out = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        try:
            out.append(parse_transaction_line(line, default_year, f"R{len(out) + 1:03d}"))
        except ValueError as e:
            raise SystemExit(f"{path} line {n}: {e}") from None
    return out


# --------------------------------------------------------------------------
# Ledger and precedents
# --------------------------------------------------------------------------
# ledger.json holds one entry per forwarded document, with the bank line it
# settled. It answers "was this already sent?" and gives the precedents:
#   - bank text -> vendor learned from earlier matches (LOXO INC 8834 -> Loxo),
#   - how often a vendor bills and its usual amount,
#   - recurring invoices that are due but have not arrived.

EXPECT_GRACE_DAYS = 10    # a recurring invoice counts as late this long after its usual date
CADENCES = [("weekly", 6, 8), ("monthly", 26, 35), ("quarterly", 85, 97), ("yearly", 355, 375)]


def week_label(day: date) -> str:
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"


def transaction_keys(transactions: Sequence[Transaction]) -> dict[str, str]:
    """Stable id per bank line across runs: date|amount|bank text (#n for identical lines)."""
    seen: dict[str, int] = {}
    keys = {}
    for t in transactions:
        base = f"{t.date.isoformat()}|{t.amount}|{normalize_vendor(t.description)}"
        seen[base] = seen.get(base, 0) + 1
        keys[t.id] = base if seen[base] == 1 else f"{base}#{seen[base]}"
    return keys


def document_key(d: Document) -> str:
    return d.sha256 or f"{normalize_vendor(d.vendor)}|{d.amount}|{d.date_label}|{d.doc_type.value}"


def load_ledger(path: Path | None) -> list[dict]:
    if path is None:
        return []
    data = _read_json(path, {"entries": []})
    return list(data.get("entries", []))


def save_ledger(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"version": 1, "entries": entries}, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    tmp.replace(path)


@dataclass(frozen=True)
class VendorPrecedent:
    vendor: str
    dates: tuple[date, ...]          # document dates (payment date when undated), oldest first
    amounts: tuple[Decimal, ...]
    filenames: tuple[str, ...]

    @property
    def usual_amount(self) -> Decimal:
        return statistics.mode(self.amounts)

    @property
    def cadence(self) -> tuple[str, int] | None:
        """('monthly', 31) when the documents come at a regular interval."""
        gaps = [(b - a).days for a, b in zip(self.dates, self.dates[1:])]
        if not gaps:
            return None
        median = int(statistics.median(gaps))
        if any(abs(g - median) > max(4, median * 0.2) for g in gaps):
            return None
        return next(((label, median) for label, lo, hi in CADENCES if lo <= median <= hi), None)

    @property
    def next_expected(self) -> date | None:
        c = self.cadence
        return self.dates[-1] + timedelta(days=c[1]) if c else None

    def describe(self) -> str:
        c = self.cadence
        how = f"bills {c[0]}" if c else f"{len(self.dates)} earlier document(s)"
        return (f"{how}, usually {fmt_money(self.usual_amount)}; last: {self.filenames[-1]} "
                f"({self.dates[-1]:%d %b})")


def build_precedents(entries: Sequence[dict]) -> dict[str, VendorPrecedent]:
    """Vendor key -> history, from the ledger's purchase documents (credit notes left out)."""
    grouped: dict[str, list[dict]] = {}
    for e in entries:
        if e.get("direction") == Direction.PAYABLE.value and e.get("doc_type") != "credit_note":
            grouped.setdefault(e["vendor_key"], []).append(e)
    out = {}
    for key, rows in grouped.items():
        rows.sort(key=lambda e: e.get("doc_date") or e["txn_date"])
        out[key] = VendorPrecedent(
            rows[-1]["vendor"],
            tuple(date.fromisoformat(e.get("doc_date") or e["txn_date"]) for e in rows),
            tuple(Decimal(e["amount"]) for e in rows),
            tuple(e["filename"] for e in rows))
    return out


def learned_aliases(entries: Sequence[dict]) -> dict[str, str]:
    """Normalized bank text -> vendor, for every bank line matched in an earlier week."""
    out = {}
    for e in entries:
        norm = normalize_vendor(e["bank_text"])
        if norm and norm != e["vendor_key"]:
            out[norm] = e["vendor"]
    return out


def precedent_hint(p: VendorPrecedent, txn: Transaction) -> str:
    hint = p.describe()
    if -txn.amount == p.usual_amount:
        hint += " - same amount, so most likely the regular invoice"
    elif txn.amount < 0:
        hint += f" - this payment is {fmt_money(txn.amount)}, not the usual amount"
    return hint


# --------------------------------------------------------------------------
# Weekly run: decide what to forward
# --------------------------------------------------------------------------

class Action(Enum):
    FORWARD = "forward"   # real document, matched to a bank line -> goes to the accountant
    HOLD = "hold"         # matched, but needs your OK first (fuzzy name, no date)
    WAIT = "wait"         # real document, no bank line yet -> retried next week
    SKIP = "skip"         # sales invoice with --purchases-only


@dataclass(frozen=True)
class Decision:
    documents: tuple[Document, ...]
    action: Action
    match: Match | None = None
    notes: tuple[str, ...] = ()       # for the summary (part payment, bank text...)
    vat: tuple[VatFlag, ...] = ()     # VAT rule hits on these documents


@dataclass
class WeeklyRun:
    label: str                         # ISO week, e.g. 2026-W46
    start: date
    end: date
    result: ReconciliationResult
    decisions: list[Decision]
    rejected: list[tuple[str, str, str]]
    missing_hints: dict[str, str]      # transaction id -> precedent hint
    expected: list[tuple[VendorPrecedent, date]]
    already_forwarded: int             # documents skipped because an earlier week sent them
    already_settled: int               # bank lines skipped because an earlier week covered them
    txn_keys: dict[str, str]
    n_transactions: int
    n_documents: int

    def with_action(self, action: Action) -> list[Decision]:
        return sorted((d for d in self.decisions if d.action is action),
                      key=lambda d: (d.match.transaction.date if d.match else
                                     (d.documents[0].date_range or (date.max,))[0]))

    @property
    def forwarded(self) -> list[Decision]:
        return self.with_action(Action.FORWARD)

    @property
    def missing(self) -> list[tuple[Transaction, VendorResolution | None]]:
        r = self.result
        items = [(md.transaction, md.vendor) for md in r.missing_documents]
        items += [(t, None) for t in r.unmatched_transactions]
        return sorted(items, key=lambda it: it[0].date)


def decide(result: ReconciliationResult, include_sales: bool = True,
           approved: Sequence[str] = ()) -> list[Decision]:
    """Forward real documents matched to a bank line; hold the uncertain ones."""
    vat = {f.document.id: f for f in result.vat_flags}
    approved = set(approved)
    out = []
    for m in result.matches:
        t, docs = m.transaction, m.documents
        notes: list[str] = []
        if m.match_type is MatchType.PARTIAL:
            notes.append(f"part payment of {fmt_money(docs[0].amount)} - "
                         f"{fmt_money(m.outstanding)} still open")
        elif m.match_type is MatchType.NETTED:
            notes.append("settled as one net payment: " +
                         " + ".join(f"{d.filename} ({fmt_eur(d.amount)})" for d in docs))
        if m.vendor.method is ResolutionMethod.ALIAS:
            notes.append(f'bank text "{t.description}"')
        flags = tuple(vat[d.id] for d in docs if d.id in vat)

        hold = []
        if m.vendor.method is ResolutionMethod.FUZZY:
            hold.append(f'bank text "{t.description}" only resembles {m.vendor.name} - confirm it')
        if not m.date_confirmed:
            hold.append(", ".join(d.filename for d in docs if d.date_range is None)
                        + " has no date - confirm it belongs to this payment")
        if hold and all(d.filename in approved for d in docs):
            notes.append("approved manually")
            hold = []

        if not include_sales and all(d.direction is Direction.RECEIVABLE for d in docs):
            out.append(Decision(docs, Action.SKIP, m, ("sales invoice (--purchases-only)",)))
        elif hold:
            out.append(Decision(docs, Action.HOLD, m, tuple(hold + notes), flags))
        else:
            out.append(Decision(docs, Action.FORWARD, m, tuple(notes), flags))
    for d in result.unmatched_documents:
        out.append(Decision((d,), Action.WAIT, None,
                            ("no bank payment for it yet - goes out once the payment shows up",),
                            (vat[d.id],) if d.id in vat else ()))
    return out


def run_week(
    transactions: Sequence[Transaction],
    documents: Sequence[Document],
    ledger: Sequence[dict] = (),
    week_end: date | None = None,
    rejected: Sequence[tuple[str, str, str]] = (),
    problems: Sequence[tuple[str, str]] = (),
    since: date | None = None,
    include_sales: bool = True,
    approved: Sequence[str] = (),
    label: str | None = None,
    resend: bool = False,
) -> WeeklyRun:
    """Match this week's real documents to bank lines and decide what to forward.

    Ledger entries with the same label are ignored, so re-running a week rebuilds it.
    resend=True (answering the accountant's list) also matches documents sent
    before - the accountant is asking for them, so they go again, with a note.
    """
    week_end = week_end or date.today()
    label = label or week_label(week_end)
    past = [e for e in ledger if e.get("week") != label]
    sent_in = {e["doc_key"]: e["week"] for e in past}
    settled = set() if resend else {e["txn_key"] for e in past}
    sent = set() if resend else set(sent_in)

    keys = transaction_keys(transactions)
    in_range = [t for t in transactions
                if t.date <= week_end and (since is None or t.date >= since)]
    txns = [t for t in in_range if keys[t.id] not in settled]
    docs = [d for d in documents if document_key(d) not in sent]

    precedents = build_precedents(past)
    result = reconcile(txns, docs, learned_aliases(past),
                       {k: p.vendor for k, p in precedents.items()})
    result.unreadable_documents = list(problems)

    hints = {}
    for md in result.missing_documents:
        p = precedents.get(md.vendor.key)
        if p:
            hints[md.transaction.id] = precedent_hint(p, md.transaction)

    # Recurring vendors whose next invoice is overdue and of which there is no
    # sign this run - neither a document nor a bank payment since the last one.
    seen_after: dict[str, date] = {}
    for m in result.matches:
        for d in m.documents:
            seen_after[normalize_vendor(d.vendor)] = max(
                seen_after.get(normalize_vendor(d.vendor), date.min), m.transaction.date)
    for d in result.unmatched_documents:
        if d.date_range:
            k = normalize_vendor(d.vendor)
            seen_after[k] = max(seen_after.get(k, date.min), d.date_range[1])
    for md in result.missing_documents:
        seen_after[md.vendor.key] = max(seen_after.get(md.vendor.key, date.min), md.transaction.date)
    expected = []
    for key, p in precedents.items():
        due = p.next_expected
        if due is None or seen_after.get(key, date.min) > p.dates[-1]:
            continue
        cadence_days = p.cadence[1]
        if due + timedelta(days=EXPECT_GRACE_DAYS) <= week_end < due + timedelta(days=2 * cadence_days):
            expected.append((p, due))

    decisions = decide(result, include_sales, approved)
    if resend:
        decisions = [dataclasses.replace(dec, notes=dec.notes + tuple(
                         f"{d.filename} was already sent in {sent_in[document_key(d)]}"
                         for d in dec.documents if document_key(d) in sent_in))
                     for dec in decisions]

    return WeeklyRun(
        label=label, start=week_end - timedelta(days=6), end=week_end, result=result,
        decisions=decisions, rejected=list(rejected),
        missing_hints=hints, expected=sorted(expected, key=lambda e: e[1]),
        already_forwarded=len(documents) - len(docs),
        already_settled=len(in_range) - len(txns),
        txn_keys=keys, n_transactions=len(txns), n_documents=len(docs),
    )


def record_week(run: WeeklyRun, ledger: Sequence[dict], today: date | None = None) -> list[dict]:
    """The ledger with this week's forwarded documents (replacing an earlier run of the same week)."""
    entries = [e for e in ledger if e.get("week") != run.label]
    for decision in run.forwarded:
        t, m = decision.match.transaction, decision.match
        for d in decision.documents:
            entries.append({
                "week": run.label,
                "recorded_on": (today or date.today()).isoformat(),
                "doc_key": document_key(d),
                "filename": d.filename,
                "vendor": m.vendor.name if m.vendor.method is not ResolutionMethod.UNRESOLVED else d.vendor,
                "vendor_key": normalize_vendor(d.vendor),
                "doc_type": d.doc_type.value,
                "direction": d.direction.value,
                "amount": str(d.amount),
                "doc_date": d.date_range[0].isoformat() if d.date_range else None,
                "txn_key": run.txn_keys[t.id],
                "txn_date": t.date.isoformat(),
                "txn_amount": str(t.amount),
                "bank_text": t.description,
                "match_type": m.match_type.value,
            })
    return entries


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------

WIDTH = 84
INDENT = " " * 26        # aligns detail lines under the description column
DOC_COL = 40             # width of the filename column in detail lines


def fmt_eur(amount: Decimal) -> str:
    sign = "-" if amount < 0 else "+"
    return f"{sign}€{abs(amount):,.2f}"


def txn_line(t: Transaction, tag: str = "") -> str:
    return f"  {t.date:%d %b}  {fmt_eur(t.amount):>13}  {t.description:<14}  {tag}".rstrip()


def doc_line(label: str, amount: Decimal, note: str = "") -> str:
    return f"{INDENT}{label:<{DOC_COL}}{fmt_eur(amount):>13}  {note}".rstrip()


def note_line(text: str) -> str:
    return f"{INDENT}↳ {text}"


def render_section(title: str, items: list[tuple[date, list[str]]], empty: str) -> list[str]:
    out = ["", f"[{title}]  {len(items)} item{'s' if len(items) != 1 else ''}", "─" * WIDTH]
    if not items:
        out.append(f"  {empty}")
    spaced = any(len(lines) > 1 for _, lines in items)   # one-liners stay compact
    for i, (_, lines) in enumerate(sorted(items, key=lambda it: it[0])):
        if i and spaced:
            out.append("")
        out.extend(lines)
    return out


def render_lookup(query: Transaction, documents: list[Document], r: ReconciliationResult) -> str:
    """Answer 'which document belongs to this transaction?' parameter by parameter."""
    known_vendors = {normalize_vendor(d.vendor): d.vendor for d in documents}
    vendor = resolve_vendor(query.description, known_vendors)
    lo, hi = accepted_document_dates(query.date)
    used_by = {d.id: m.transaction for m in r.matches for d in m.documents}

    def taken_by_other(d: Document) -> Transaction | None:
        owner = used_by.get(d.id)
        return owner if owner and (owner.date, owner.amount) != (query.date, query.amount) else None

    checks = [check_document(query, vendor, d) for d in documents]
    # Matches first; among them, documents still free before ones another payment used.
    shown = sorted((c for c in checks if c.vendor_ok or c.amount_ok),
                   key=lambda c: (not c.is_match, taken_by_other(c.document) is not None,
                                  c.date_gap is None, abs(c.date_gap or 0)))
    matches = [c for c in shown if c.is_match]
    mark = lambda ok: "✓" if ok else ("?" if ok is None else "✗")   # noqa: E731

    out = [
        "═" * WIDTH,
        f"  DOCUMENT LOOKUP   {query.date:%d %b %Y} | {fmt_eur(query.amount)} | {query.description}",
        "═" * WIDTH,
        f"  date    {f'{query.date:%d %b %Y}':<14}  → document dated {lo:%d %b %Y} – {hi:%d %b %Y}",
        f"  amount  {fmt_eur(query.amount):<14}  → document total {fmt_money(query.amount)}"
        f" ({'we pay' if query.amount < 0 else 'we receive'})",
        f"  vendor  {query.description:<14}  → {vendor.name} ({vendor.method.value} match)",
        "",
        f"  {'DOCUMENT':<36}{'DATED':<13}{'AMOUNT':>12}   DATE  AMOUNT  VENDOR",
        "─" * WIDTH,
    ]
    for c in shown:
        d = c.document
        flag = "MATCH" if c.is_match else ""
        out.append(f"  {d.filename:<36}{d.date_label:<13}{fmt_eur(d.expected_bank_amount):>12}"
                   f"    {mark(c.date_ok)}      {mark(c.amount_ok)}      {mark(c.vendor_ok)}    {flag}")
    if not shown:
        out.append("  no document shares this vendor or amount")
    out.append("─" * WIDTH)

    def used_note(d: Document) -> str:
        owner = taken_by_other(d)
        return (f"  (already reconciled to {owner.date:%d %b} {fmt_eur(owner.amount)} "
                f"{owner.description})" if owner else "")

    if matches:
        best = matches[0].document
        line = f"  Result: {best.filename}{used_note(best)}"
        if matches[0].date_ok is None:
            line += "  - undated, confirm manually"
        out.append(line)
        out += [f"  Also fits:  {c.document.filename}{used_note(c.document)}" for c in matches[1:]]
    else:
        out.append(f"  Result: no document matches all three - request one from {vendor.name}")
    out.append("═" * WIDTH)
    return "\n".join(out) + "\n"




def fmt_money(amount: Decimal) -> str:
    return f"€{abs(amount):,.2f}"


def flow(amount: Decimal) -> str:
    return "received" if amount > 0 else "paid"


def payee(t: Transaction, v: VendorResolution | None) -> str:
    if v is None or v.method is ResolutionMethod.UNRESOLVED:
        return f'unknown payee (bank text "{t.description}")'
    if v.method is ResolutionMethod.EXACT:
        return v.name
    return f'{v.name} (bank text "{t.description}")'


def _decision_lines(dec: Decision) -> list[str]:
    if dec.match:
        t = dec.match.transaction
        first = txn_line(t, dec.documents[0].filename if len(dec.documents) == 1 else "")
        lines = [first]
        if len(dec.documents) > 1:
            lines += [doc_line(d.filename, d.expected_bank_amount, d.doc_type.value.replace("_", " "))
                      for d in dec.documents]
    else:
        d = dec.documents[0]
        rng = d.date_range
        lines = [f"  {f'{rng[0]:%d %b}' if rng else '—':<6}  {fmt_eur(d.expected_bank_amount):>13}  "
                 f"{d.vendor[:14]:<14}  {d.filename}"]
    return (lines + [note_line(n) for n in dec.notes]
            + [note_line(f"VAT ({f.document.filename}): {f.reason}") for f in dec.vat])


def _sort_date(dec: Decision) -> date:
    if dec.match:
        return dec.match.transaction.date
    return (dec.documents[0].date_range or (date.max,))[0]


def render_weekly_report(run: WeeklyRun) -> str:
    """Everything the run decided, for you (the accountant gets the short email)."""
    r = run.result
    section = lambda action: [(_sort_date(d), _decision_lines(d))   # noqa: E731
                              for d in run.with_action(action)]

    missing = []
    for t, v in run.missing:
        md = next((m for m in r.missing_documents if m.transaction is t), None)
        lines = [txn_line(t, f"→ {v.name}" if v else "→ unknown vendor")]
        if v and v.method is not ResolutionMethod.EXACT:
            lines.append(note_line(f"'{t.description}' read as '{v.name}' ({v.method.value} match)"))
        for c in (md.candidates if md else ()):
            lines.append(doc_line(f"not used: {c.document.filename}", c.document.expected_bank_amount,
                                  "; ".join(c.failures())))
        if t.id in run.missing_hints:
            lines.append(note_line(f"precedent: {run.missing_hints[t.id]}"))
        lines.append(note_line(f"request the {v.name} invoice/receipt" if v
                               else "identify the counterparty and obtain a document"))
        missing.append((t.date, lines))

    expected = [(due, [f"  {due:%d %b}  {fmt_eur(-p.usual_amount):>13}  {p.vendor[:14]:<14}  "
                       f"expected, not seen",
                       note_line(p.describe()),
                       note_line("no invoice and no bank payment since - chase it, "
                                 "or ignore if the subscription ended")])
                for p, due in run.expected]

    rejected = [(date.max, [f"  {'—':<6}  {'':>13}  {'(set aside)':<14}  {name}",
                            note_line(f"{kind}: {reason}")])
                for name, kind, reason in run.rejected]
    unreadable = [(date.max, [f"  {'—':<6}  {'?':>13}  {'(not used)':<14}  {name}", note_line(reason)])
                  for name, reason in r.unreadable_documents]

    out = [
        "═" * WIDTH,
        (f"  ACCOUNTANT REQUEST  ·  answered {run.end:%d %b %Y}" if run.label.startswith("request-")
         else f"  WEEKLY INVOICE RUN  ·  {run.label}  ·  {run.start:%d %b} – {run.end:%d %b %Y}"),
        f"  {run.n_transactions} open bank lines  ·  {run.n_documents} invoices/receipts  ·  "
        f"{len(run.rejected)} other PDFs set aside",
        "═" * WIDTH,
        f"  {'DATE':<6}  {'AMOUNT':>13}  {'BANK TEXT':<14}  DOCUMENT / STATUS",
    ]
    out += render_section("FORWARDED TO ACCOUNTANT", section(Action.FORWARD), "nothing new to forward")
    out += render_section("HELD FOR YOUR CHECK (not forwarded)", section(Action.HOLD), "nothing held")
    out += render_section("MISSING: BANK PAYMENTS WITHOUT A DOCUMENT", missing, "none")
    out += render_section("EXPECTED FROM PAST WEEKS, NOT SEEN", expected, "nothing overdue")
    out += render_section("SET ASIDE: NOT AN INVOICE OR RECEIPT", rejected, "none")
    out += render_section("WAITING: NO BANK PAYMENT YET", section(Action.WAIT), "none")
    if r.unreadable_documents:
        out += render_section("UNREADABLE / DUPLICATE PDFs", unreadable, "none")
    if any(d.action is Action.SKIP for d in run.decisions):
        out += render_section("NOT FORWARDED: SALES INVOICES", section(Action.SKIP), "none")

    n_fwd_docs = sum(len(d.documents) for d in run.forwarded)
    out += [
        "",
        "═" * WIDTH,
        f"  Forwarded         {n_fwd_docs:>3} document(s) for {len(run.forwarded)} bank line(s)",
        f"  Held for you      {len(run.with_action(Action.HOLD)):>3}",
        f"  Missing           {len(missing):>3} bank line(s) without a document",
        f"  Expected, late    {len(expected):>3}",
        f"  Set aside         {len(rejected):>3} non-invoice PDF(s)",
        f"  Waiting           {len(run.with_action(Action.WAIT)):>3} document(s) without a payment yet",
    ]
    if run.already_forwarded or run.already_settled:
        out.append(f"  From earlier weeks (ledger): {run.already_forwarded} document(s) already sent, "
                   f"{run.already_settled} bank line(s) already covered - skipped")
    out.append("═" * WIDTH)
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------
# Forward email (draft for the accountant / Exact inbox)
# --------------------------------------------------------------------------

EMAIL_WIDTH = 76


def build_forward_email(run: WeeklyRun, accountant_name: str = "",
                        sender_name: str = "") -> tuple[str, str]:
    """(subject, body): what is attached and which bank payments still lack a document."""
    fwd = run.forwarded
    n_docs = sum(len(d.documents) for d in fwd)
    missing = run.missing
    period = f"{run.start:%d %b} – {run.end:%d %b %Y}"
    plural = lambda n, word: f"{n} {word}{'' if n == 1 else 's'}"   # noqa: E731

    request = run.label.startswith("request-")
    if request:
        subject = (f"Missing documents: {len(fwd)} of {len(fwd) + len(missing)} found"
                   + (f", {len(missing)} still open" if missing else ""))
    else:
        subject = (f"Invoices & receipts {run.label} ({period}): {n_docs} attached"
                   + (f", {plural(len(missing), 'payment')} without a document" if missing else ""))

    out = [f"Hi {accountant_name or 'there'},", ""]
    if fwd:
        docs = ("1 invoice/receipt" if n_docs == 1 else f"{n_docs} invoices/receipts")
        intro = (f"Thanks for the list. Attached {'is' if n_docs == 1 else 'are'} {docs} for "
                 f"{plural(len(fwd), 'payment')} on it:" if request else
                 f"Attached {'is' if n_docs == 1 else 'are'} {docs} for this week, each matched "
                 f"to a bank payment:")
        out += [textwrap.fill(intro, EMAIL_WIDTH), ""]
        for dec in fwd:
            t, m = dec.match.transaction, dec.match
            name = m.vendor.name if m.vendor.method is not ResolutionMethod.UNRESOLVED else dec.documents[0].vendor
            out.append(f"  {t.date:%d %b %Y}  {fmt_money(t.amount):>11} {flow(t.amount):<8}  "
                       f"{name[:18]:<18}  {', '.join(d.filename for d in dec.documents)}")
            notes = [n for n in dec.notes if not n.startswith("bank text")]
            notes += [f"{f.document.filename}: VAT reverse-charged" if f.document.reverse_charge
                      else f"{f.document.filename}: no VAT shown on the invoice" for f in dec.vat]
            for n in notes:
                out.append(textwrap.fill(n, EMAIL_WIDTH, initial_indent=" " * 14 + "- ",
                                         subsequent_indent=" " * 16))
    else:
        out.append("We could not find documents for the payments on your list yet."
                   if request else "No new invoices or receipts this week.")

    if missing:
        out += ["", ("Still without a document (we are chasing these):" if request else
                     "Bank payments still without a document (we are chasing these):"), ""]
        for t, v in missing:
            out.append(textwrap.fill(f"{t.date:%d %b %Y} – {fmt_money(t.amount)} {flow(t.amount)} – "
                                     f"{payee(t, v)}", EMAIL_WIDTH,
                                     initial_indent="  • ", subsequent_indent="    "))

    out += ["", "Kind regards,", sender_name or "[Your name]"]
    return subject, "\n".join(out) + "\n"


def export_forward_email(run: WeeklyRun, out_dir: Path, report_text: str,
                         accountant_name: str = "", accountant_email: str = "",
                         sender_name: str = "") -> dict[str, Path]:
    """Write the weekly report and an unsent .eml draft with the forwarded PDFs attached.

    Only the invoice/receipt PDFs are attached (no report file), so an Exact
    Online inbox turns each attachment into exactly one document to book.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    written = {"report": out_dir / f"weekly_report_{run.label}.txt"}
    written["report"].write_text(report_text, encoding="utf-8")

    subject, body = build_forward_email(run, accountant_name, sender_name)
    written["text"] = out_dir / f"forward_{run.label}.txt"
    written["text"].write_text(f"Subject: {subject}\n\n{body}", encoding="utf-8")

    msg = EmailMessage()
    msg["Subject"] = subject
    if accountant_email:
        msg["To"] = accountant_email
    msg["X-Unsent"] = "1"
    msg.set_content(body)
    for dec in run.forwarded:
        for d in dec.documents:
            if d.source_path and d.source_path.is_file():
                msg.add_attachment(d.source_path.read_bytes(), maintype="application",
                                   subtype="pdf", filename=d.filename)
    written["eml"] = out_dir / f"forward_{run.label}.eml"
    written["eml"].write_bytes(msg.as_bytes())
    return written


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    import sys

    sys.stdout.reconfigure(encoding="utf-8")   # € and box characters on Windows consoles

    parser = argparse.ArgumentParser(
        description="Weekly run: forward real invoices/receipts matched to bank lines.")
    bank = parser.add_argument_group("bank")
    bank.add_argument("--bank-csv", type=Path, action="append", default=[], metavar="FILE",
                      help="bank export(s) (DKB, ING, Rabo, generic CSV); default: built-in sample")
    bank.add_argument("--request", type=Path, metavar="FILE",
                      help="answer the accountant's missing-documents list instead of a bank export: "
                           "one 'date | amount | bank text' per line, or a CSV")
    bank.add_argument("--since", type=date.fromisoformat, metavar="YYYY-MM-DD",
                      help="ignore bank lines before this date")
    bank.add_argument("--week-ending", type=date.fromisoformat, metavar="YYYY-MM-DD",
                      help="last day of the week to process (default: today)")
    src = parser.add_argument_group("documents")
    src.add_argument("--docs-dir", type=Path,
                     help="folder of PDF invoices/receipts to parse (default: built-in sample list)")
    src.add_argument("--company", action="append", default=[], metavar="NAME",
                     help="your own company name(s), to tell sales invoices from purchase invoices")
    src.add_argument("--gmail", action="store_true",
                     help="first download PDF attachments from Gmail into --docs-dir")
    src.add_argument("--eml-dir", type=Path, metavar="DIR",
                     help="first save PDF attachments of the raw emails (*.eml) in DIR into --docs-dir")
    src.add_argument("--gmail-credentials", type=Path, default=Path("credentials.json"),
                     help="OAuth client JSON from Google Cloud Console")
    src.add_argument("--gmail-token", type=Path, default=Path("token.json"),
                     help="where the Gmail sign-in is cached after the first run")
    src.add_argument("--gmail-since", type=date.fromisoformat, metavar="YYYY-MM-DD",
                     help=f"start of the search window (default: {GMAIL_WINDOW_WEEKS} weeks before the end)")
    src.add_argument("--gmail-until", type=date.fromisoformat, metavar="YYYY-MM-DD",
                     help=f"end of the search window (default: last transaction + {GMAIL_GRACE_DAYS} days)")
    parser.add_argument("--find", metavar='"12 Sep | -€180.00 | LOXO"',
                        help="look up the document for one statement line and exit")
    run_opts = parser.add_argument_group("forwarding")
    run_opts.add_argument("--approve", action="append", default=[], metavar="FILE",
                          help="forward a held document anyway (file name as shown in the report)")
    run_opts.add_argument("--purchases-only", action="store_true",
                          help="don't forward your own sales invoices")
    run_opts.add_argument("--ledger", type=Path,
                          help="history of forwarded documents (default: <out-dir>/ledger.json; "
                               "not written for the built-in sample)")
    run_opts.add_argument("--dry-run", action="store_true", help="don't update the ledger")
    out = parser.add_argument_group("email draft")
    out.add_argument("--accountant", default="", help="accountant's first name for the greeting")
    out.add_argument("--accountant-email", default="",
                     help="pre-fills the To: field of the .eml (e.g. your Exact Online inbox)")
    out.add_argument("--sender", default="", help="your name for the sign-off")
    out.add_argument("--out-dir", type=Path, default=Path.cwd(), help="where to write the draft")
    out.add_argument("--no-email", action="store_true", help="only print the report")
    args = parser.parse_args()

    if args.request:
        if not args.request.is_file():
            parser.error(f"--request not found: {args.request}")
        transactions = load_request(args.request, (args.week_ending or date.today()).year)
        if not transactions:
            parser.error("no lines found in --request")
    elif args.bank_csv:
        transactions: list[Transaction] = []
        for f in args.bank_csv:
            if not f.is_file():
                parser.error(f"--bank-csv not found: {f}")
            transactions += load_bank_csv(f, first_id=len(transactions) + 1)
        if not transactions:
            parser.error("no bank lines found in --bank-csv")
    else:
        transactions = TRANSACTIONS
    week_end = args.week_ending or date.today()
    statement_year = max(t.date for t in transactions).year

    # The built-in sample never writes a ledger unless one is asked for.
    ledger_path = args.ledger or (args.out_dir / "ledger.json"
                                  if args.bank_csv or args.request else None)

    if args.gmail:
        args.docs_dir = args.docs_dir or args.out_dir / "documents"
        since, until = gmail_window(transactions)
        since, until = args.gmail_since or since, args.gmail_until or until
        service = connect_gmail(args.gmail_credentials, args.gmail_token)
        saved, skipped = download_gmail_pdfs(service, args.docs_dir, since, until)
        print(f"Gmail {since:%d %b} – {until:%d %b %Y}: {len(saved)} new PDF(s) saved to "
              f"{args.docs_dir}, {skipped} already there")

    if args.eml_dir:
        if not args.eml_dir.is_dir():
            parser.error(f"--eml-dir not found: {args.eml_dir}")
        args.docs_dir = args.docs_dir or args.out_dir / "documents"
        saved, skipped = import_eml_pdfs(sorted(args.eml_dir.glob("*.eml")), args.docs_dir)
        print(f"Emails in {args.eml_dir}: {len(saved)} new PDF(s) saved to {args.docs_dir}, "
              f"{skipped} already there")

    loaded = LoadedDocuments(documents=list(DOCUMENTS))
    if args.docs_dir:
        if not args.docs_dir.is_dir():
            parser.error(f"--docs-dir not found: {args.docs_dir}")
        loaded = load_documents(args.docs_dir, args.company, statement_year)

    if args.find:
        try:
            query = parse_transaction_line(args.find, statement_year)
        except ValueError as e:
            parser.error(str(e))
        result = reconcile(transactions, loaded.documents)
        print(render_lookup(query, loaded.documents, result), end="")
        sys.exit(0)

    ledger = load_ledger(ledger_path)
    run = run_week(transactions, loaded.documents, ledger, week_end, loaded.rejected,
                   loaded.problems, args.since, not args.purchases_only, args.approve,
                   label=f"request-{week_end.isoformat()}" if args.request else None,
                   resend=bool(args.request))
    report = render_weekly_report(run)
    print(report, end="")

    if not args.no_email:
        written = export_forward_email(run, args.out_dir, report, args.accountant,
                                       args.accountant_email, args.sender)
        print("\nFiles written (nothing was sent - review the draft and send it yourself):")
        for kind, path in written.items():
            print(f"  {kind:<7} {path}")
        unattached = [d.filename for dec in run.forwarded for d in dec.documents if not d.source_path]
        if unattached:
            print(f"  note: {len(unattached)} document(s) have no PDF file (built-in sample) "
                  f"and are listed but not attached")

    if ledger_path is None:
        print("  (sample data: ledger not written - pass --ledger to keep history)")
    elif args.dry_run or args.no_email:
        print(f"  (dry run: {ledger_path} not updated)")
    else:
        save_ledger(ledger_path, record_week(run, ledger))
        print(f"  ledger  {ledger_path}  ({run.label}: "
              f"{sum(len(d.documents) for d in run.forwarded)} document(s) recorded as forwarded)")
