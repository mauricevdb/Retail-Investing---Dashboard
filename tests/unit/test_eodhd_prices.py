import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.eodhd_prices import parse_bulk_prices

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "eodhd_bulk_prices_2024-02-15.json"


def test_prices_raw_and_adjusted_written_separately() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    prices_raw, prices_adjusted = parse_bulk_prices(raw)

    assert set(prices_raw.columns) == {"ticker", "date", "open", "high", "low", "close", "volume"}
    assert set(prices_adjusted.columns) == {"ticker", "date", "close_adj"}
    assert "close_adj" not in prices_raw.columns
    assert "close" not in prices_adjusted.columns

    raw_before = prices_raw.filter(
        (prices_raw["ticker"] == "AAAA") & (prices_raw["date"] == date(2024, 2, 14))
    ).row(0, named=True)
    assert raw_before["close"] == 150.0

    raw_after = prices_raw.filter(
        (prices_raw["ticker"] == "AAAA") & (prices_raw["date"] == date(2024, 2, 15))
    ).row(0, named=True)
    assert raw_after["close"] == 76.5

    adjusted_before = prices_adjusted.filter(
        (prices_adjusted["ticker"] == "AAAA") & (prices_adjusted["date"] == date(2024, 2, 14))
    ).row(0, named=True)
    assert adjusted_before["close_adj"] == 75.0

    adjusted_after = prices_adjusted.filter(
        (prices_adjusted["ticker"] == "AAAA") & (prices_adjusted["date"] == date(2024, 2, 15))
    ).row(0, named=True)
    assert adjusted_after["close_adj"] == 76.5
