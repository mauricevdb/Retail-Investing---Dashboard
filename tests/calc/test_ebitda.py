import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.ebitda import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_ebitda_composes_ebit_and_dna() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Les deux composantes sont calculables : EBIT 500M + D&A 50M = 550M.
    alpha_ebitda = resolve(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_ebitda == 550000000

    # EBIT reconstructible (55M, cf. T26) mais aucun tag de D&A -- non
    # calculable malgré une composante disponible.
    gamma_ebitda = resolve(_facts("0000000003"), cik="0000000003", end=end, t=t)
    assert gamma_ebitda is None
