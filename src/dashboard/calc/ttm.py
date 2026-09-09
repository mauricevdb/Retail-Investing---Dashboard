from datetime import date

import polars as pl

_QUARTERS = ("Q1", "Q2", "Q3", "Q4")


def ttm(facts: pl.DataFrame, cik: str, concept: str, t: date) -> float | None:
    quarterly = facts.filter(
        (pl.col("cik") == cik)
        & (pl.col("concept") == concept)
        & (pl.col("filed") <= t)
        & (pl.col("fiscal_period").is_in(_QUARTERS))
    )
    if quarterly.height == 0:
        return None

    latest_per_end = (
        quarterly.sort(["end", "filed"], descending=[False, True])
        .unique(subset=["end"], keep="first")
        .sort("end", descending=True)
    )
    last_four = latest_per_end.head(4)
    if last_four.height < 4:
        return None

    return last_four["value"].sum()
