import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.eodhd_actions import parse_corporate_actions

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "eodhd_bulk_actions_2024-02-15.json"


def test_corporate_actions_parsed() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    df = parse_corporate_actions(raw)

    assert df.height == 1
    assert set(df.columns) == {"ticker", "date_effective", "action_type", "ratio_or_amount"}
    row = df.row(0, named=True)
    assert row["ticker"] == "AAAA"
    assert row["date_effective"] == date(2024, 2, 15)
    assert row["action_type"] == "split"
    assert row["ratio_or_amount"] == 2.0
