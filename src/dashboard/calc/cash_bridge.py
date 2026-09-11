from datetime import date

import polars as pl

from dashboard.calc.point_in_time import resolve as resolve_pit
from dashboard.calc.point_in_time import resolve_detail


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> tuple[float | None, str | None]:
    primary = resolve_pit(facts, cik, "CashAndCashEquivalentsAtCarryingValue", end, t)
    if primary is not None:
        return primary, "us-gaap:CashAndCashEquivalentsAtCarryingValue"

    fallback = resolve_pit(facts, cik, "Cash", end, t)
    if fallback is not None:
        return fallback, "us-gaap:Cash"

    return None, None


def trace(facts: pl.DataFrame, cik: str, end: date, t: date) -> list[dict]:
    primary = resolve_detail(facts, "CashAndCashEquivalentsAtCarryingValue", cik, end, t)
    if primary is not None:
        return [{**primary, "rank": 1}]

    fallback = resolve_detail(facts, "Cash", cik, end, t)
    if fallback is not None:
        return [{**fallback, "rank": 2}]

    return []
