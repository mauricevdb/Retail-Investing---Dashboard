from datetime import date

import polars as pl

from dashboard.calc.point_in_time import resolve as resolve_pit


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
