from datetime import date

import polars as pl


def resolve_detail(facts: pl.DataFrame, concept: str, cik: str, end: date, t: date) -> dict | None:
    candidates = facts.filter(
        (pl.col("cik") == cik)
        & (pl.col("concept") == concept)
        & (pl.col("end") == end)
        & (pl.col("filed") <= t)
    )
    if candidates.height == 0:
        return None

    latest = candidates.sort("filed", descending=True).row(0, named=True)
    return {
        "concept": latest["concept"],
        "end": latest["end"],
        "filed": latest["filed"],
        "accn": latest.get("accn"),
        "value": latest["value"],
    }


def resolve(facts: pl.DataFrame, cik: str, concept: str, end: date, t: date) -> float | None:
    detail = resolve_detail(facts, concept, cik, end, t)
    return detail["value"] if detail is not None else None
