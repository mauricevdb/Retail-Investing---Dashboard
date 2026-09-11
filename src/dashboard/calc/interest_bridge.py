from datetime import date

import polars as pl

from dashboard.calc.point_in_time import resolve as resolve_pit
from dashboard.calc.point_in_time import resolve_detail


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> float | None:
    primary = resolve_pit(facts, cik, "InterestExpense", end, t)
    if primary is not None:
        return primary

    debt = resolve_pit(facts, cik, "InterestExpenseDebt", end, t)
    if debt is not None:
        return debt

    net = resolve_pit(facts, cik, "InterestIncomeExpenseNet", end, t)
    if net is not None:
        return -1 * net

    return None


def trace(facts: pl.DataFrame, cik: str, end: date, t: date) -> dict | None:
    primary = resolve_detail(facts, "InterestExpense", cik, end, t)
    if primary is not None:
        return {**primary, "rank": 1}

    debt = resolve_detail(facts, "InterestExpenseDebt", cik, end, t)
    if debt is not None:
        return {**debt, "rank": 2}

    net = resolve_detail(facts, "InterestIncomeExpenseNet", cik, end, t)
    if net is not None:
        return {**net, "rank": 3}

    return None
