from datetime import date
from pathlib import Path

import polars as pl
import pytest

from dashboard.calc.universe import UniverseImplausibleSizeError
from dashboard.pipeline.daily_run import run_daily


def test_universe_failure_halts_pipeline(tmp_path: Path) -> None:
    universe_history_path = tmp_path / "universe_membership.parquet"

    # Cas d'univers implausible de T37 : l'essentiel des titres est
    # artificiellement exclu (9 sur 10 en finance).
    tickers = [f"T{i:03d}" for i in range(10)]
    sic_codes = pl.DataFrame(
        {
            "ticker": tickers,
            "sic": ["6022"] * 9 + ["3674"],
            "entity_type": ["operating"] * 10,
            "as_of": [date(2024, 1, 1)] * 10,
        }
    )
    shares_pit = pl.DataFrame({"ticker": tickers, "shares_outstanding": [1_000_000.0] * 10})
    t = date(2024, 2, 20)
    prices_adj = pl.DataFrame(
        [{"ticker": ticker, "date": t, "close_adj": 10.0} for ticker in tickers]
    )

    with pytest.raises(UniverseImplausibleSizeError):
        run_daily(
            shares_pit=shares_pit,
            prices_adj=prices_adj,
            sic_codes=sic_codes,
            hier_membership=set(),
            t=t,
            universe_history_path=universe_history_path,
        )

    # Le traitement s'est arrêté avant toute écriture -- aucune ligne n'est
    # ajoutée à universe_membership.parquet pour ce jour.
    assert not universe_history_path.exists()
