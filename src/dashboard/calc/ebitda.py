from datetime import date

import polars as pl

from dashboard.calc.dna_bridge import resolve as resolve_dna
from dashboard.calc.ebit_bridge import resolve as resolve_ebit


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> float | None:
    ebit, _ = resolve_ebit(facts, cik, end, t)
    dna, _ = resolve_dna(facts, cik, end, t)
    if ebit is None or dna is None:
        return None
    return ebit + dna
