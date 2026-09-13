import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.edgar_client import EdgarClient
from dashboard.ingestion.edgar_submissions import (
    fetch_submissions,
    parse_filings,
    parse_sic_and_entity_type,
)

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_submissions_0000000001.json"


class FakeTransport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append(url)
        return self.response


def test_fetch_submissions_single_call_produces_both_tables() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    transport = FakeTransport(response=raw)
    client = EdgarClient(user_agent="RI Dashboard test@example.com", transport=transport)
    as_of = date(2024, 2, 15)

    filings, sic = fetch_submissions(client, "0000000001", as_of)

    assert transport.calls == ["https://data.sec.gov/submissions/CIK0000000001.json"]
    assert filings.equals(parse_filings(raw))
    assert sic.equals(parse_sic_and_entity_type(raw, as_of))
