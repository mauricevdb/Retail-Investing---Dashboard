import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.edgar_client import EdgarClient
from dashboard.ingestion.edgar_tickers import fetch_company_tickers, parse_company_tickers

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_company_tickers.json"


class FakeTransport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append(url)
        return self.response


def test_fetch_company_tickers_calls_client_and_parses() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    transport = FakeTransport(response=raw)
    client = EdgarClient(user_agent="RI Dashboard test@example.com", transport=transport)
    as_of = date(2024, 2, 15)

    result = fetch_company_tickers(client, as_of)

    assert transport.calls == ["https://www.sec.gov/files/company_tickers.json"]
    expected = parse_company_tickers(raw, as_of)
    assert result.equals(expected)
