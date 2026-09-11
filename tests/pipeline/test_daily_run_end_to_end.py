from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.filters import apply_filters
from dashboard.calc.ranking import rank
from dashboard.calc.ratios import indicator_status
from dashboard.pipeline.daily_run import run_daily


def _fact(cik: str, concept: str, value: float, end: date, filed: date) -> dict:
    return {"cik": cik, "concept": concept, "end": end, "filed": filed, "value": value}


def test_daily_run_end_to_end(tmp_path: Path) -> None:
    end = date(2023, 12, 31)
    filed = date(2024, 2, 15)
    t = date(2024, 3, 1)

    tickers = {"0000000101": "ZZZA", "0000000102": "ZZZB", "0000000103": "ZZZC"}
    ebit_by_cik = {
        "0000000101": 100_000_000.0,
        "0000000102": 50_000_000.0,
        "0000000103": 200_000_000.0,
    }
    debt_by_cik = {"0000000101": 20_000_000.0, "0000000102": 5_000_000.0, "0000000103": 50_000_000.0}
    cash_by_cik = {"0000000101": 10_000_000.0, "0000000102": 5_000_000.0, "0000000103": 10_000_000.0}

    facts_rows = []
    for cik in tickers:
        facts_rows.append(_fact(cik, "OperatingIncomeLoss", ebit_by_cik[cik], end, filed))
        facts_rows.append(_fact(cik, "LongTermDebtNoncurrent", debt_by_cik[cik], end, filed))
        facts_rows.append(
            _fact(cik, "CashAndCashEquivalentsAtCarryingValue", cash_by_cik[cik], end, filed)
        )
    facts = pl.DataFrame(facts_rows)

    # shares_pit porte cik ET ticker : le pont qui laisse le cik traverser
    # calc.universe (indexé sur ticker seul) sans le modifier.
    shares_pit = pl.DataFrame(
        [
            {"ticker": ticker, "cik": cik, "shares_outstanding": 10_000_000.0}
            for cik, ticker in tickers.items()
        ]
    )
    prices_adj = pl.DataFrame(
        [{"ticker": ticker, "date": t, "close_adj": 10.0} for ticker in tickers.values()]
    )
    sic_codes = pl.DataFrame(
        [
            {"ticker": ticker, "sic": "7372", "entity_type": "operating company"}
            for ticker in tickers.values()
        ]
    )

    thresholds = {"ev_ebit": (0.0, 1.5)}
    universe_history_path = tmp_path / "universe_membership.parquet"
    screen_history_path = tmp_path / "screen_results.parquet"

    run_daily(
        shares_pit=shares_pit,
        prices_adj=prices_adj,
        sic_codes=sic_codes,
        hier_membership=set(),
        t=t,
        universe_history_path=universe_history_path,
        facts=facts,
        end=end,
        thresholds=thresholds,
        screen_history_path=screen_history_path,
        plausible_range=(1, 10),
    )

    # Calcul direct, pour comparaison -- pas une réimplémentation parallèle
    # de run_daily, seulement la vérification que le pipeline ne fait rien
    # de plus ni de moins que composer ces trois fonctions déjà testées.
    market_cap = 10_000_000.0 * 10.0
    expected_statuses = [
        {
            **indicator_status(
                market_cap=market_cap,
                facts=facts,
                cik=cik,
                end=end,
                t=t,
                pct_own_history=None,
                pct_sector=None,
            ),
            "cik": cik,
        }
        for cik in tickers
    ]
    expected_retained, _ = apply_filters(expected_statuses, thresholds)
    expected_ranked = rank(expected_retained)

    written = pl.read_parquet(screen_history_path).sort("rank")

    assert written.height == len(expected_ranked)
    assert written["cik"].to_list() == [row["cik"] for row in expected_ranked]
    assert written["rank"].to_list() == [row["rank"] for row in expected_ranked]
    assert written["ev_ebit"].to_list() == [row["ev_ebit"] for row in expected_ranked]
