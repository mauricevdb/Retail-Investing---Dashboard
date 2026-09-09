import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.fcf_bridge import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_fcf_bridge_fallback_chain() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Primaire : Alpha porte CFO et CapEx primaires. FCF = 200M - 30M = 170M.
    alpha_value, alpha_tag = resolve(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_value == 170000000
    assert alpha_tag == (
        "us-gaap:NetCashProvidedByUsedInOperatingActivities - "
        "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment"
    )

    # Repli CapEx : Gamma a le CFO primaire mais pas le CapEx primaire.
    # FCF = 60M - 8M = 52M.
    gamma_value, gamma_tag = resolve(_facts("0000000003"), cik="0000000003", end=end, t=t)
    assert gamma_value == 52000000
    assert gamma_tag == (
        "us-gaap:NetCashProvidedByUsedInOperatingActivities - "
        "us-gaap:PaymentsToAcquireProductiveAssets"
    )

    # Repli CFO : Delta a le CapEx primaire mais pas le CFO primaire.
    # FCF = 25M - 5M = 20M.
    delta_value, delta_tag = resolve(_facts("0000000004"), cik="0000000004", end=end, t=t)
    assert delta_value == 20000000
    assert delta_tag == (
        "us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations - "
        "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment"
    )

    # Non calculable : Beta est IFRS, zéro fait après la liste blanche (T5).
    beta_value, beta_tag = resolve(_facts("0000000002"), cik="0000000002", end=end, t=t)
    assert beta_value is None
    assert beta_tag is None
