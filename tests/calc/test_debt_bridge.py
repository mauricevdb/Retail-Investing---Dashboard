import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.debt_bridge import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_debt_bridge_sums_available_components() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Alpha porte dette long terme (100M) et courante (20M) : somme = 120M.
    alpha_value, alpha_tag = resolve(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_value == 120000000
    assert alpha_tag == "us-gaap:LongTermDebtNoncurrent + us-gaap:LongTermDebtCurrent"

    # Non calculable : Beta est IFRS, aucune composante trouvée -- jamais zéro.
    beta_value, beta_tag = resolve(_facts("0000000002"), cik="0000000002", end=end, t=t)
    assert beta_value is None
    assert beta_tag is None
