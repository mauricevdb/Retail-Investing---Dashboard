from datetime import date

import polars as pl

from dashboard.calc.point_in_time import resolve as resolve_pit


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> tuple[float | None, str | None]:
    primary = resolve_pit(facts, cik, "StockholdersEquity", end, t)
    if primary is not None:
        return primary, "us-gaap:StockholdersEquity"

    fallback = resolve_pit(
        facts, cik, "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", end, t
    )
    if fallback is not None:
        return (
            fallback,
            "us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
        )

    return None, None
