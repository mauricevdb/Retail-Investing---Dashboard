from datetime import date

import polars as pl

from dashboard.calc.cash_bridge import resolve as resolve_cash
from dashboard.calc.debt_bridge import resolve as resolve_debt


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> float | None:
    debt, _ = resolve_debt(facts, cik, end, t)
    cash, _ = resolve_cash(facts, cik, end, t)
    if debt is None or cash is None:
        return None
    return debt - cash
