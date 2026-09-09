from datetime import date

import polars as pl
import pytest

from dashboard.calc.universe import UniverseImplausibleSizeError, universe


def test_universe_failure_on_implausible_size() -> None:
    t = date(2024, 2, 20)

    tickers = [f"T{i:03d}" for i in range(10)]
    sic_codes = pl.DataFrame(
        {
            "ticker": tickers,
            # 9 titres artificiellement exclus (finance), 1 seul éligible.
            "sic": ["6022"] * 9 + ["3674"],
            "entity_type": ["operating company"] * 10,
        }
    )
    shares_pit = pl.DataFrame({"ticker": tickers, "shares_outstanding": [1_000_000.0] * 10})
    prices_adj = pl.DataFrame(
        [{"ticker": ticker, "date": t, "close_adj": 10.0} for ticker in tickers]
    )

    with pytest.raises(UniverseImplausibleSizeError):
        universe(
            shares_pit=shares_pit,
            prices_adj=prices_adj,
            sic_codes=sic_codes,
            hier_membership=set(),
            t=t,
            n=900,
            buffer=100,
            window=20,
            plausible_range=(700, 1100),
        )
