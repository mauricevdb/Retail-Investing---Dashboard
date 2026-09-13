from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.percentiles import own_history_percentile
from dashboard.pipeline.daily_run import run_daily


def _fact(cik: str, concept: str, value: float, end: date, filed: date) -> dict:
    return {
        "cik": cik,
        "concept": concept,
        "end": end,
        "filed": filed,
        "value": value,
        "taxonomy": None,
    }


def _shares_fact(
    cik: str, taxonomy: str, concept: str, value: float, end: date, filed: date
) -> dict:
    return {
        "cik": cik,
        "concept": concept,
        "end": end,
        "filed": filed,
        "value": value,
        "taxonomy": taxonomy,
    }


def test_daily_run_end_to_end(tmp_path: Path) -> None:
    end = date(2023, 12, 31)
    filed = date(2024, 2, 15)
    t = date(2024, 3, 1)

    tickers = {"0000000101": "ZZZA", "0000000102": "ZZZB", "0000000103": "ZZZC"}
    # ZZZD : présent dans le bassin (SIC éligible, prix connus), mais sans
    # aucun fait déposé -- comme Beta (CIK 2, taxonomie IFRS rejetée) dans
    # l'audit /spec-verify. Ses actions en circulation ne sont dérivables
    # d'aucune façon.
    non_calculable_cik, non_calculable_ticker = "0000000104", "ZZZD"
    # ZZZBANK : exclue par règle (SIC 6022, finance), et sans aucune action
    # en circulation déposée non plus. Jamais candidate au classement --
    # son absence ne doit jamais être comptée comme « non calculable »
    # (T73), contrairement à ZZZD, SIC-éligible mais sans donnée.
    excluded_by_rule_cik, excluded_by_rule_ticker = "0000000105", "ZZZBANK"
    ebit_by_cik = {
        "0000000101": 100_000_000.0,
        "0000000102": 50_000_000.0,
        "0000000103": 200_000_000.0,
    }
    debt_by_cik = {
        "0000000101": 20_000_000.0,
        "0000000102": 5_000_000.0,
        "0000000103": 50_000_000.0,
    }
    cash_by_cik = {
        "0000000101": 10_000_000.0,
        "0000000102": 5_000_000.0,
        "0000000103": 10_000_000.0,
    }

    facts_rows = []
    for cik in tickers:
        facts_rows.append(_fact(cik, "OperatingIncomeLoss", ebit_by_cik[cik], end, filed))
        facts_rows.append(_fact(cik, "LongTermDebtNoncurrent", debt_by_cik[cik], end, filed))
        facts_rows.append(
            _fact(cik, "CashAndCashEquivalentsAtCarryingValue", cash_by_cik[cik], end, filed)
        )
    # Actions en circulation déposées : ZZZA et ZZZC au tag primaire, ZZZB
    # sans tag primaire -- retombe sur le tag de repli du bilan (T25). Les
    # trois résolvent à la même valeur que l'ancien shares_pit fixe
    # (10M), pour prouver que la dérivation remplace la valeur fournie par
    # l'appelant sans changer le résultat attendu du test.
    facts_rows.append(
        _shares_fact(
            "0000000101", "dei", "EntityCommonStockSharesOutstanding", 10_000_000.0, end, filed
        )
    )
    facts_rows.append(
        _shares_fact(
            "0000000102", "us-gaap", "CommonStockSharesOutstanding", 10_000_000.0, end, filed
        )
    )
    facts_rows.append(
        _shares_fact(
            "0000000103", "dei", "EntityCommonStockSharesOutstanding", 10_000_000.0, end, filed
        )
    )
    facts = pl.DataFrame(facts_rows)

    # Valeur volontairement absurde (1.0) : si pipeline.daily_run ne dérive
    # plus jamais shares_outstanding des dépôts (T71), cette valeur fausse
    # serait utilisée telle quelle et les indicateurs ci-dessous ne
    # correspondraient plus aux valeurs attendues.
    all_ciks_to_tickers = {
        **tickers,
        non_calculable_cik: non_calculable_ticker,
        excluded_by_rule_cik: excluded_by_rule_ticker,
    }
    shares_pit = pl.DataFrame(
        [
            {"ticker": ticker, "cik": cik, "shares_outstanding": 1.0}
            for cik, ticker in all_ciks_to_tickers.items()
        ]
    )
    prices_adj = pl.DataFrame(
        [
            {"ticker": ticker, "date": t, "close_adj": 10.0}
            for ticker in all_ciks_to_tickers.values()
        ]
    )
    # Même division SIC (7372, services) pour les titres éligibles -- groupe
    # sectoriel sous le seuil de 10, le percentile sectoriel doit donc se
    # replier explicitement (critère 20), pas manquer silencieusement.
    # ZZZBANK porte le SIC 6022 (finance) : exclue par règle (critère 14).
    sic_codes = pl.DataFrame(
        [
            {
                "ticker": ticker,
                "sic": "6022" if ticker == excluded_by_rule_ticker else "7372",
                "entity_type": "operating",
                "as_of": end,
            }
            for ticker in all_ciks_to_tickers.values()
        ]
    )

    thresholds = {"ev_ebit": (0.0, 1.5)}
    # Historique propre à chaque titre, années antérieures à t -- la valeur
    # du jour lui-même est calculée par run_daily, pas fournie ici.
    own_history_by_cik = {
        "0000000101": [(2019, 1.5), (2020, 1.4), (2021, 1.3), (2022, 1.2), (2023, 1.15)],
        "0000000103": [(2019, 0.9), (2020, 0.85), (2021, 0.8), (2022, 0.75), (2023, 0.72)],
    }

    universe_history_path = tmp_path / "universe_membership.parquet"
    screen_history_path = tmp_path / "screen_results.parquet"

    view_text = run_daily(
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
        own_history_by_cik=own_history_by_cik,
    )

    # Univers non vide -- ni ZZZD (sans action en circulation dérivable) ni
    # ZZZBANK (exclue par règle) n'apparaissent parmi les membres classés.
    membership = pl.read_parquet(universe_history_path)
    assert membership.filter(pl.col("in_universe")).height == 3
    assert non_calculable_ticker not in membership["ticker"].to_list()
    assert excluded_by_rule_ticker not in membership["ticker"].to_list()

    # Vue affichable produite, mentionnant le compteur de titres retenus
    # ET le nombre de titres non calculables pour le classement -- 1 (ZZZD),
    # jamais 2 : ZZZBANK est exclue par règle, pas faute de donnée, et ne
    # doit jamais gonfler ce compte (T73).
    assert view_text is not None
    assert "2" in view_text
    assert "1 titre(s) non calculable(s) pour le classement" in view_text

    written = pl.read_parquet(screen_history_path).sort("rank")

    # ZZZB (ev_ebit=2.0) exclu par les seuils ; ZZZC (0.7) puis ZZZA (1.1)
    # classés par EV/EBIT croissant.
    assert written.height == 2
    assert written["cik"].to_list() == ["0000000103", "0000000101"]
    assert written["rank"].to_list() == [1, 2]

    # Les six indicateurs sont toujours présents -- calculés ou
    # explicitement None, jamais une colonne manquante.
    for column in (
        "ev_ebit",
        "fcf_yield",
        "roic",
        "net_debt_ebitda",
        "pct_own_history",
        "pct_sector",
    ):
        assert column in written.columns

    a_row = written.filter(pl.col("cik") == "0000000101").row(0, named=True)

    # Percentile propre histoire : calculé, cohérent avec calc.percentiles
    # appelé directement sur le même historique complété par le jour même.
    expected_pct, _ = own_history_percentile(
        own_history_by_cik["0000000101"] + [(t.year, a_row["ev_ebit"])],
        t_year=t.year,
        since_year=2011,
    )
    assert a_row["pct_own_history"] == expected_pct

    # Percentile sectoriel : groupe de 3 titres, sous le seuil de 10 --
    # explicitement indisponible (None), jamais silencieusement absent
    # (la colonne existe, la valeur est None par construction du repli).
    assert a_row["pct_sector"] is None
