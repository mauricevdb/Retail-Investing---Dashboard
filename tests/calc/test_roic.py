import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.roic import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_roic_formula_and_non_positive_invested_capital() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Cas normal : Alpha, NOPAT 375M (T39) / capital investi 290M (T33).
    alpha_roic = resolve(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_roic == 375000000 / 290000000

    # Capital investi <= 0 : Delta, -25M (T33) -- non calculable, quel que
    # soit NOPAT.
    delta_roic = resolve(_facts("0000000004"), cik="0000000004", end=end, t=t)
    assert delta_roic is None
