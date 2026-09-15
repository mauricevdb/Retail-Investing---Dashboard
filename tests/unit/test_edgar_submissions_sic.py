import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.edgar_submissions import parse_sic_and_entity_type

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _load(cik10: str) -> dict:
    with open(GOLDEN / f"edgar_submissions_{cik10}.json", encoding="utf-8") as f:
        return json.load(f)


def test_edgar_submissions_parses_sic_and_entity_type() -> None:
    as_of = date(2024, 2, 15)

    alpha = parse_sic_and_entity_type(_load("0000000001"), as_of=as_of).row(0, named=True)
    assert alpha["sic"] == "3674"
    assert alpha["sic_description"] == "Semiconductors & Related Devices"
    assert alpha["entity_type"] == "operating"
    assert alpha["as_of"] == as_of

    gamma = parse_sic_and_entity_type(_load("0000000003"), as_of=as_of).row(0, named=True)
    assert gamma["sic"] == "6022"
    assert 6000 <= int(gamma["sic"]) <= 6799
    assert gamma["entity_type"] == "operating"

    delta = parse_sic_and_entity_type(_load("0000000004"), as_of=as_of).row(0, named=True)
    assert delta["sic"] == "6726"
    assert delta["entity_type"] == "investment company"
