import json
from pathlib import Path

from dashboard.ingestion.edgar_client import EdgarClient
from dashboard.ingestion.edgar_facts import fetch_company_facts, parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_companyfacts_0000000001.json"


class FakeTransport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append(url)
        return self.response


def test_fetch_company_facts_calls_client_and_parses() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    transport = FakeTransport(response=raw)
    client = EdgarClient(user_agent="RI Dashboard test@example.com", transport=transport)

    result = fetch_company_facts(client, "0000000001")

    assert transport.calls == ["https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json"]
    assert result.equals(parse_company_facts(raw))
