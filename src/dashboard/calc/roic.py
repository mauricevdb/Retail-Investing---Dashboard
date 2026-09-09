from datetime import date

import polars as pl

from dashboard.calc.invested_capital import resolve as resolve_invested_capital
from dashboard.calc.nopat import resolve as resolve_nopat


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> float | None:
    nopat, _, _ = resolve_nopat(facts, cik, end, t)
    invested_capital = resolve_invested_capital(facts, cik, end, t)
    if nopat is None or invested_capital is None or invested_capital <= 0:
        return None
    return nopat / invested_capital
