from datetime import date, datetime
from pathlib import Path

import polars as pl

from dashboard.calc.filters import apply_filters
from dashboard.calc.market_calendar import last_session
from dashboard.calc.point_in_time import resolve as resolve_pit
from dashboard.calc.ranking import rank
from dashboard.calc.ratios import indicator_status
from dashboard.calc.universe import universe as compute_universe
from dashboard.storage.screen_history import append as append_screen_history
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
    facts: pl.DataFrame | None = None,
    end: date | None = None,
    thresholds: dict[str, tuple[float | None, float | None]] | None = None,
    screen_history_path: Path | None = None,
    n: int = 900,
    buffer: int = 100,
    plausible_range: tuple[int, int] = (700, 1100),
) -> None:
    membership = compute_universe(
        shares_pit,
        prices_adj,
        sic_codes,
        hier_membership,
        t,
        n=n,
        buffer=buffer,
        plausible_range=plausible_range,
    )
    append_universe_history(universe_history_path, membership)

    # Indicateurs, filtrage, classement et persistance du screen : reste
    # hors périmètre si l'appelant n'a pas encore fourni ces paramètres
    # (usage de T58 seul, univers sans reste du calcul). calc.universe
    # ayant réussi, le traitement continue.
    if facts is None or end is None or thresholds is None or screen_history_path is None:
        return

    statuses = [
        {
            **indicator_status(
                market_cap=member["market_cap_smoothed"],
                facts=facts,
                cik=member["cik"],
                end=end,
                t=t,
                pct_own_history=None,
                pct_sector=None,
            ),
            "cik": member["cik"],
            "ticker": member["ticker"],
        }
        for member in membership.filter(pl.col("in_universe")).iter_rows(named=True)
    ]

    retained, _ = apply_filters(statuses, thresholds)
    ranked = rank(retained)

    if not ranked:
        return

    screen_rows = pl.DataFrame([{**status, "date": t} for status in ranked])
    append_screen_history(screen_history_path, screen_rows)
