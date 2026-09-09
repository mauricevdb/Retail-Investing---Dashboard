from datetime import date

import polars as pl


def normalized_5y(facts: pl.DataFrame, cik: str, concept: str, t: date) -> float | None:
    annual = facts.filter(
        (pl.col("cik") == cik)
        & (pl.col("concept") == concept)
        & (pl.col("filed") <= t)
        & (pl.col("fiscal_period") == "FY")
    )
    if annual.height == 0:
        return None

    latest_per_year = (
        annual.sort(["fiscal_year", "filed"], descending=[False, True])
        .unique(subset=["fiscal_year"], keep="first")
        .sort("fiscal_year", descending=True)
        .head(5)
    )

    return latest_per_year["value"].median()
