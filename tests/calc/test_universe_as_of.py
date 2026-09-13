from datetime import date

import polars as pl

from dashboard.calc.universe import universe


def test_universe_resolves_sic_known_at_t_not_latest_row() -> None:
    t = date(2024, 6, 15)

    # Deux instantanés as_of pour le même titre : SIC opérationnel connu
    # depuis 2024-01-01, puis rebasculé en SIC finance depuis 2024-05-01 --
    # antérieur à t, donc effectif à t. Le titre doit être exclu à t, même
    # si une ligne antérieure (non filtrée par date) le ferait passer.
    sic_codes = pl.DataFrame(
        [
            {
                "ticker": "OPCO",
                "sic": "3674",
                "entity_type": "operating",
                "as_of": date(2024, 1, 1),
            },
            {
                "ticker": "OPCO",
                "sic": "6022",
                "entity_type": "operating",
                "as_of": date(2024, 5, 1),
            },
        ]
    )
    shares_pit = pl.DataFrame({"ticker": ["OPCO"], "shares_outstanding": [1_000_000.0]})
    prices_adj = pl.DataFrame([{"ticker": "OPCO", "date": t, "close_adj": 10.0}])

    membership = universe(
        shares_pit=shares_pit,
        prices_adj=prices_adj,
        sic_codes=sic_codes,
        hier_membership=set(),
        t=t,
        n=1,
        buffer=0,
        plausible_range=(0, 1),
    )

    # SIC 6022 (finance) est effectif à t (as_of 2024-05-01 <= t) : OPCO
    # est exclu, même si une ligne antérieure du tableau (SIC opérationnel)
    # le ferait passer si elle n'était pas filtrée par date.
    assert membership.filter(pl.col("ticker") == "OPCO").height == 0
