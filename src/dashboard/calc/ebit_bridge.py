from datetime import date

import polars as pl

from dashboard.calc.interest_bridge import resolve as resolve_interest
from dashboard.calc.point_in_time import resolve as resolve_pit


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> tuple[float | None, str | None]:
    primary = resolve_pit(facts, cik, "OperatingIncomeLoss", end, t)
    if primary is not None:
        return primary, "us-gaap:OperatingIncomeLoss"

    net_income = resolve_pit(facts, cik, "NetIncomeLoss", end, t)
    tax = resolve_pit(facts, cik, "IncomeTaxExpenseBenefit", end, t)
    interest = resolve_interest(facts, cik, end, t)
    if net_income is not None and tax is not None and interest is not None:
        return (
            net_income + tax + interest,
            "us-gaap:NetIncomeLoss + us-gaap:IncomeTaxExpenseBenefit + interest_bridge",
        )

    return None, None
