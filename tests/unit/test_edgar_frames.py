import json
from pathlib import Path

from dashboard.ingestion.edgar_frames import parse_shares_outstanding_frame

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_frames_shares_outstanding.json"


def test_parse_shares_outstanding_frame() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    parsed = parse_shares_outstanding_frame(raw)

    assert parsed.height == 2
    # cik complété à 10 chiffres, comme edgar_tickers.parse_company_tickers
    # (T2) -- même convention dans tout le dépôt.
    assert set(parsed["cik"].to_list()) == {"0000000001", "0000000002"}

    alpha = parsed.filter(parsed["cik"] == "0000000001").row(0, named=True)
    assert alpha["end"].isoformat() == "2024-02-29"
    assert alpha["value"] == 35427056.0

    beta = parsed.filter(parsed["cik"] == "0000000002").row(0, named=True)
    assert beta["end"].isoformat() == "2024-03-31"
    assert beta["value"] == 1739633759.0
