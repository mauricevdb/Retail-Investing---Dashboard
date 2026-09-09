import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.ebit_bridge import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_ebit_bridge_fallback_chain() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Primaire : Alpha porte us-gaap:OperatingIncomeLoss.
    alpha_value, alpha_tag = resolve(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_value == 500000000
    assert alpha_tag == "us-gaap:OperatingIncomeLoss"

    # Repli : Gamma n'a pas OperatingIncomeLoss, reconstruction depuis le
    # résultat net (40M) + impôts (10M) + intérêts (5M) = 55M.
    gamma_value, gamma_tag = resolve(_facts("0000000003"), cik="0000000003", end=end, t=t)
    assert gamma_value == 55000000
    assert gamma_tag == (
        "us-gaap:NetIncomeLoss + us-gaap:IncomeTaxExpenseBenefit + interest_bridge"
    )

    # Non calculable : Beta est IFRS, zéro fait après la liste blanche (T5).
    beta_value, beta_tag = resolve(_facts("0000000002"), cik="0000000002", end=end, t=t)
    assert beta_value is None
    assert beta_tag is None
