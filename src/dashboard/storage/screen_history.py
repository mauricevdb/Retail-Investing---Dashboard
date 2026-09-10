from pathlib import Path

import polars as pl


class ScreenHistoryAlreadyWrittenError(Exception):
    pass


def append(path: Path, rows: pl.DataFrame) -> None:
    if path.exists():
        existing = pl.read_parquet(path)
        overlap = existing.join(rows, on=["date", "cik"], how="inner")
        if overlap.height > 0:
            raise ScreenHistoryAlreadyWrittenError(
                f"lignes déjà présentes pour (date, cik) : "
                f"{overlap.select(['date', 'cik']).rows()}"
            )
        combined = pl.concat([existing, rows])
    else:
        combined = rows

    combined.write_parquet(path)
