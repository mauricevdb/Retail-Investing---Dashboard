import json
from pathlib import Path

from dashboard.ingestion.edgar_client import EdgarClient
from dashboard.ingestion.edgar_frames import (
    fetch_shares_outstanding_frame,
    parse_shares_outstanding_frame,
)

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_frames_shares_outstanding.json"


class FakeTransport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append(url)
        return self.response


def test_fetch_shares_outstanding_frame_calls_client_and_parses() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    transport = FakeTransport(response=raw)
    client = EdgarClient(user_agent="RI Dashboard test@example.com", transport=transport)

    result = fetch_shares_outstanding_frame(client, period="CY2024Q1I")

    assert transport.calls == [
        "https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/CY2024Q1I.json"
    ]
    expected = parse_shares_outstanding_frame(raw)
    assert result.equals(expected)
