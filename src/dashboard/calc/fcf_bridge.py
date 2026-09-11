from datetime import date

import polars as pl

from dashboard.calc.point_in_time import resolve as resolve_pit
from dashboard.calc.point_in_time import resolve_detail


def _trace_cfo(facts: pl.DataFrame, cik: str, end: date, t: date) -> dict | None:
    primary = resolve_detail(facts, "NetCashProvidedByUsedInOperatingActivities", cik, end, t)
    if primary is not None:
        return {**primary, "rank": 1}

    fallback = resolve_detail(
        facts, "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations", cik, end, t
    )
    if fallback is not None:
        return {**fallback, "rank": 2}

    return None


def _trace_capex(facts: pl.DataFrame, cik: str, end: date, t: date) -> dict | None:
    primary = resolve_detail(facts, "PaymentsToAcquirePropertyPlantAndEquipment", cik, end, t)
    if primary is not None:
        return {**primary, "rank": 1}

    fallback = resolve_detail(facts, "PaymentsToAcquireProductiveAssets", cik, end, t)
    if fallback is not None:
        return {**fallback, "rank": 2}

    return None


def trace(facts: pl.DataFrame, cik: str, end: date, t: date) -> list[dict]:
    components = [_trace_cfo(facts, cik, end, t), _trace_capex(facts, cik, end, t)]
    return [component for component in components if component is not None]


def _resolve_cfo(
    facts: pl.DataFrame, cik: str, end: date, t: date
) -> tuple[float | None, str | None]:
    primary = resolve_pit(facts, cik, "NetCashProvidedByUsedInOperatingActivities", end, t)
    if primary is not None:
        return primary, "us-gaap:NetCashProvidedByUsedInOperatingActivities"

    fallback = resolve_pit(
        facts, cik, "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations", end, t
    )
    if fallback is not None:
        return (
            fallback,
            "us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
        )

    return None, None


def _resolve_capex(
    facts: pl.DataFrame, cik: str, end: date, t: date
) -> tuple[float | None, str | None]:
    primary = resolve_pit(facts, cik, "PaymentsToAcquirePropertyPlantAndEquipment", end, t)
    if primary is not None:
        return primary, "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment"

    fallback = resolve_pit(facts, cik, "PaymentsToAcquireProductiveAssets", end, t)
    if fallback is not None:
        return fallback, "us-gaap:PaymentsToAcquireProductiveAssets"

    return None, None


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> tuple[float | None, str | None]:
    cfo, cfo_tag = _resolve_cfo(facts, cik, end, t)
    capex, capex_tag = _resolve_capex(facts, cik, end, t)
    if cfo is None or capex is None:
        return None, None
    return cfo - capex, f"{cfo_tag} - {capex_tag}"
