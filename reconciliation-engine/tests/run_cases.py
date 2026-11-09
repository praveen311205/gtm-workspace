"""Edge-case checks for reconcile.py, driven by tests/edge_cases.csv.

    python tests/run_cases.py            # all cases
    python tests/run_cases.py late       # only cases whose name contains "late"

Each case is a group of rows in the CSV:
  row = txn  -> a bank transaction plus what SHOULD happen to it
  row = doc  -> a document available for matching

Columns
  case           name of the scenario (rows with the same name belong together)
  status         must_pass  - has to work; a failure means something broke
                 known_bug  - documented problem; allowed to fail until fixed
  id             transaction id (T1...) or document file name
  date           YYYY-MM-DD, YYYY-MM for month-only documents, or empty if undated
  amount         transactions: signed bank amount (-90.00 = money out)
                 documents:    amount as printed (credit notes negative)
  text_or_vendor bank text for transactions, counterparty name for documents
  doc_type       receipt | invoice | credit_note          (documents only)
  direction      out (we pay) | in (client pays us)       (documents only)
  vat            VAT shown on the document; 0 = none shown, empty = not checked
  expect_status  transactions: FULL | REVIEW | MISSING | UNKNOWN
                 documents (optional): VAT_FLAG | NO_FLAG for the VAT rule
  expect_docs    matched file names separated by |, empty when none
  expect_type    optional: EXACT | NETTED | PARTIAL
  note           free text, ignored

Exit code is 1 only if a must_pass case fails, so known bugs never block.
When a known_bug case starts passing, the run tells you to promote it.
"""

import csv
import sys
from collections import defaultdict
from datetime import date
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import reconcile as rc  # noqa: E402

CASES_FILE = Path(__file__).resolve().parent / "edge_cases.csv"


def parse_date(text: str):
    """Returns (doc_date, period)."""
    text = text.strip()
    if not text:
        return None, None
    parts = [int(p) for p in text.split("-")]
    if len(parts) == 2:
        return None, (parts[0], parts[1])
    return date(*parts), None


def load_cases(path: Path) -> dict[str, dict]:
    cases: dict[str, dict] = defaultdict(
        lambda: {"status": "must_pass", "txns": [], "docs": [], "expect": {}, "vat_expect": {}})
    with path.open(newline="", encoding="utf-8") as f:
        for i, r in enumerate(csv.DictReader(f), start=2):
            name = r["case"].strip()
            if not name:
                continue
            c = cases[name]
            c["status"] = r["status"].strip() or c["status"]
            try:
                if r["row"].strip() == "txn":
                    d, _ = parse_date(r["date"])
                    c["txns"].append(rc.Transaction(r["id"].strip(), d, Decimal(r["amount"]),
                                                    r["text_or_vendor"].strip()))
                    c["expect"][r["id"].strip()] = (
                        r["expect_status"].strip().upper(),
                        sorted(x.strip() for x in r["expect_docs"].split("|") if x.strip()),
                        r["expect_type"].strip().upper(),
                    )
                elif r["row"].strip() == "doc":
                    d, period = parse_date(r["date"])
                    vat = (r.get("vat") or "").strip()
                    c["docs"].append(rc.Document(
                        r["id"].strip(), r["id"].strip(), r["text_or_vendor"].strip(),
                        rc.DocType(r["doc_type"].strip()),
                        rc.Direction.PAYABLE if r["direction"].strip() == "out" else rc.Direction.RECEIVABLE,
                        Decimal(r["amount"]), d, period,
                        Decimal(vat) if vat else None))
                    want = r["expect_status"].strip().upper()
                    if want in ("VAT_FLAG", "NO_FLAG"):
                        c["vat_expect"][r["id"].strip()] = want == "VAT_FLAG"
                else:
                    raise ValueError(f"row must be txn or doc, got {r['row']!r}")
            except Exception as e:
                raise SystemExit(f"edge_cases.csv line {i}: {e}") from None
    return cases


def actual_outcomes(result: rc.ReconciliationResult) -> dict[str, tuple[str, list[str], str]]:
    out = {}
    for m in result.matches:
        out[m.transaction.id] = ("FULL" if m.is_certain else "REVIEW",
                                 sorted(d.filename for d in m.documents), m.match_type.name)
    for md in result.missing_documents:
        out[md.transaction.id] = ("MISSING", [], "")
    for t in result.unmatched_transactions:
        out[t.id] = ("UNKNOWN", [], "")
    return out


def describe(o: tuple[str, list[str], str]) -> str:
    status, docs, kind = o
    return " ".join(x for x in [status, kind, ", ".join(docs)] if x)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    cases = {k: v for k, v in load_cases(CASES_FILE).items() if only in k}
    broken, promote, still_buggy, passed = [], [], [], []

    for name, c in cases.items():
        result = rc.reconcile(c["txns"], c["docs"])
        got = actual_outcomes(result)
        flagged = {f.document.filename for f in result.vat_flags}
        problems = []
        for doc_id, want_flag in c["vat_expect"].items():
            if (doc_id in flagged) != want_flag:
                problems.append(f"    {doc_id}: expected {'VAT_FLAG' if want_flag else 'NO_FLAG'}"
                                f"\n         got      {'VAT_FLAG' if doc_id in flagged else 'NO_FLAG'}")
        for tid, (want_status, want_docs, want_type) in c["expect"].items():
            have = got.get(tid, ("NOT SEEN", [], ""))
            ok = have[0] == want_status and have[1] == want_docs and (not want_type or have[2] == want_type)
            if not ok:
                problems.append(f"    {tid}: expected {describe((want_status, want_docs, want_type))}"
                                f"\n         got      {describe(have)}")
        if c["status"] == "known_bug":
            (still_buggy if problems else promote).append((name, problems))
        else:
            (broken if problems else passed).append((name, problems))

    for name, _ in passed:
        print(f"  PASS        {name}")
    for name, problems in still_buggy:
        print(f"  KNOWN BUG   {name}")
        print("\n".join(problems))
    for name, _ in promote:
        print(f"  FIXED?      {name}  -> now passes; change its status to must_pass")
    for name, problems in broken:
        print(f"  FAIL        {name}")
        print("\n".join(problems))

    print(f"\n{len(passed)} passing, {len(broken)} failing, "
          f"{len(still_buggy)} known bugs, {len(promote)} to promote")
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
