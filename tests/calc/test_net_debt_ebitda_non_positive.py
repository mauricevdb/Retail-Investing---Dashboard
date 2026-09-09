import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.ratios import net_debt_to_ebitda
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_net_debt_ebitda_non_calculable_on_non_positive_ebitda() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Cas calculable, pour ne pas tester une fonction qui renverrait
    # toujours None : Alpha, dette nette 40M (T32) / EBITDA 550M (T27).
    alpha_value = net_debt_to_ebitda(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_value == 40000000 / 550000000

    # Non calculable : Delta a un EBITDA calculable mais négatif
    # (EBIT -15M + D&A 5M = -10M), pas seulement une donnée manquante.
    delta_value = net_debt_to_ebitda(_facts("0000000004"), cik="0000000004", end=end, t=t)
    assert delta_value is None
