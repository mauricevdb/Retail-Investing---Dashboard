from datetime import date

import polars as pl

from dashboard.calc.point_in_time import resolve_detail

# Concepts contribuant à chaque indicateur quand chaque bridge résout à son
# tag primaire (rang de repli 1). Ne couvre pas la reconstruction du rang
# sur un titre dont un bridge serait en repli -- hors périmètre de T61.
_INDICATOR_CONCEPTS: dict[str, list[str]] = {
    "ev_ebit": [
        "OperatingIncomeLoss",
        "LongTermDebtNoncurrent",
        "LongTermDebtCurrent",
        "CashAndCashEquivalentsAtCarryingValue",
    ],
    "fcf_yield": [
        "NetCashProvidedByUsedInOperatingActivities",
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "LongTermDebtNoncurrent",
        "LongTermDebtCurrent",
        "CashAndCashEquivalentsAtCarryingValue",
    ],
    "roic": [
        "OperatingIncomeLoss",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeTaxExpenseBenefit",
        "LongTermDebtNoncurrent",
        "LongTermDebtCurrent",
        "StockholdersEquity",
        "CashAndCashEquivalentsAtCarryingValue",
    ],
    "net_debt_ebitda": [
        "OperatingIncomeLoss",
        "DepreciationDepletionAndAmortization",
        "LongTermDebtNoncurrent",
        "LongTermDebtCurrent",
        "CashAndCashEquivalentsAtCarryingValue",
    ],
}


def trace_indicator(
    facts: pl.DataFrame, cik: str, end: date, t: date, indicator: str
) -> list[dict]:
    trace = []
    for concept in _INDICATOR_CONCEPTS[indicator]:
        detail = resolve_detail(facts, concept, cik, end, t)
        if detail is not None:
            # Rang de repli 1 (tag primaire) : seul cas couvert par T61.
            trace.append({**detail, "rank": 1})
    return trace


def trace_percentile(kind: str, **kwargs: object) -> dict:
    if kind == "own_history":
        return {
            "formula": "percentile de la valeur courante parmi l'historique propre du titre",
            "inputs": kwargs["historical_values"],
            "window": f"{kwargs['since_year']}-{kwargs['t_year']}",
        }
    if kind == "sector":
        sector_values = kwargs["sector_values"]
        return {
            "formula": "percentile de la valeur courante parmi le groupe sectoriel du jour",
            "inputs": sector_values,
            "population": f"{len(sector_values)} titres",
        }
    raise ValueError(f"type de percentile inconnu : {kind!r}")
