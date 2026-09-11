import json
from datetime import date
from pathlib import Path

from dashboard.calc.point_in_time import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_companyfacts_0000000001.json"


def test_restatement_latest_value_history_preserved() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)
    facts = parse_company_facts(raw)

    before = resolve(
        facts,
        cik="0000000001",
        concept="NetIncomeLoss",
        end=date(2023, 12, 31),
        t=date(2024, 3, 1),
    )
    after = resolve(
        facts,
        cik="0000000001",
        concept="NetIncomeLoss",
        end=date(2023, 12, 31),
        t=date(2024, 4, 1),
    )

    assert before == 300000000
    assert after == 280000000
    assert before != after

    net_income_2023 = facts.filter(
        (facts["concept"] == "NetIncomeLoss") & (facts["end"] == date(2023, 12, 31))
    )
    assert net_income_2023.height == 2
    assert set(net_income_2023["value"]) == {300000000, 280000000}
