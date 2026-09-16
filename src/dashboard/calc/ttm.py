from datetime import date

import polars as pl

_QUARTERS = ("Q1", "Q2", "Q3", "Q4")
# Un dépôt 10-Q publie systématiquement, pour un même trimestre, à la fois
# le trimestre seul et le cumul depuis le début de l'exercice -- partageant
# `end`/`filed`/`fiscal_period`, mais avec un `start` différent (trouvé sur
# FISV, /spec-verify sixième passage, T90). Seuil large (~3 mois + marge)
# pour ne retenir que la durée trimestrielle, jamais un cumul de plusieurs
# trimestres qui partagerait la même fin de période.
_MAX_QUARTER_DURATION_DAYS = 100


def ttm(facts: pl.DataFrame, cik: str, concept: str, t: date) -> float | None:
    quarterly = facts.filter(
        (pl.col("cik") == cik)
        & (pl.col("concept") == concept)
        & (pl.col("filed") <= t)
        & (pl.col("fiscal_period").is_in(_QUARTERS))
        & (pl.col("start").is_not_null())
        & ((pl.col("end") - pl.col("start")).dt.total_days() <= _MAX_QUARTER_DURATION_DAYS)
    )
    if quarterly.height == 0:
        return None

    latest_per_end = (
        quarterly.sort(["end", "filed"], descending=[False, True])
        .unique(subset=["end"], keep="first")
        .sort("end", descending=True)
    )
    last_four = latest_per_end.head(4)
    if last_four.height < 4:
        return None

    return last_four["value"].sum()
