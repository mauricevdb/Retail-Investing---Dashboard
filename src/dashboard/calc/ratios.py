from datetime import date

import polars as pl

from dashboard.calc.ebit_bridge import resolve as resolve_ebit
from dashboard.calc.ev import resolve as resolve_ev


def ev_to_ebit(
    market_cap: float, facts: pl.DataFrame, cik: str, end: date, t: date
) -> float | None:
    ebit, _ = resolve_ebit(facts, cik, end, t)
    if ebit is None or ebit <= 0:
        return None

    enterprise_value = resolve_ev(market_cap, facts, cik, end, t)
    if enterprise_value is None:
        return None

    return enterprise_value / ebit
