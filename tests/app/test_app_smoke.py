from datetime import date
from pathlib import Path

import polars as pl
from streamlit.testing.v1 import AppTest

APP_PATH = str(Path(__file__).parent.parent.parent / "src" / "dashboard" / "app" / "main.py")


def _write_fixture(tmp_path: Path) -> tuple[Path, Path]:
    screen_path = tmp_path / "screen_results.parquet"
    facts_path = tmp_path / "fundamentals_raw.parquet"

    pl.DataFrame(
        {
            "date": [date(2024, 3, 1)],
            "cik": ["9999999999"],
            "ticker": ["TEST"],
            "ev_ebit": [10.5],
            "fcf_yield": [None],
            "roic": [None],
            "net_debt_ebitda": [None],
            "pct_own_history": [None],
            "pct_sector": [None],
            "currency": ["USD"],
            "rank": [1],
        }
    ).write_parquet(screen_path)

    # Deux exercices distincts pour le même titre (T80) : le sélecteur
    # d'`end` doit être contraint à ces deux valeurs réellement connues,
    # jamais une date arbitraire choisie librement.
    pl.DataFrame(
        {
            "cik": ["9999999999", "9999999999"],
            "concept": ["OperatingIncomeLoss", "OperatingIncomeLoss"],
            "taxonomy": ["us-gaap", "us-gaap"],
            "unit": ["USD", "USD"],
            "end": [date(2023, 12, 31), date(2022, 12, 31)],
            "start": [date(2023, 1, 1), date(2022, 1, 1)],
            "filed": [date(2024, 2, 1), date(2023, 2, 1)],
            "accn": ["9999999999-24-000001", "9999999999-23-000001"],
            "value": [50_000_000.0, 40_000_000.0],
            "fiscal_period": ["FY", "FY"],
            "fiscal_year": [2023, 2022],
        }
    ).write_parquet(facts_path)

    return screen_path, facts_path


def test_app_smoke_screen_and_detail(tmp_path: Path, monkeypatch) -> None:
    screen_path, facts_path = _write_fixture(tmp_path)
    monkeypatch.setenv("DASHBOARD_SCREEN_RESULTS_PATH", str(screen_path))
    monkeypatch.setenv("DASHBOARD_FUNDAMENTALS_PATH", str(facts_path))

    # Délai explicite et large (T82) : le défaut de la bibliothèque (3 s)
    # dépend de la charge machine au moment du test, pas de la correction
    # du script -- observé occasionnellement dépassé sous charge, jamais
    # en isolation.
    at = AppTest.from_file(APP_PATH, default_timeout=15)
    at.run()
    assert not at.exception

    rendered_text = " ".join(element.value for element in at.text) + " ".join(
        element.value for element in at.caption
    )
    assert "1 titre(s) retenu(s)" in rendered_text
    assert "S&P" not in rendered_text

    # Le titre est sélectionné avant l'exercice (T80) : les options d'`end`
    # dépendent des faits du titre choisi, pas l'inverse.
    at.selectbox[0].select("TEST").run()
    assert not at.exception

    # `end` est contraint aux deux exercices réellement présents dans les
    # faits de ce titre -- jamais une date libre devinée ou arbitraire
    # (invariant 7, cf. T80 : le décalage entre l'`end` choisi et l'`end`
    # réel d'une valeur affichée rendait sa trace dénuée de sens).
    end_options = at.sidebar.selectbox[0].options
    assert set(end_options) == {"2023-12-31", "2022-12-31"}
    assert not at.sidebar.date_input  # plus de sélecteur libre

    at.sidebar.selectbox[0].select(date(2023, 12, 31)).run()
    assert not at.exception

    rendered_text = " ".join(element.value for element in at.text) + " ".join(
        element.value for element in at.caption
    )
    # Exercice de référence (end) affiché explicitement (invariant 7).
    assert "2023-12-31" in rendered_text

    trace_text = " ".join(element.value for element in at.code)
    # Le composant tracé de l'EBIT doit remonter jusqu'au fait déposé :
    # champ source, end, filed, accn (critère 9) -- jamais une trace vide
    # pour un indicateur dont le tag primaire existe réellement.
    assert "OperatingIncomeLoss" in trace_text
    assert "2023, 12, 31" in trace_text  # end -- repr(date(2023, 12, 31))
    assert "2024, 2, 1" in trace_text  # filed -- repr(date(2024, 2, 1))
    assert "9999999999-24-000001" in trace_text  # accn

    # Choisir l'autre exercice connu retrace un chiffre différent, cohérent
    # avec ce même exercice -- jamais une valeur figée sur le premier choix.
    at.sidebar.selectbox[0].select(date(2022, 12, 31)).run()
    assert not at.exception
    trace_text_2022 = " ".join(element.value for element in at.code)
    assert "2022, 12, 31" in trace_text_2022
    assert "9999999999-23-000001" in trace_text_2022


def test_app_smoke_end_defaults_to_most_recent_annual_period(tmp_path: Path, monkeypatch) -> None:
    # Reproduit le cas réel FISV (T92, premier aperçu sur la vraie sortie de
    # production) : un exercice annuel plus ancien coexiste avec un exercice
    # trimestriel plus récent pour le même titre. Le défaut doit rester
    # l'exercice annuel -- jamais le trimestriel plus récent mais sans
    # rapport garanti avec les valeurs déjà calculées et affichées dans le
    # tableau (invariant 7 : un défaut trompeur rendait roic/net_debt_ebitda
    # faussement "non_traceable").
    screen_path = tmp_path / "screen_results.parquet"
    facts_path = tmp_path / "fundamentals_raw.parquet"

    pl.DataFrame(
        {
            "date": [date(2024, 8, 1)],
            "cik": ["9999999999"],
            "ticker": ["TEST"],
            "ev_ebit": [10.5],
            "fcf_yield": [None],
            "roic": [None],
            "net_debt_ebitda": [None],
            "pct_own_history": [None],
            "pct_sector": [None],
            "currency": ["USD"],
            "rank": [1],
        }
    ).write_parquet(screen_path)

    pl.DataFrame(
        {
            "cik": ["9999999999", "9999999999"],
            "concept": ["OperatingIncomeLoss", "OperatingIncomeLoss"],
            "taxonomy": ["us-gaap", "us-gaap"],
            "unit": ["USD", "USD"],
            "end": [date(2023, 12, 31), date(2024, 6, 30)],
            "start": [date(2023, 1, 1), date(2024, 4, 1)],
            "filed": [date(2024, 2, 1), date(2024, 8, 7)],
            "accn": ["9999999999-24-000001", "9999999999-24-000002"],
            "value": [50_000_000.0, 15_000_000.0],
            "fiscal_period": ["FY", "Q2"],
            "fiscal_year": [2023, 2024],
        }
    ).write_parquet(facts_path)

    monkeypatch.setenv("DASHBOARD_SCREEN_RESULTS_PATH", str(screen_path))
    monkeypatch.setenv("DASHBOARD_FUNDAMENTALS_PATH", str(facts_path))

    at = AppTest.from_file(APP_PATH, default_timeout=15)
    at.run()
    assert not at.exception

    at.selectbox[0].select("TEST").run()
    assert not at.exception

    # L'exercice trimestriel (2024-06-30) est plus récent, mais le défaut
    # doit rester l'exercice annuel (2023-12-31).
    assert at.sidebar.selectbox[0].value == date(2023, 12, 31)
