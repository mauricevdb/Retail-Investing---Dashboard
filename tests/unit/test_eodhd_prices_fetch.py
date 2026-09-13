import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.eodhd_client import EodhdClient
from dashboard.ingestion.eodhd_prices import fetch_bulk_prices, parse_bulk_prices

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "eodhd_bulk_prices_2024-02-15.json"


class FakeTransport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, url, params):
        self.calls.append(url)
        return self.response


def test_fetch_bulk_prices_calls_client_and_parses() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    transport = FakeTransport(response=raw)
    client = EodhdClient(api_key="fake-eodhd-key", transport=transport)

    prices_raw, prices_adjusted = fetch_bulk_prices(client, date(2024, 2, 15))

    assert transport.calls == ["https://eodhd.com/api/eod-bulk-last-day/US?date=2024-02-15"]
    expected_raw, expected_adjusted = parse_bulk_prices(raw)
    assert prices_raw.equals(expected_raw)
    assert prices_adjusted.equals(expected_adjusted)
