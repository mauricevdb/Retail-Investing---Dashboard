import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.invested_capital import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_invested_capital_formula_and_non_positive_case() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Cas positif : Alpha, dette 120M + capitaux propres 250M - trésorerie
    # 80M = 290M.
    alpha_value = resolve(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_value == 290000000

    # Cas négatif : Delta, dette 5M + capitaux propres (-20M) - trésorerie
    # 10M = -25M -- toutes les composantes sont calculables, le résultat
    # est bien un nombre négatif, pas None. C'est à calc.roic (T40) de le
    # traiter comme non calculable, pas à invested_capital lui-même.
    delta_value = resolve(_facts("0000000004"), cik="0000000004", end=end, t=t)
    assert delta_value == -25000000
