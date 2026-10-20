from datetime import date

from ridash.sources.eodhd import parse_history, parse_quotes
from ridash.sources.sec import parse_frame


def test_parse_frame_normalises_values_and_dates():
    raw = {
        "data": [
            {"accn": "0001-26-1", "cik": 1800, "end": "2025-12-31", "val": 8053000000},
            {"accn": "0002-26-1", "cik": 1750, "end": "2025-05-31", "val": 1.5},
        ]
    }
    frame = parse_frame(raw, "OperatingIncomeLoss")
    assert frame.row(0) == (1800, "OperatingIncomeLoss", date(2025, 12, 31), 8.053e9, "0001-26-1")
    assert frame["value"].to_list()[1] == 1.5


def test_parse_history_keeps_adjusted_close():
    raw = [{"date": "2026-10-16", "close": 230.0, "adjusted_close": 229.5, "volume": 1}]
    assert parse_history(raw, "AAPL").row(0) == ("AAPL", date(2026, 10, 16), 229.5)
    assert parse_history(None, "GONE").is_empty()


def test_missing_frame_is_empty():
    assert parse_frame(None, "OperatingIncomeLoss").is_empty()


def test_parse_quotes_attaches_exchange_and_currency():
    bulk = [
        {
            "code": "AAPL",
            "date": "2026-09-23",
            "type": "Common Stock",
            "close": 230.1,
            "MarketCapitalization": 3_400_000_000_000,
            "avgvol_50d": 5e7,
        }
    ]
    listings = [{"Code": "AAPL", "Exchange": "NASDAQ", "Currency": "USD"}]
    quote = parse_quotes(bulk, listings).row(0, named=True)
    assert (quote["exchange"], quote["currency"], quote["market_cap"]) == ("NASDAQ", "USD", 3.4e12)
    assert quote["date"] == date(2026, 9, 23)
