from pathlib import Path

import polars as pl


def append(path: Path, rows: pl.DataFrame) -> None:
    if path.exists():
        # Plusieurs lignes pour un même (cik, concept, end) sont attendues
        # -- un retraitement dépose une nouvelle valeur, il n'écrase jamais
        # la précédente (invariant 2, même garantie que T6 côté calcul).
        combined = pl.concat([pl.read_parquet(path), rows])
    else:
        combined = rows

    combined.write_parquet(path)
