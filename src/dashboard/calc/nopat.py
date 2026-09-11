from datetime import date

import polars as pl

from dashboard.calc.ebit_bridge import resolve as resolve_ebit
from dashboard.calc.point_in_time import resolve as resolve_pit
from dashboard.calc.point_in_time import resolve_detail

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


def trace_tax_rate(
    facts: pl.DataFrame,
    cik: str,
    end: date,
    t: date,
    default_tax_rate: float = 0.21,
) -> list[dict]:
    tax_detail = resolve_detail(facts, "IncomeTaxExpenseBenefit", cik, end, t)

    pretax_primary = resolve_detail(facts, _PRETAX_INCOME_TAG, cik, end, t)
    if pretax_primary is not None:
        pretax_value = pretax_primary["value"]
        pretax_components = [{**pretax_primary, "rank": 1}]
    else:
        net_income_detail = resolve_detail(facts, "NetIncomeLoss", cik, end, t)
        if net_income_detail is not None and tax_detail is not None:
            pretax_value = net_income_detail["value"] + tax_detail["value"]
            pretax_components = [{**net_income_detail, "rank": 2}]
        else:
            pretax_value = None
            pretax_components = []

    if pretax_value is not None and pretax_value > 0 and tax_detail is not None:
        return pretax_components + [{**tax_detail, "rank": 1}]

    # Aucune donnée fiscale exploitable : le taux par défaut est un
    # paramètre de modélisation, pas un fait déposé (invariant 7). Il doit
    # rester exposable partout où il influence un chiffre, jamais une trace
    # silencieusement vide qui laisse croire à une absence de repli.
    return [
        {
            "parameter": "default_tax_rate",
            "value": default_tax_rate,
            "source": f"repli configuré : taux par défaut ({default_tax_rate:.0%})",
        }
    ]


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
