from datetime import date

import polars as pl


def _latest(facts: pl.DataFrame, cik: str, taxonomy: str, concept: str, t: date) -> float | None:
    candidates = facts.filter(
        (pl.col("cik") == cik)
        & (pl.col("taxonomy") == taxonomy)
        & (pl.col("concept") == concept)
        & (pl.col("filed") <= t)
    )
    if candidates.height == 0:
        return None
    latest = candidates.sort(["end", "filed"], descending=True).row(0, named=True)
    return latest["value"]


def resolve(facts: pl.DataFrame, cik: str, t: date) -> tuple[float | None, str | None]:
    coverage = _latest(facts, cik, "dei", "EntityCommonStockSharesOutstanding", t)
    if coverage is not None:
        return coverage, "dei:EntityCommonStockSharesOutstanding"

    balance_sheet = _latest(facts, cik, "us-gaap", "CommonStockSharesOutstanding", t)
    if balance_sheet is not None:
        return balance_sheet, "us-gaap:CommonStockSharesOutstanding"

    issued = _latest(facts, cik, "us-gaap", "CommonStockSharesIssued", t)
    treasury = _latest(facts, cik, "us-gaap", "TreasuryStockShares", t)
    if issued is not None and treasury is not None:
        return (
            issued - treasury,
            "us-gaap:CommonStockSharesIssued - us-gaap:TreasuryStockShares",
        )

    return None, None
