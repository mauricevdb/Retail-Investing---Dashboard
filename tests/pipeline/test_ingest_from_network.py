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


class DiscoveryEdgarTransport:
    """Sert company_tickers, les dépôts/faits d'Alpha (CIK 1) et une frame
    de faits en circulation -- lève explicitement pour toute autre URL,
    preuve que Beta (CIK 2) n'est jamais interrogée une fois écartée par
    le classement (T85)."""

    def __init__(self, frame_response: dict):
        with open(GOLDEN / "edgar_company_tickers.json", encoding="utf-8") as f:
            self.tickers = json.load(f)
        # CIK 1 porte un second ticker, comme Freddie Mac et ses séries
        # d'actions préférentielles (T88) -- sans prix associé dans le bulk
        # EODHD, pour prouver que la seule présence de ce ticker dans
        # company_tickers ne doit jamais, à elle seule, déclencher une
        # deuxième ingestion réelle du même CIK.
        self.tickers["4"] = {"cik_str": 1, "ticker": "AAAZ", "title": "Alpha Preferred"}
        with open(GOLDEN / "edgar_submissions_0000000001.json", encoding="utf-8") as f:
            self.submissions = json.load(f)
        with open(GOLDEN / "edgar_companyfacts_0000000001.json", encoding="utf-8") as f:
            self.facts = json.load(f)
        self.frame_response = frame_response
        self.calls: list[str] = []

    def __call__(self, url: str, headers: dict):
        self.calls.append(url)
        if "company_tickers.json" in url:
            return self.tickers
        if "submissions/CIK0000000001.json" in url:
            return self.submissions
        if "companyfacts/CIK0000000001.json" in url:
            return self.facts
        if "/frames/" in url:
            return self.frame_response
        raise AssertionError(f"URL EDGAR inattendue : {url}")


class DiscoveryEodhdTransport:
    """Cours bulk pour Alpha (AAAA, mêmes valeurs que la fixture partagée)
    et Beta (BBBB, cours très inférieur) -- construit ici plutôt que dans
    tests/golden/, pour ne jamais toucher la fixture partagée par d'autres
    tests."""

    def __init__(self):
        with open(GOLDEN / "eodhd_bulk_actions_2024-02-15.json", encoding="utf-8") as f:
            self.actions = json.load(f)
        self.prices = [
            {
                "code": "AAAA",
                "date": "2024-02-14",
                "open": 148.0,
                "high": 151.0,
                "low": 147.5,
                "close": 150.0,
                "adjusted_close": 75.0,
                "volume": 1_200_000,
            },
            {
                "code": "AAAA",
                "date": "2024-02-15",
                "open": 76.0,
                "high": 77.0,
                "low": 75.0,
                "close": 76.5,
                "adjusted_close": 76.5,
                "volume": 2_500_000,
            },
            {
                "code": "BBBB",
                "date": "2024-02-15",
                "open": 1.0,
                "high": 1.0,
                "low": 1.0,
                "close": 1.0,
                "adjusted_close": 1.0,
                "volume": 1_000,
            },
        ]
        self.calls: list[str] = []

    def __call__(self, url: str, params: dict):
        self.calls.append(url)
        if "type=splits" in url:
            return self.actions
        return self.prices


def test_run_from_network_discovers_candidates_via_frame_period(tmp_path: Path) -> None:
    # Actions en circulation identiques pour Alpha (CIK 1) et Beta (CIK 2),
    # mais un cours bulk EODHD très inférieur pour Beta (ci-dessus) :
    # capitalisation approchée d'Alpha très supérieure. n=1/buffer=0 ne
    # retient donc qu'Alpha -- Beta ne doit jamais être ingérée pour de
    # vrai (invariant 10 : chaque appel EDGAR a un coût, la découverte doit
    # réellement limiter le bassin, pas seulement le classement final).
    frame_response = {
        "data": [
            {"cik": 1, "end": "2023-06-30", "val": 100_000_000},
            {"cik": 2, "end": "2023-06-30", "val": 100_000_000},
        ]
    }
    edgar_transport = DiscoveryEdgarTransport(frame_response)
    eodhd_transport = DiscoveryEodhdTransport()
    edgar_client = EdgarClient(
        user_agent="RI Dashboard test@example.com", transport=edgar_transport
    )
    eodhd_client = EodhdClient(api_key="fake-eodhd-key", transport=eodhd_transport)

    t = date(2024, 2, 15)
    end = date(2023, 12, 31)
    universe_history_path = tmp_path / "universe_membership.parquet"
    screen_history_path = tmp_path / "screen_results.parquet"

    view_text = run_from_network(
        edgar_client=edgar_client,
        eodhd_client=eodhd_client,
        t=t,
        end=end,
        universe_history_path=universe_history_path,
        hier_membership=set(),
        frame_period="CY2023Q2I",
        thresholds={},
        screen_history_path=screen_history_path,
        n=1,
        buffer=0,
        plausible_range=(0, 1),
    )

    assert view_text is not None

    membership = pl.read_parquet(universe_history_path)
    assert membership.filter(pl.col("in_universe")).height == 1
    assert membership.filter(pl.col("in_universe"))["ticker"].to_list() == ["AAAA"]

    written = pl.read_parquet(screen_history_path)
    assert written.height == 1
    assert written.row(0, named=True)["cik"] == "0000000001"

    # Beta (CIK 2) n'a jamais été interrogée pour de vrai -- seulement
    # classée via la frame, jamais sélectionnée pour l'ingestion complète.
    assert not any("CIK0000000002" in call for call in edgar_transport.calls)
    assert any("/frames/" in call for call in edgar_transport.calls)

    # CIK 1 (Alpha) porte deux tickers dans company_tickers (AAAA, AAAZ) --
    # une seule ingestion réelle doit avoir lieu, jamais une par ticker
    # (T88), même si AAAZ n'a jamais été retenue par le classement.
    submissions_calls = [c for c in edgar_transport.calls if "submissions/CIK0000000001" in c]
    facts_calls = [c for c in edgar_transport.calls if "companyfacts/CIK0000000001" in c]
    assert len(submissions_calls) == 1
    assert len(facts_calls) == 1


class WideDiscoveryEdgarTransport:
    """Sert company_tickers et les dépôts/faits réels d'Alpha (CIK 1), Beta
    (CIK 2) et Gamma (CIK 3) -- une marge de découverte plus large que la
    marge finale de l'univers (T89) doit permettre aux trois d'être
    réellement ingérés, même si un seul devient membre de l'univers."""

    def __init__(self, frame_response: dict):
        with open(GOLDEN / "edgar_company_tickers.json", encoding="utf-8") as f:
            self.tickers = json.load(f)
        self.submissions = {}
        self.facts = {}
        for cik in ("0000000001", "0000000002", "0000000003"):
            with open(GOLDEN / f"edgar_submissions_{cik}.json", encoding="utf-8") as f:
                self.submissions[cik] = json.load(f)
            with open(GOLDEN / f"edgar_companyfacts_{cik}.json", encoding="utf-8") as f:
                self.facts[cik] = json.load(f)
        self.frame_response = frame_response
        self.calls: list[str] = []

    def __call__(self, url: str, headers: dict):
        self.calls.append(url)
        if "company_tickers.json" in url:
            return self.tickers
        for cik, payload in self.submissions.items():
            if f"submissions/CIK{cik}.json" in url:
                return payload
        for cik, payload in self.facts.items():
            if f"companyfacts/CIK{cik}.json" in url:
                return payload
        if "/frames/" in url:
            return self.frame_response
        raise AssertionError(f"URL EDGAR inattendue : {url}")


class WideDiscoveryEodhdTransport:
    """Cours bulk pour Alpha (AAAA, le plus haut), Beta (BBBB) et Gamma
    (CCCC, le plus bas) -- capitalisations approchées nettement distinctes
    pour un classement déterministe sur les trois."""

    def __init__(self):
        with open(GOLDEN / "eodhd_bulk_actions_2024-02-15.json", encoding="utf-8") as f:
            self.actions = json.load(f)
        self.prices = [
            {
                "code": ticker,
                "date": "2024-02-15",
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "adjusted_close": price,
                "volume": 1_000,
            }
            for ticker, price in (("AAAA", 100.0), ("BBBB", 10.0), ("CCCC", 1.0))
        ]
        self.calls: list[str] = []

    def __call__(self, url: str, params: dict):
        self.calls.append(url)
        if "type=splits" in url:
            return self.actions
        return self.prices


def test_run_from_network_discovery_buffer_wider_than_universe_buffer(tmp_path: Path) -> None:
    # Actions en circulation identiques pour Alpha/Beta/Gamma, capitalisations
    # très distinctes via le prix (ci-dessus) : Alpha (100) > Beta (10) >
    # Gamma (1). n=1, buffer=0 -- l'univers final ne retient qu'Alpha. Mais
    # discovery_buffer=2 doit tout de même faire ingérer réellement les
    # trois (coupure de découverte à n + discovery_buffer = 3), preuve que
    # la marge de découverte et la marge de l'univers final sont désormais
    # deux paramètres distincts (T89).
    frame_response = {
        "data": [
            {"cik": 1, "end": "2023-06-30", "val": 100_000_000},
            {"cik": 2, "end": "2023-06-30", "val": 100_000_000},
            {"cik": 3, "end": "2023-06-30", "val": 100_000_000},
        ]
    }
    edgar_transport = WideDiscoveryEdgarTransport(frame_response)
    eodhd_transport = WideDiscoveryEodhdTransport()
    edgar_client = EdgarClient(
        user_agent="RI Dashboard test@example.com", transport=edgar_transport
    )
    eodhd_client = EodhdClient(api_key="fake-eodhd-key", transport=eodhd_transport)

    t = date(2024, 2, 15)
    end = date(2023, 12, 31)
    universe_history_path = tmp_path / "universe_membership.parquet"
    screen_history_path = tmp_path / "screen_results.parquet"

    run_from_network(
        edgar_client=edgar_client,
        eodhd_client=eodhd_client,
        t=t,
        end=end,
        universe_history_path=universe_history_path,
        hier_membership=set(),
        frame_period="CY2023Q2I",
        thresholds={},
        screen_history_path=screen_history_path,
        n=1,
        buffer=0,
        discovery_buffer=2,
        plausible_range=(0, 3),
    )

    # Les trois ont bien été ingérées pour de vrai, malgré une marge
    # d'univers finale (buffer=0) qui n'en aurait laissé passer aucune de
    # plus qu'Alpha à la découverte.
    for cik in ("0000000001", "0000000002", "0000000003"):
        assert any(f"submissions/CIK{cik}" in c for c in edgar_transport.calls)
        assert any(f"companyfacts/CIK{cik}" in c for c in edgar_transport.calls)

    # L'univers final, lui, reste gouverné par buffer=0 -- Alpha seule.
    membership = pl.read_parquet(universe_history_path)
    assert membership.filter(pl.col("in_universe")).height == 1
    assert membership.filter(pl.col("in_universe"))["ticker"].to_list() == ["AAAA"]


class MultiTickerEdgarTransport:
    """company_tickers liste le CIK 1 sous deux tickers (comme Freddie Mac
    et ses séries d'actions préférentielles, T88) -- compte les appels
    dépôts/faits pour ce CIK afin de prouver qu'une seule ingestion réelle
    a lieu, jamais une par ticker."""

    def __init__(self):
        with open(GOLDEN / "edgar_submissions_0000000001.json", encoding="utf-8") as f:
            self.submissions = json.load(f)
        with open(GOLDEN / "edgar_companyfacts_0000000001.json", encoding="utf-8") as f:
            self.facts = json.load(f)
        self.tickers = {
            "0": {"cik_str": 1, "ticker": "AAAA", "title": "Alpha Operating Co"},
            "1": {"cik_str": 1, "ticker": "AAAZ", "title": "Alpha Operating Co (Preferred)"},
        }
        self.calls: list[str] = []

    def __call__(self, url: str, headers: dict):
        self.calls.append(url)
        if "company_tickers.json" in url:
            return self.tickers
        if "submissions/CIK0000000001.json" in url:
            return self.submissions
        if "companyfacts/CIK0000000001.json" in url:
            return self.facts
        raise AssertionError(f"URL EDGAR inattendue : {url}")


def test_run_from_network_ciks_mode_fetches_multi_ticker_cik_once(tmp_path: Path) -> None:
    edgar_transport = MultiTickerEdgarTransport()
    eodhd_transport = RoutingEodhdTransport()
    edgar_client = EdgarClient(
        user_agent="RI Dashboard test@example.com", transport=edgar_transport
    )
    eodhd_client = EodhdClient(api_key="fake-eodhd-key", transport=eodhd_transport)

    t = date(2024, 2, 15)
    end = date(2023, 12, 31)
    universe_history_path = tmp_path / "universe_membership.parquet"
    screen_history_path = tmp_path / "screen_results.parquet"

    run_from_network(
        edgar_client=edgar_client,
        eodhd_client=eodhd_client,
        t=t,
        end=end,
        universe_history_path=universe_history_path,
        hier_membership=set(),
        ciks=["0000000001"],
        thresholds={},
        screen_history_path=screen_history_path,
        plausible_range=(0, 1),
    )

    submissions_calls = [c for c in edgar_transport.calls if "submissions/CIK0000000001" in c]
    facts_calls = [c for c in edgar_transport.calls if "companyfacts/CIK0000000001" in c]
    assert len(submissions_calls) == 1
    assert len(facts_calls) == 1

    membership = pl.read_parquet(universe_history_path)
    assert membership.height == 1


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
    # sleep factice (T87) : cet échec déclenche désormais des tentatives
    # avant de remonter -- jamais un vrai temps d'attente dans la suite.
    edgar_client = EdgarClient(
        user_agent="RI Dashboard test@example.com",
        transport=edgar_transport,
        sleep=lambda seconds: None,
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
