from datetime import date

import polars as pl

from dashboard.calc.ebit_bridge import resolve as resolve_ebit
from dashboard.calc.point_in_time import resolve as resolve_pit

_PRETAX_INCOME_TAG = (
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"
)
_CALCULATED_SOURCE = "us-gaap:IncomeTaxExpenseBenefit / résultat avant impôt, plafonné [0%, 50%]"


def _resolve_pretax_income(facts: pl.DataFrame, cik: str, end: date, t: date) -> float | None:
    primary = resolve_pit(facts, cik, _PRETAX_INCOME_TAG, end, t)
    if primary is not None:
        return primary

    net_income = resolve_pit(facts, cik, "NetIncomeLoss", end, t)
    tax = resolve_pit(facts, cik, "IncomeTaxExpenseBenefit", end, t)
    if net_income is not None and tax is not None:
        return net_income + tax

    return None


def resolve_tax_rate(
    facts: pl.DataFrame,
    cik: str,
    end: date,
    t: date,
    default_tax_rate: float = 0.21,
    rate_band: tuple[float, float] = (0.0, 0.5),
) -> tuple[float, str]:
    pretax_income = _resolve_pretax_income(facts, cik, end, t)
    tax_expense = resolve_pit(facts, cik, "IncomeTaxExpenseBenefit", end, t)

    if pretax_income is not None and pretax_income > 0 and tax_expense is not None:
        low, high = rate_band
        effective_rate = tax_expense / pretax_income
        capped_rate = max(low, min(high, effective_rate))
        return capped_rate, _CALCULATED_SOURCE

    return default_tax_rate, f"repli configuré : taux par défaut ({default_tax_rate:.0%})"


def resolve(
    facts: pl.DataFrame,
    cik: str,
    end: date,
    t: date,
    default_tax_rate: float = 0.21,
) -> tuple[float | None, float, str]:
    ebit, _ = resolve_ebit(facts, cik, end, t)
    tax_rate, tax_rate_source = resolve_tax_rate(
        facts, cik, end, t, default_tax_rate=default_tax_rate
    )
    if ebit is None:
        return None, tax_rate, tax_rate_source

    nopat = ebit * (1 - tax_rate)
    return nopat, tax_rate, tax_rate_source
