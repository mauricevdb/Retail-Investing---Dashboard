from datetime import date

import polars as pl
import pytest

from dashboard.calc.candidate_pool import FramePeriodTooRecentError, rank_candidates

_FRAME_END = date(2023, 9, 30)
_T = date(2024, 3, 1)  # 153 jours après _FRAME_END -- au-delà du seuil de 120 (ADR 0005)


def _fixture() -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    shares_frame = pl.DataFrame(
        {
            "cik": ["0000000001", "0000000002", "0000000003"],
            "end": [_FRAME_END, _FRAME_END, _FRAME_END],
            "value": [10_000_000.0, 50_000_000.0, 1_000_000.0],
        }
    )
    ticker_cik = pl.DataFrame(
        {
            "cik": ["0000000001", "0000000002", "0000000003"],
            "ticker": ["AAAA", "BBBB", "CCCC"],
            "name": ["Alpha Corp", "Beta Corp", "Gamma Corp"],
            "as_of": [_T, _T, _T],
        }
    )
    # Capitalisations approchées : AAAA = 10M*20 = 200M ; BBBB = 50M*5 = 250M ;
    # CCCC = 1M*100 = 100M -- classement attendu : BBBB, AAAA, CCCC.
    prices_adj = pl.DataFrame(
        {
            "ticker": ["AAAA", "BBBB", "CCCC"],
            "date": [_T, _T, _T],
            "close_adj": [20.0, 5.0, 100.0],
        }
    )
    return shares_frame, ticker_cik, prices_adj


def test_rank_candidates_approximates_market_cap_and_cuts_at_rank() -> None:
    shares_frame, ticker_cik, prices_adj = _fixture()

    ranked = rank_candidates(shares_frame, ticker_cik, prices_adj, _T, n=1, buffer=1)

    # Coupe à n + buffer = 2 : BBBB (250M, rang 1) et AAAA (200M, rang 2)
    # retenus, CCCC (100M, rang 3) exclu.
    assert ranked["ticker"].to_list() == ["BBBB", "AAAA"]
    assert ranked["rank"].to_list() == [1, 2]
    assert ranked.filter(pl.col("ticker") == "BBBB")["approx_market_cap"][0] == 250_000_000.0


def test_rank_candidates_rejects_frame_too_recent() -> None:
    shares_frame, ticker_cik, prices_adj = _fixture()
    # 60 jours seulement avant t -- sous le seuil de 120 jours de l'ADR 0005 :
    # rien ne garantit que ces actions en circulation étaient déjà publiques.
    too_recent_t = date(2023, 11, 29)

    with pytest.raises(FramePeriodTooRecentError):
        rank_candidates(shares_frame, ticker_cik, prices_adj, too_recent_t, n=1, buffer=1)
