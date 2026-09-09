import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.edgar_submissions import parse_filings

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_submissions_0000000001.json"


def test_edgar_submissions_parses_filing_history() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    df = parse_filings(raw)

    assert df.height == 2
    assert set(df.columns) == {"cik", "accn", "form", "filed", "period_of_report"}
    assert set(df["cik"]) == {"0000000001"}

    ten_k = df.filter(df["form"] == "10-K").row(0, named=True)
    assert ten_k["accn"] == "0000000001-24-000010"
    assert ten_k["filed"] == date(2024, 2, 15)
    assert ten_k["period_of_report"] == date(2023, 12, 31)

    amendment = df.filter(df["form"] == "10-K/A").row(0, named=True)
    assert amendment["accn"] == "0000000001-24-000003"
    assert amendment["filed"] == date(2024, 3, 20)
