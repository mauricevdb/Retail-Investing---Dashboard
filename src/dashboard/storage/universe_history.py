from pathlib import Path

import polars as pl


def append(path: Path, rows: pl.DataFrame) -> None:
    if path.exists():
        existing = pl.read_parquet(path)
        combined = pl.concat([existing, rows])
    else:
        combined = rows

    combined.write_parquet(path)
