import json
from datetime import date
from pathlib import Path

from dashboard.calc.point_in_time import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_companyfacts_0000000001.json"


def test_point_in_time_rejects_future_filed() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)
    facts = parse_company_facts(raw)

    # NetIncomeLoss end=2023-12-31 a deux dépôts : 300M filed 2024-02-15,
    # puis 280M (retraitement) filed 2024-03-20.
    value = resolve(
        facts,
        cik="0000000001",
        concept="NetIncomeLoss",
        end=date(2023, 12, 31),
        t=date(2024, 3, 1),
    )

    assert value == 300000000
