from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

import polars as pl

from dashboard.app.screen_view import render_screen_text
from dashboard.calc.filters import apply_filters
from dashboard.calc.market_calendar import last_session
from dashboard.calc.percentiles import own_history_percentile, sector_percentile
from dashboard.calc.point_in_time import resolve as resolve_pit
from dashboard.calc.ranking import rank
from dashboard.calc.ratios import indicator_status
from dashboard.calc.sector_grouping import classify as classify_sector
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
    own_history_by_cik: dict[str, list[tuple[int, float]]] | None = None,
    since_year: int = 2011,
) -> str | None:
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
        return None

    own_history_by_cik = own_history_by_cik or {}
    sic_by_ticker = {row["ticker"]: row["sic"] for row in sic_codes.iter_rows(named=True)}
    members = list(membership.filter(pl.col("in_universe")).iter_rows(named=True))

    # Indicateurs fondés sur des faits pour chaque titre membre, sans
    # percentile pour l'instant : le groupe sectoriel du jour ne peut être
    # constitué qu'une fois tous les EV/EBIT connus.
    statuses_by_cik = {
        member["cik"]: {
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
        for member in members
    }

    # Groupe sectoriel du jour : les pairs sont les autres titres membres
    # du même run, pas un historique séparé -- le percentile sectoriel ne
    # suppose rien de plus que le jour courant.
    ev_ebit_by_division: dict[str, list[float]] = defaultdict(list)
    division_by_cik: dict[str, str | None] = {}
    for cik, status in statuses_by_cik.items():
        division = classify_sector(sic_by_ticker[status["ticker"]])
        division_by_cik[cik] = division
        if division is not None and status["ev_ebit"] is not None:
            ev_ebit_by_division[division].append(status["ev_ebit"])

    for cik, status in statuses_by_cik.items():
        division = division_by_cik[cik]
        if division is not None and status["ev_ebit"] is not None:
            pct_sector, sector_available = sector_percentile(
                ev_ebit_by_division[division], status["ev_ebit"]
            )
            status["pct_sector"] = pct_sector if sector_available else None

        if status["ev_ebit"] is not None:
            history = own_history_by_cik.get(cik, []) + [(t.year, status["ev_ebit"])]
            pct_own_history, _ = own_history_percentile(
                history, t_year=t.year, since_year=since_year
            )
            status["pct_own_history"] = pct_own_history

    statuses = list(statuses_by_cik.values())
    retained, _ = apply_filters(statuses, thresholds)
    ranked = rank(retained)

    if ranked:
        screen_rows = pl.DataFrame([{**status, "date": t} for status in ranked])
        append_screen_history(screen_history_path, screen_rows)

    return render_screen_text(retained_count=len(ranked))
