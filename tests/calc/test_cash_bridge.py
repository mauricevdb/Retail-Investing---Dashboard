import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.cash_bridge import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_cash_bridge_fallback_chain() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Primaire : Alpha porte CashAndCashEquivalentsAtCarryingValue.
    alpha_value, alpha_tag = resolve(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_value == 80000000
    assert alpha_tag == "us-gaap:CashAndCashEquivalentsAtCarryingValue"

    # Repli : Gamma n'a pas le tag primaire, seulement Cash.
    gamma_value, gamma_tag = resolve(_facts("0000000003"), cik="0000000003", end=end, t=t)
    assert gamma_value == 15000000
    assert gamma_tag == "us-gaap:Cash"

    # Non calculable : Beta est IFRS, zéro fait après la liste blanche (T5).
    beta_value, beta_tag = resolve(_facts("0000000002"), cik="0000000002", end=end, t=t)
    assert beta_value is None
    assert beta_tag is None
