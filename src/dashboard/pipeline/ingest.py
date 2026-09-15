from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.candidate_pool import rank_candidates
from dashboard.ingestion.edgar_client import EdgarClient
from dashboard.ingestion.edgar_facts import fetch_company_facts
from dashboard.ingestion.edgar_frames import fetch_shares_outstanding_frame
from dashboard.ingestion.edgar_submissions import fetch_submissions
from dashboard.ingestion.edgar_tickers import fetch_company_tickers
from dashboard.ingestion.eodhd_actions import fetch_bulk_actions
from dashboard.ingestion.eodhd_client import EodhdClient
from dashboard.ingestion.eodhd_prices import fetch_bulk_prices
from dashboard.pipeline.daily_run import run_daily


class IngestionSelectionError(Exception):
    pass


def run_from_network(
    edgar_client: EdgarClient,
    eodhd_client: EodhdClient,
    t: date,
    end: date,
    universe_history_path: Path,
    hier_membership: set[str],
    ciks: list[str] | None = None,
    tickers: list[str] | None = None,
    frame_period: str | None = None,
    thresholds: dict[str, tuple[float | None, float | None]] | None = None,
    screen_history_path: Path | None = None,
    fundamentals_history_path: Path | None = None,
    n: int = 900,
    buffer: int = 100,
    plausible_range: tuple[int, int] = (700, 1100),
    own_history_by_cik: dict[str, list[tuple[int, float]]] | None = None,
    since_year: int = 2011,
) -> str | None:
    if sum(mode is not None for mode in (ciks, tickers, frame_period)) != 1:
        raise IngestionSelectionError(
            "fournir exactement une méthode de sélection : ciks, tickers ou "
            "frame_period, jamais deux ni aucune"
        )

    ticker_cik = fetch_company_tickers(edgar_client, as_of=t)
    # Le bulk de prix sert aussi bien au classement approché (frame_period)
    # qu'au calcul des indicateurs plus bas -- un seul appel, jamais deux,
    # quel que soit le mode de sélection.
    _prices_raw, prices_adj = fetch_bulk_prices(eodhd_client, t)

    if frame_period is not None:
        # Découverte automatique du bassin (T83-T85, ADR 0005) : seuls les
        # candidats retenus après classement par capitalisation approchée
        # sont réellement ingérés ci-dessous -- jamais le bassin entier.
        shares_frame = fetch_shares_outstanding_frame(edgar_client, period=frame_period)
        ranked = rank_candidates(shares_frame, ticker_cik, prices_adj, t, n=n, buffer=buffer)
        selected = ticker_cik.filter(pl.col("cik").is_in(ranked["cik"].to_list()))
        missing: set[str] = set()
    elif ciks is not None:
        selected = ticker_cik.filter(pl.col("cik").is_in(ciks))
        missing = set(ciks) - set(selected["cik"].to_list())
    else:
        selected = ticker_cik.filter(pl.col("ticker").is_in(tickers))
        missing = set(tickers) - set(selected["ticker"].to_list())

    if missing:
        raise IngestionSelectionError(f"non trouvés dans company_tickers : {sorted(missing)}")

    sic_rows = []
    facts_frames = []
    for cik in selected["cik"].to_list():
        _filings, sic_row = fetch_submissions(edgar_client, cik, as_of=t)
        sic_rows.append(sic_row)
        facts_frames.append(fetch_company_facts(edgar_client, cik))

    sic_codes = pl.concat(sic_rows).join(selected.select(["cik", "ticker"]), on="cik")
    facts = pl.concat(facts_frames)

    # Récupérées pour de vrai (T75), non consommées par daily_run dont la
    # signature reste figée -- signalé, pas masqué (cf. tasks.md T75).
    fetch_bulk_actions(eodhd_client, t)

    # Valeur de repli sans effet : écrasée par des actions en circulation
    # réellement dérivées des faits (pipeline.daily_run._derive_shares_pit,
    # T71) dès lors que facts est fourni, ce qui est toujours le cas ici.
    shares_pit = selected.select(["ticker", "cik"]).with_columns(
        pl.lit(0.0).alias("shares_outstanding")
    )

    return run_daily(
        shares_pit=shares_pit,
        prices_adj=prices_adj,
        sic_codes=sic_codes,
        hier_membership=hier_membership,
        t=t,
        universe_history_path=universe_history_path,
        facts=facts,
        end=end,
        thresholds=thresholds,
        screen_history_path=screen_history_path,
        fundamentals_history_path=fundamentals_history_path,
        n=n,
        buffer=buffer,
        plausible_range=plausible_range,
        own_history_by_cik=own_history_by_cik,
        since_year=since_year,
    )
