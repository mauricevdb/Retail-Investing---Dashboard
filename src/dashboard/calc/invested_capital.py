from datetime import date

import polars as pl

from dashboard.calc.cash_bridge import resolve as resolve_cash
from dashboard.calc.debt_bridge import resolve as resolve_debt
from dashboard.calc.equity_bridge import resolve as resolve_equity


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> float | None:
    debt, _ = resolve_debt(facts, cik, end, t)
    equity, _ = resolve_equity(facts, cik, end, t)
    cash, _ = resolve_cash(facts, cik, end, t)
    if debt is None or equity is None or cash is None:
        return None
    return debt + equity - cash
