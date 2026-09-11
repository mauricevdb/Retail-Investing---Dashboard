from datetime import date, timedelta

import polars as pl

from dashboard.calc.universe import rank_by_smoothed_market_cap


def test_universe_ranking_uses_smoothed_market_cap() -> None:
    start = date(2024, 1, 1)
    t = start + timedelta(days=19)  # fenêtre de 20 séances, jours 0 à 19.

    # AAAA : stable à 90 pendant 19 jours, puis pic anormal à 300 le jour t.
    aaaa_prices = [
        {"ticker": "AAAA", "date": start + timedelta(days=i), "close_adj": 90.0} for i in range(19)
    ] + [{"ticker": "AAAA", "date": t, "close_adj": 300.0}]

    # BBBB : stable à 110 sur les 20 jours, aucune anomalie.
    bbbb_prices = [
        {"ticker": "BBBB", "date": start + timedelta(days=i), "close_adj": 110.0} for i in range(20)
    ]

    prices_adj = pl.DataFrame(aaaa_prices + bbbb_prices)
    shares_pit = pl.DataFrame(
        {"ticker": ["AAAA", "BBBB"], "shares_outstanding": [10_000_000.0, 10_000_000.0]}
    )

    ranked = rank_by_smoothed_market_cap(shares_pit, prices_adj, t=t, window=20)

    # Moyenne AAAA = (19*90 + 300) / 20 = 100.5 ; moyenne BBBB = 110.
    # Le cours du jour seul (300 > 110) mettrait AAAA en tête à tort ;
    # la moyenne lissée doit mettre BBBB en tête.
    bbbb_rank = ranked.filter(pl.col("ticker") == "BBBB").row(0, named=True)["rank"]
    aaaa_rank = ranked.filter(pl.col("ticker") == "AAAA").row(0, named=True)["rank"]
    assert bbbb_rank == 1
    assert aaaa_rank == 2
