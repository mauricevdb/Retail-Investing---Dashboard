import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.ev import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_ev_formula() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Calculable : capitalisation 1000M + dette nette (Alpha, 40M, cf. T32)
    # = 1040M.
    alpha_ev = resolve(
        market_cap=1_000_000_000, facts=_facts("0000000001"), cik="0000000001", end=end, t=t
    )
    assert alpha_ev == 1_040_000_000

    # Non calculable : Gamma a une trésorerie connue mais aucune composante
    # de dette trouvée (T32) -- dette nette non calculable, donc EV aussi,
    # quelle que soit la capitalisation.
    gamma_ev = resolve(
        market_cap=500_000_000, facts=_facts("0000000003"), cik="0000000003", end=end, t=t
    )
    assert gamma_ev is None
