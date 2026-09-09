from datetime import date

import polars as pl


def resolve(facts: pl.DataFrame, cik: str, concept: str, end: date, t: date) -> float | None:
    candidates = facts.filter(
        (pl.col("cik") == cik)
        & (pl.col("concept") == concept)
        & (pl.col("end") == end)
        & (pl.col("filed") <= t)
    )
    if candidates.height == 0:
        return None
    latest = candidates.sort("filed", descending=True).row(0, named=True)
    return latest["value"]
