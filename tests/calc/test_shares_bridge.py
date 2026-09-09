import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.shares_bridge import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_shares_bridge_fallback_chain() -> None:
    t = date(2024, 3, 1)

    # Niveau 1 : Alpha porte dei:EntityCommonStockSharesOutstanding.
    alpha_value, alpha_tag = resolve(_facts("0000000001"), cik="0000000001", t=t)
    assert alpha_value == 100000000
    assert alpha_tag == "dei:EntityCommonStockSharesOutstanding"

    # Niveau 2 : Gamma n'a pas le tag de couverture, seulement le bilan.
    gamma_value, gamma_tag = resolve(_facts("0000000003"), cik="0000000003", t=t)
    assert gamma_value == 50000000
    assert gamma_tag == "us-gaap:CommonStockSharesOutstanding"

    # Niveau 3 : Delta n'a ni l'un ni l'autre, seulement émises moins trésorerie.
    delta_value, delta_tag = resolve(_facts("0000000004"), cik="0000000004", t=t)
    assert delta_value == 18000000
    assert delta_tag == "us-gaap:CommonStockSharesIssued - us-gaap:TreasuryStockShares"

    # Non calculable : Beta est IFRS, donc zéro fait après la liste blanche (T5).
    beta_value, beta_tag = resolve(_facts("0000000002"), cik="0000000002", t=t)
    assert beta_value is None
    assert beta_tag is None
