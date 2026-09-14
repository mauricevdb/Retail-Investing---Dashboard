from pathlib import Path

import duckdb
import polars as pl


class ScreenResultsUnavailableError(Exception):
    pass


def read_latest_screen(path: Path) -> pl.DataFrame:
    if not path.exists():
        raise ScreenResultsUnavailableError(f"fichier absent : {path}")

    result = duckdb.sql(
        "SELECT * FROM read_parquet(?) WHERE date = (SELECT max(date) FROM read_parquet(?))",
        params=[str(path), str(path)],
    ).pl()

    if result.height == 0:
        # Un fichier vide ne donne aucun jour à comparer -- jamais un écran
        # sans titre présenté comme un résultat normal (invariant 7).
        raise ScreenResultsUnavailableError(f"aucune ligne dans : {path}")

    return result


def read_facts_for_cik(path: Path, cik: str) -> pl.DataFrame:
    if not path.exists():
        raise ScreenResultsUnavailableError(f"fichier absent : {path}")

    return duckdb.sql(
        "SELECT * FROM read_parquet(?) WHERE cik = ?",
        params=[str(path), cik],
    ).pl()
