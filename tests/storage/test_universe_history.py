from datetime import date
from pathlib import Path

import polars as pl

from dashboard.storage.universe_history import append


def test_membership_table_append_only(tmp_path: Path) -> None:
    path = tmp_path / "universe_membership.parquet"

    day1 = pl.DataFrame(
        {"date": [date(2024, 2, 13)], "cik": ["0000000001"], "in_universe": [True]}
    )
    append(path, day1)

    day2 = pl.DataFrame(
        {"date": [date(2024, 2, 14)], "cik": ["0000000001"], "in_universe": [True]}
    )
    append(path, day2)

    day3 = pl.DataFrame(
        {"date": [date(2024, 2, 15)], "cik": ["0000000001"], "in_universe": [False]}
    )
    append(path, day3)

    stored = pl.read_parquet(path).sort("date")

    # Les trois jours restent présents et inchangés -- le troisième jour
    # (sortie de l'univers) n'a pas réécrit ou supprimé les précédents.
    assert stored.height == 3
    assert stored["date"].to_list() == [date(2024, 2, 13), date(2024, 2, 14), date(2024, 2, 15)]
    assert stored["in_universe"].to_list() == [True, True, False]
