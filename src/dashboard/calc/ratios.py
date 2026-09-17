from datetime import date

import polars as pl

from dashboard.calc.ebit_bridge import resolve_ttm as resolve_ebit_ttm
from dashboard.calc.ebitda import resolve as resolve_ebitda
from dashboard.calc.ev import resolve as resolve_ev
from dashboard.calc.fcf_bridge import resolve as resolve_fcf
from dashboard.calc.net_debt import resolve as resolve_net_debt
from dashboard.calc.roic import resolve as resolve_roic


def ev_to_ebit(
    market_cap: float, facts: pl.DataFrame, cik: str, end: date, t: date
) -> float | None:
    # EV/EBIT (indicateur primaire, critère 12) utilise l'EBIT sur les
    # quatre derniers trimestres connus (TTM) quand disponible, avec repli
    # explicite sur la chaîne point-in-time existante sinon (T91) --
    # jamais les autres indicateurs (ROIC, dette nette/EBITDA), qui gardent
    # leur EBIT point-in-time inchangé (décidé avec l'utilisateur, ADR 0004).
    ebit, _ = resolve_ebit_ttm(facts, cik, end, t)
    if ebit is None or ebit <= 0:
        return None

    enterprise_value = resolve_ev(market_cap, facts, cik, end, t)
    if enterprise_value is None:
        return None

    return enterprise_value / ebit


def net_debt_to_ebitda(facts: pl.DataFrame, cik: str, end: date, t: date) -> float | None:
    ebitda = resolve_ebitda(facts, cik, end, t)
    if ebitda is None or ebitda <= 0:
        return None

    net_debt = resolve_net_debt(facts, cik, end, t)
    if net_debt is None:
        return None

    return net_debt / ebitda


def fcf_yield(market_cap: float, facts: pl.DataFrame, cik: str, end: date, t: date) -> float | None:
    fcf, _ = resolve_fcf(facts, cik, end, t)
    if fcf is None:
        return None

    enterprise_value = resolve_ev(market_cap, facts, cik, end, t)
    if enterprise_value is None:
        return None

    return fcf / enterprise_value


INDICATOR_KEYS = (
    "ev_ebit",
    "fcf_yield",
    "roic",
    "net_debt_ebitda",
    "pct_own_history",
    "pct_sector",
)


def indicator_status(
    market_cap: float,
    facts: pl.DataFrame,
    cik: str,
    end: date,
    t: date,
    pct_own_history: float | None,
    pct_sector: float | None,
    currency: str = "USD",
) -> dict[str, float | str | None]:
    return {
        "ev_ebit": ev_to_ebit(market_cap, facts, cik, end, t),
        "fcf_yield": fcf_yield(market_cap, facts, cik, end, t),
        "roic": resolve_roic(facts, cik, end, t),
        "net_debt_ebitda": net_debt_to_ebitda(facts, cik, end, t),
        "pct_own_history": pct_own_history,
        "pct_sector": pct_sector,
        "currency": currency,
    }


def price_variation(prices_adj: pl.DataFrame, ticker: str, date_today: date) -> float | None:
    rows = (
        prices_adj.filter((pl.col("ticker") == ticker) & (pl.col("date") <= date_today))
        .sort("date", descending=True)
        .head(2)
    )
    if rows.height < 2:
        return None

    return rows["close_adj"][0] / rows["close_adj"][1]


def coverage_rate(statuses: list[dict[str, float | None]]) -> dict[str, tuple[int, int]]:
    if not statuses:
        return {}

    total = len(statuses)
    return {
        indicator: (sum(1 for status in statuses if status[indicator] is not None), total)
        for indicator in INDICATOR_KEYS
    }
