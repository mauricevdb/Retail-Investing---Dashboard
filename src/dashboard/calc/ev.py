from datetime import date

import polars as pl

from dashboard.calc.net_debt import resolve as resolve_net_debt


def resolve(market_cap: float, facts: pl.DataFrame, cik: str, end: date, t: date) -> float | None:
    net_debt = resolve_net_debt(facts, cik, end, t)
    if net_debt is None:
        return None
    return market_cap + net_debt
