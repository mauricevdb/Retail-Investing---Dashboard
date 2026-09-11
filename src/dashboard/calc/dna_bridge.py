from datetime import date

import polars as pl

from dashboard.calc.point_in_time import resolve as resolve_pit
from dashboard.calc.point_in_time import resolve_detail


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> tuple[float | None, str | None]:
    primary = resolve_pit(facts, cik, "DepreciationDepletionAndAmortization", end, t)
    if primary is not None:
        return primary, "us-gaap:DepreciationDepletionAndAmortization"

    depreciation = resolve_pit(facts, cik, "Depreciation", end, t)
    amortization = resolve_pit(facts, cik, "AmortizationOfIntangibleAssets", end, t)
    if depreciation is not None and amortization is not None:
        return (
            depreciation + amortization,
            "us-gaap:Depreciation + us-gaap:AmortizationOfIntangibleAssets",
        )

    return None, None


def trace(facts: pl.DataFrame, cik: str, end: date, t: date) -> list[dict]:
    primary = resolve_detail(facts, "DepreciationDepletionAndAmortization", cik, end, t)
    if primary is not None:
        return [{**primary, "rank": 1}]

    depreciation = resolve_detail(facts, "Depreciation", cik, end, t)
    amortization = resolve_detail(facts, "AmortizationOfIntangibleAssets", cik, end, t)
    if depreciation is not None and amortization is not None:
        return [{**depreciation, "rank": 2}, {**amortization, "rank": 2}]

    return []
