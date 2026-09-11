from datetime import date

import polars as pl

from dashboard.calc.universe import resolve_ticker_cik_as_of


def test_resolve_ticker_cik_as_of_known_at_t_not_latest_row() -> None:
    t = date(2024, 6, 15)
    cik = "0000000042"

    # Deux instantanés as_of pour le même cik : ticker OLDT connu depuis
    # 2024-01-01, renommé NEWT à partir de 2024-09-01 -- postérieur à t.
    # La ligne la plus récente du tableau (NEWT) ne doit jamais être
    # retenue pour une résolution effectuée à t : seule celle effective à
    # t (OLDT) doit l'être.
    ticker_cik = pl.DataFrame(
        [
            {"cik": cik, "ticker": "OLDT", "name": "Old Ticker Co", "as_of": date(2024, 1, 1)},
            {"cik": cik, "ticker": "NEWT", "name": "Old Ticker Co", "as_of": date(2024, 9, 1)},
        ]
    )

    resolved = resolve_ticker_cik_as_of(ticker_cik, t)

    row = resolved.filter(pl.col("cik") == cik).row(0, named=True)
    assert row["ticker"] == "OLDT"


def test_resolve_ticker_cik_as_of_uses_most_recent_snapshot_effective_at_t() -> None:
    t = date(2024, 6, 15)
    cik = "0000000042"

    # Trois instantanés, tous antérieurs ou égaux à t : le plus récent des
    # trois (2024-05-01) doit être retenu, pas le premier ni le plus ancien.
    ticker_cik = pl.DataFrame(
        [
            {"cik": cik, "ticker": "AAAT", "name": "Renamed Co", "as_of": date(2024, 1, 1)},
            {"cik": cik, "ticker": "BBBT", "name": "Renamed Co", "as_of": date(2024, 3, 1)},
            {"cik": cik, "ticker": "CCCT", "name": "Renamed Co", "as_of": date(2024, 5, 1)},
        ]
    )

    resolved = resolve_ticker_cik_as_of(ticker_cik, t)

    row = resolved.filter(pl.col("cik") == cik).row(0, named=True)
    assert row["ticker"] == "CCCT"
