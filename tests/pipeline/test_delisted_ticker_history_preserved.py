from datetime import date
from pathlib import Path

import polars as pl

from dashboard.storage.screen_history import append as append_screen_history
from dashboard.storage.universe_history import append as append_universe_history


def test_delisted_ticker_history_preserved(tmp_path: Path) -> None:
    fundamentals_path = tmp_path / "fundamentals_raw.parquet"
    screen_path = tmp_path / "screen_results.parquet"
    universe_path = tmp_path / "universe_membership.parquet"

    cik = "0000000001"
    day1 = date(2024, 2, 15)
    day2 = date(2024, 2, 16)

    # Jour 1 : le titre est dans l'univers, avec des fondamentaux et un
    # résultat de screen.
    fundamentals_day1 = pl.DataFrame(
        {
            "cik": [cik],
            "concept": ["NetIncomeLoss"],
            "end": [date(2023, 12, 31)],
            "value": [300_000_000.0],
        }
    )
    fundamentals_day1.write_parquet(fundamentals_path)

    append_screen_history(
        screen_path, pl.DataFrame({"date": [day1], "cik": [cik], "ev_ebit": [5.0]})
    )
    append_universe_history(
        universe_path, pl.DataFrame({"date": [day1], "cik": [cik], "in_universe": [True]})
    )

    # Jour 2 : le titre sort de l'univers -- pas de nouvelle ligne de
    # screen (il n'est plus dans l'écran), seulement une ligne
    # d'appartenance signalant sa sortie.
    append_universe_history(
        universe_path, pl.DataFrame({"date": [day2], "cik": [cik], "in_universe": [False]})
    )

    # Les fondamentaux, l'historique de screen et l'historique
    # d'appartenance du jour 1 restent tous lisibles et inchangés.
    fundamentals_after = pl.read_parquet(fundamentals_path)
    assert fundamentals_after.equals(fundamentals_day1)

    screen_after = pl.read_parquet(screen_path)
    assert screen_after.height == 1
    assert screen_after["date"].to_list() == [day1]

    universe_after = pl.read_parquet(universe_path)
    assert universe_after.height == 2
    assert universe_after.filter(pl.col("date") == day1)["in_universe"].to_list() == [True]
    assert universe_after.filter(pl.col("date") == day2)["in_universe"].to_list() == [False]
