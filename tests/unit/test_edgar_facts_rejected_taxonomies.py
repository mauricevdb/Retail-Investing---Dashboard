import json
from pathlib import Path

from dashboard.ingestion.edgar_facts import count_rejected_taxonomies

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _load(cik10: str) -> dict:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        return json.load(f)


def test_edgar_facts_counts_rejected_taxonomies() -> None:
    beta_counts = count_rejected_taxonomies(_load("0000000002"))
    assert beta_counts == {"ifrs-full": 1}

    alpha_counts = count_rejected_taxonomies(_load("0000000001"))
    assert alpha_counts == {}
