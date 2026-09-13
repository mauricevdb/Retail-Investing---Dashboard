import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.eodhd_actions import fetch_bulk_actions, parse_corporate_actions
from dashboard.ingestion.eodhd_client import EodhdClient

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "eodhd_bulk_actions_2024-02-15.json"


class FakeTransport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, url, params):
        self.calls.append(url)
        return self.response


def test_fetch_bulk_actions_calls_client_and_parses() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    transport = FakeTransport(response=raw)
    client = EodhdClient(api_key="fake-eodhd-key", transport=transport)

    result = fetch_bulk_actions(client, date(2024, 2, 15))

    assert transport.calls == [
        "https://eodhd.com/api/eod-bulk-last-day/US?type=splits&date=2024-02-15"
    ]
    assert result.equals(parse_corporate_actions(raw))
