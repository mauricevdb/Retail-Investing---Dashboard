import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_companyfacts_0000000001.json"


def test_edgar_facts_ingestion_no_dedup_on_restatement() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    df = parse_company_facts(raw)
    net_income_2023 = df.filter(
        (df["concept"] == "NetIncomeLoss") & (df["end"] == date(2023, 12, 31))
    )

    assert net_income_2023.height == 2
    assert set(net_income_2023["accn"]) == {
        "0000000001-24-000010",
        "0000000001-24-000003",
    }
    assert set(net_income_2023["filed"]) == {date(2024, 2, 15), date(2024, 3, 20)}
    assert set(net_income_2023["value"]) == {300000000, 280000000}
