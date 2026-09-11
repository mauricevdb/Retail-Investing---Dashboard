from datetime import date

import polars as pl

from dashboard.calc.point_in_time import resolve as resolve_pit
from dashboard.calc.point_in_time import resolve_detail


def _trace_long_term(facts: pl.DataFrame, cik: str, end: date, t: date) -> dict | None:
    primary = resolve_detail(facts, "LongTermDebtNoncurrent", cik, end, t)
    if primary is not None:
        return {**primary, "rank": 1}

    fallback = resolve_detail(facts, "LongTermDebt", cik, end, t)
    if fallback is not None:
        return {**fallback, "rank": 2}

    return None


def _trace_current(facts: pl.DataFrame, cik: str, end: date, t: date) -> dict | None:
    primary = resolve_detail(facts, "LongTermDebtCurrent", cik, end, t)
    if primary is not None:
        return {**primary, "rank": 1}

    fallback = resolve_detail(facts, "DebtCurrent", cik, end, t)
    if fallback is not None:
        return {**fallback, "rank": 2}

    return None


def _trace_short_term_borrowings(facts: pl.DataFrame, cik: str, end: date, t: date) -> dict | None:
    detail = resolve_detail(facts, "ShortTermBorrowings", cik, end, t)
    if detail is not None:
        return {**detail, "rank": 1}

    return None


def trace(facts: pl.DataFrame, cik: str, end: date, t: date) -> list[dict]:
    components = [
        _trace_long_term(facts, cik, end, t),
        _trace_current(facts, cik, end, t),
        _trace_short_term_borrowings(facts, cik, end, t),
    ]
    return [component for component in components if component is not None]


def _resolve_long_term(
    facts: pl.DataFrame, cik: str, end: date, t: date
) -> tuple[float | None, str | None]:
    primary = resolve_pit(facts, cik, "LongTermDebtNoncurrent", end, t)
    if primary is not None:
        return primary, "us-gaap:LongTermDebtNoncurrent"

    fallback = resolve_pit(facts, cik, "LongTermDebt", end, t)
    if fallback is not None:
        return fallback, "us-gaap:LongTermDebt"

    return None, None


def _resolve_current(
    facts: pl.DataFrame, cik: str, end: date, t: date
) -> tuple[float | None, str | None]:
    primary = resolve_pit(facts, cik, "LongTermDebtCurrent", end, t)
    if primary is not None:
        return primary, "us-gaap:LongTermDebtCurrent"

    fallback = resolve_pit(facts, cik, "DebtCurrent", end, t)
    if fallback is not None:
        return fallback, "us-gaap:DebtCurrent"

    return None, None


def _resolve_short_term_borrowings(
    facts: pl.DataFrame, cik: str, end: date, t: date
) -> tuple[float | None, str | None]:
    value = resolve_pit(facts, cik, "ShortTermBorrowings", end, t)
    if value is not None:
        return value, "us-gaap:ShortTermBorrowings"

    return None, None


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> tuple[float | None, str | None]:
    components = [
        _resolve_long_term(facts, cik, end, t),
        _resolve_current(facts, cik, end, t),
        _resolve_short_term_borrowings(facts, cik, end, t),
    ]
    found = [(value, tag) for value, tag in components if value is not None]
    if not found:
        return None, None

    total = sum(value for value, _ in found)
    tag_used = " + ".join(tag for _, tag in found)
    return total, tag_used
