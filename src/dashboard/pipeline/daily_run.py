from datetime import date, datetime
from pathlib import Path

import polars as pl

from dashboard.calc.market_calendar import last_session
from dashboard.calc.point_in_time import resolve as resolve_pit
from dashboard.calc.universe import universe as compute_universe
from dashboard.storage.universe_history import append as append_universe_history


def run(
    facts: pl.DataFrame,
    prices_adj: pl.DataFrame,
    cik: str,
    ticker: str,
    concept: str,
    end: date,
    instant: datetime,
) -> dict[str, float | date | None]:
    session = last_session(instant)

    fundamental_value = resolve_pit(facts, cik, concept, end, session)

    price_rows = prices_adj.filter((pl.col("ticker") == ticker) & (pl.col("date") == session))
    close = price_rows["close_adj"][0] if price_rows.height > 0 else None

    return {"date": session, "fundamental": fundamental_value, "close": close}


def run_daily(
    shares_pit: pl.DataFrame,
    prices_adj: pl.DataFrame,
    sic_codes: pl.DataFrame,
    hier_membership: set[str],
    t: date,
    universe_history_path: Path,
) -> None:
    membership = compute_universe(shares_pit, prices_adj, sic_codes, hier_membership, t)

    # Reste du calcul (indicateurs, filtrage, classement) et persistance de
    # l'historique du screen : hors périmètre de T58, câblés par les
    # tâches suivantes. calc.universe ayant réussi, le traitement continue.
    append_universe_history(universe_history_path, membership)
