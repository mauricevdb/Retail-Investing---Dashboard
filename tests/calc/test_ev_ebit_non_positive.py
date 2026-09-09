import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.ratios import ev_to_ebit
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_ev_ebit_non_calculable_on_non_positive_ebit() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Cas calculable, pour ne pas tester une fonction qui renverrait
    # toujours None : Alpha, EBIT 500M positif, EV = 2000M + 40M = 2040M.
    alpha_value = ev_to_ebit(market_cap=2_000_000_000, facts=_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_value == 2040000000 / 500000000

    # Non calculable : Delta est en perte opérationnelle (EBIT = -15M) --
    # aucune valeur numérique, quelle que soit la capitalisation.
    delta_value = ev_to_ebit(market_cap=999_999_999, facts=_facts("0000000004"), cik="0000000004", end=end, t=t)
    assert delta_value is None
