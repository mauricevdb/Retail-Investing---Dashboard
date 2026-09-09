from datetime import date

import polars as pl

from dashboard.calc.point_in_time import resolve as resolve_pit


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> tuple[float | None, str | None]:
    primary = resolve_pit(facts, cik, "CashAndCashEquivalentsAtCarryingValue", end, t)
    if primary is not None:
        return primary, "us-gaap:CashAndCashEquivalentsAtCarryingValue"

    fallback = resolve_pit(facts, cik, "Cash", end, t)
    if fallback is not None:
        return fallback, "us-gaap:Cash"

    return None, None
