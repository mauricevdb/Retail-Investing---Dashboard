import time
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.pipeline.daily_run import run_daily

_N = 1000
_END = date(2023, 12, 31)
_FILED = date(2024, 2, 15)
_T = date(2024, 3, 1)
# Cinq divisions SIC éligibles (hors 6000-6799), un code par division, pour
# que le groupe sectoriel de chacune dépasse largement le seuil de 10
# (critère 20) une fois réparti sur ~1000 titres.
_SIC_BY_DIVISION = (500, 1200, 2500, 5100, 7500)


def _build_fixture() -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame, pl.DataFrame, set[str]]:
    tickers = [f"SYN{i:04d}" for i in range(_N)]
    ciks = [f"{9_000_000_000 + i:010d}" for i in range(_N)]

    facts_rows = []
    for i, cik in enumerate(ciks):
        # Actions en circulation strictement décroissantes avec l'index :
        # classement déterministe, rang i+1 == index i, puisque le prix est
        # constant (seules les actions en circulation font varier la
        # capitalisation lissée).
        shares = 1_000_000_000.0 - i * 100_000.0
        # EBIT croissant avec l'index -- combiné à une capitalisation
        # décroissante, EV/EBIT décroît avec l'index : les derniers rangs
        # par capitalisation (proches du seuil de coupure) sont ceux
        # retenus par le classement final (plafonné à 25, T53).
        ebit = 50_000_000.0 + i * 100_000.0
        facts_rows.append(
            {
                "cik": cik,
                "concept": "EntityCommonStockSharesOutstanding",
                "taxonomy": "dei",
                "end": _END,
                "filed": _FILED,
                "value": shares,
            }
        )
        facts_rows.append(
            {
                "cik": cik,
                "concept": "OperatingIncomeLoss",
                "taxonomy": None,
                "end": _END,
                "filed": _FILED,
                "value": ebit,
            }
        )
        facts_rows.append(
            {
                "cik": cik,
                "concept": "LongTermDebtNoncurrent",
                "taxonomy": None,
                "end": _END,
                "filed": _FILED,
                "value": 10_000_000.0,
            }
        )
        facts_rows.append(
            {
                "cik": cik,
                "concept": "CashAndCashEquivalentsAtCarryingValue",
                "taxonomy": None,
                "end": _END,
                "filed": _FILED,
                "value": 5_000_000.0,
            }
        )
    facts = pl.DataFrame(facts_rows)

    # shares_outstanding ici n'est qu'un espace réservé : _derive_shares_pit
    # (T71) le remplace par la valeur dérivée des faits ci-dessus pour
    # chaque titre SIC-éligible, avant même le classement.
    shares_pit = pl.DataFrame({"ticker": tickers, "cik": ciks, "shares_outstanding": [1.0] * _N})
    prices_adj = pl.DataFrame({"ticker": tickers, "date": [_T] * _N, "close_adj": [50.0] * _N})
    sic_codes = pl.DataFrame(
        {
            "ticker": tickers,
            "sic": [str(_SIC_BY_DIVISION[i % len(_SIC_BY_DIVISION)]) for i in range(_N)],
            "entity_type": ["operating"] * _N,
            "as_of": [_END] * _N,
        }
    )

    # Appartenance antérieure : les 900 titres aux plus fortes capitalisations
    # (index 0 à 899, cf. actions en circulation décroissantes ci-dessus).
    # Avec n=900/buffer=100 par défaut, l'hystérésis doit alors retenir
    # exactement ce même ensemble de 900 -- ni plus (rang 901-1000 jamais
    # membres, exclus dès que leur rang dépasse 900-100=800), ni moins
    # (rang 1-900 déjà membres, retenus tant que leur rang reste <= 900+100).
    hier_membership = set(tickers[:900])

    return facts, shares_pit, prices_adj, sic_codes, hier_membership


def test_daily_run_at_scale_default_plausible_range_and_real_sector_percentile(
    tmp_path: Path,
) -> None:
    facts, shares_pit, prices_adj, sic_codes, hier_membership = _build_fixture()

    universe_history_path = tmp_path / "universe_membership.parquet"
    screen_history_path = tmp_path / "screen_results.parquet"

    started = time.perf_counter()
    view_text = run_daily(
        shares_pit=shares_pit,
        prices_adj=prices_adj,
        sic_codes=sic_codes,
        hier_membership=hier_membership,
        t=_T,
        universe_history_path=universe_history_path,
        facts=facts,
        end=_END,
        thresholds={},
        screen_history_path=screen_history_path,
        # Valeurs par défaut de production (n=900, buffer=100,
        # plausible_range=(700, 1100)) volontairement NON réduites --
        # c'est précisément ce que cette tâche vérifie pour la première
        # fois (T81).
    )
    elapsed = time.perf_counter() - started
    print(f"\nrun_daily sur {_N} titres synthétiques : {elapsed:.2f}s")
    # Plafond large, jamais un test de performance strict (hors-tests de
    # spec.md) : seulement un garde-fou contre un blocage réel.
    assert elapsed < 60.0

    membership = pl.read_parquet(universe_history_path)
    assert membership.filter(pl.col("in_universe")).height == 900

    assert view_text is not None

    written = pl.read_parquet(screen_history_path)
    assert written.height == 25  # plafond du classement (critère 16)

    # Le percentile sectoriel réel (groupe >= 10, critère 20) doit être
    # effectivement calculé -- jamais seulement son repli, jusqu'ici jamais
    # exercé par aucun test existant.
    sector_percentiles = written["pct_sector"].to_list()
    assert any(value is not None for value in sector_percentiles)
    assert all(value is None or 0.0 <= value <= 1.0 for value in sector_percentiles)
