import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.edgar_tickers import parse_company_tickers

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_company_tickers.json"


def test_edgar_tickers_pads_cik_to_ten_digits() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    df = parse_company_tickers(raw, as_of=date(2024, 2, 15))

    assert df.height == 4
    assert set(df.columns) == {"cik", "ticker", "name", "as_of"}
    assert set(df["cik"]) == {
        "0000000001",
        "0000000002",
        "0000000003",
        "0000000004",
    }
    row = df.filter(df["ticker"] == "AAAA").row(0, named=True)
    assert row["cik"] == "0000000001"
    assert row["name"] == "Alpha Operating Co"
    assert row["as_of"] == date(2024, 2, 15)
