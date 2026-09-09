import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.net_debt import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_net_debt_formula() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Les deux composantes sont calculables : dette 120M - trésorerie 80M = 40M.
    alpha_net_debt = resolve(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_net_debt == 40000000

    # Trésorerie calculable (15M, cf. T30) mais aucune composante de dette
    # trouvée pour Gamma -- non calculable malgré une composante disponible.
    gamma_net_debt = resolve(_facts("0000000003"), cik="0000000003", end=end, t=t)
    assert gamma_net_debt is None
