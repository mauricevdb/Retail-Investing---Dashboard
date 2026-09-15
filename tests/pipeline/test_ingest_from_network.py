import json
from datetime import date
from pathlib import Path

import polars as pl
import pytest

from dashboard.ingestion.edgar_client import EdgarClient, EdgarClientError
from dashboard.ingestion.eodhd_client import EodhdClient
from dashboard.pipeline.ingest import IngestionSelectionError, run_from_network

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


class RoutingEdgarTransport:
    def __init__(self, fail_on: str | None = None):
        with open(GOLDEN / "edgar_company_tickers.json", encoding="utf-8") as f:
            self.tickers = json.load(f)
        with open(GOLDEN / "edgar_submissions_0000000001.json", encoding="utf-8") as f:
            self.submissions = json.load(f)
        with open(GOLDEN / "edgar_companyfacts_0000000001.json", encoding="utf-8") as f:
            self.facts = json.load(f)
        self.fail_on = fail_on
        self.calls: list[str] = []

    def __call__(self, url: str, headers: dict):
        self.calls.append(url)
        if self.fail_on is not None and self.fail_on in url:
            raise ConnectionError("boom")
        if "company_tickers.json" in url:
            return self.tickers
        if "submissions/CIK0000000001.json" in url:
            return self.submissions
        if "companyfacts/CIK0000000001.json" in url:
            return self.facts
        raise AssertionError(f"URL EDGAR inattendue : {url}")


class RoutingEodhdTransport:
    def __init__(self):
        with open(GOLDEN / "eodhd_bulk_prices_2024-02-15.json", encoding="utf-8") as f:
            self.prices = json.load(f)
        with open(GOLDEN / "eodhd_bulk_actions_2024-02-15.json", encoding="utf-8") as f:
            self.actions = json.load(f)
        self.calls: list[str] = []

    def __call__(self, url: str, params: dict):
        self.calls.append(url)
        if "type=splits" in url:
            return self.actions
        return self.prices


def test_run_from_network_ingests_and_feeds_daily_run(tmp_path: Path) -> None:
    edgar_transport = RoutingEdgarTransport()
    eodhd_transport = RoutingEodhdTransport()
    edgar_client = EdgarClient(
        user_agent="RI Dashboard test@example.com", transport=edgar_transport
    )
    eodhd_client = EodhdClient(api_key="fake-eodhd-key", transport=eodhd_transport)

    t = date(2024, 2, 15)
    end = date(2023, 12, 31)
    universe_history_path = tmp_path / "universe_membership.parquet"
    screen_history_path = tmp_path / "screen_results.parquet"
    fundamentals_history_path = tmp_path / "fundamentals_raw.parquet"

    view_text = run_from_network(
        edgar_client=edgar_client,
        eodhd_client=eodhd_client,
        t=t,
        end=end,
        universe_history_path=universe_history_path,
        hier_membership=set(),
        ciks=["0000000001"],
        thresholds={},
        screen_history_path=screen_history_path,
        fundamentals_history_path=fundamentals_history_path,
        plausible_range=(0, 1),
    )

    assert view_text is not None
    assert "1" in view_text

    # Univers : un seul titre (Alpha/AAAA), issu du croisement
    # company_tickers -> submissions, jamais fourni par l'appelant.
    membership = pl.read_parquet(universe_history_path)
    assert membership.filter(pl.col("in_universe")).height == 1
    assert membership["ticker"].to_list() == ["AAAA"]

    # EV/EBIT dérivé des vraies actions en circulation (100M, tag primaire
    # dei:EntityCommonStockSharesOutstanding), pas d'une valeur fournie par
    # l'appelant : capitalisation lissée sur les deux séances du fixture
    # (2024-02-14 à 75.0, 2024-02-15 à 76.5, toutes deux <= t) --
    # moyenne 75.75 * 100M + dette nette (120M - 80M) = 40M,
    # EV = 7 615 000 000 ; EBIT = 500M ; EV/EBIT = 15.23.
    written = pl.read_parquet(screen_history_path)
    assert written.height == 1
    row = written.row(0, named=True)
    assert row["cik"] == "0000000001"
    assert row["ev_ebit"] == pytest.approx(15.23)

    # fundamentals_raw.parquet est réellement persisté (T78) -- jusqu'ici
    # facts ne vivait qu'en mémoire pour la durée du run.
    fundamentals = pl.read_parquet(fundamentals_history_path)
    assert fundamentals.height > 0
    assert set(fundamentals["cik"].to_list()) == {"0000000001"}

    # Les cinq fetch_* ont bien été appelés.
    assert any("company_tickers.json" in c for c in edgar_transport.calls)
    assert any("submissions/CIK0000000001.json" in c for c in edgar_transport.calls)
    assert any("companyfacts/CIK0000000001.json" in c for c in edgar_transport.calls)
    assert any("type=splits" in c for c in eodhd_transport.calls)
    assert any("type=splits" not in c for c in eodhd_transport.calls)


def test_run_from_network_propagates_source_failure(tmp_path: Path) -> None:
    edgar_transport = RoutingEdgarTransport(fail_on="companyfacts")
    eodhd_transport = RoutingEodhdTransport()
    edgar_client = EdgarClient(
        user_agent="RI Dashboard test@example.com", transport=edgar_transport
    )
    eodhd_client = EodhdClient(api_key="fake-eodhd-key", transport=eodhd_transport)

    universe_history_path = tmp_path / "universe_membership.parquet"

    # Aucun repli silencieux (invariant 7) : l'échec d'une source remonte,
    # rien n'est écrit, rien ne s'affiche.
    with pytest.raises(EdgarClientError):
        run_from_network(
            edgar_client=edgar_client,
            eodhd_client=eodhd_client,
            t=date(2024, 2, 15),
            end=date(2023, 12, 31),
            universe_history_path=universe_history_path,
            hier_membership=set(),
            ciks=["0000000001"],
            plausible_range=(0, 1),
        )

    assert not universe_history_path.exists()


def test_run_from_network_rejects_ambiguous_or_unknown_selection(tmp_path: Path) -> None:
    edgar_client = EdgarClient(
        user_agent="RI Dashboard test@example.com", transport=RoutingEdgarTransport()
    )
    eodhd_client = EodhdClient(api_key="fake-eodhd-key", transport=RoutingEodhdTransport())
    universe_history_path = tmp_path / "universe_membership.parquet"

    with pytest.raises(IngestionSelectionError):
        run_from_network(
            edgar_client=edgar_client,
            eodhd_client=eodhd_client,
            t=date(2024, 2, 15),
            end=date(2023, 12, 31),
            universe_history_path=universe_history_path,
            hier_membership=set(),
        )

    with pytest.raises(IngestionSelectionError):
        run_from_network(
            edgar_client=edgar_client,
            eodhd_client=eodhd_client,
            t=date(2024, 2, 15),
            end=date(2023, 12, 31),
            universe_history_path=universe_history_path,
            hier_membership=set(),
            ciks=["0000000001"],
            tickers=["AAAA"],
        )

    with pytest.raises(IngestionSelectionError):
        run_from_network(
            edgar_client=edgar_client,
            eodhd_client=eodhd_client,
            t=date(2024, 2, 15),
            end=date(2023, 12, 31),
            universe_history_path=universe_history_path,
            hier_membership=set(),
            ciks=["9999999999"],
        )
