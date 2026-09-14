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

    pl.DataFrame(
        {
            "cik": ["9999999999"],
            "concept": ["OperatingIncomeLoss"],
            "taxonomy": ["us-gaap"],
            "unit": ["USD"],
            "end": [date(2023, 12, 31)],
            "start": [date(2023, 1, 1)],
            "filed": [date(2024, 2, 1)],
            "accn": ["9999999999-24-000001"],
            "value": [50_000_000.0],
            "fiscal_period": ["FY"],
            "fiscal_year": [2023],
        }
    ).write_parquet(facts_path)

    return screen_path, facts_path


def test_app_smoke_screen_and_detail(tmp_path: Path, monkeypatch) -> None:
    screen_path, facts_path = _write_fixture(tmp_path)
    monkeypatch.setenv("DASHBOARD_SCREEN_RESULTS_PATH", str(screen_path))
    monkeypatch.setenv("DASHBOARD_FUNDAMENTALS_PATH", str(facts_path))

    at = AppTest.from_file(APP_PATH)
    at.run()
    assert not at.exception

    # `end` est un paramètre de configuration, pas une valeur devinée depuis
    # les données (cf. T77) : on le règle explicitement sur l'exercice
    # réellement couvert par la fixture avant de vérifier la trace.
    at.sidebar.date_input[0].set_value(date(2023, 12, 31)).run()
    assert not at.exception

    rendered_text = " ".join(element.value for element in at.text) + " ".join(
        element.value for element in at.caption
    )
    assert "1 titre(s) retenu(s)" in rendered_text
    assert "S&P" not in rendered_text
    # Exercice de référence (end) affiché explicitement (invariant 7) --
    # jamais un paramètre de modélisation influençant un chiffre sans
    # apparaître à l'écran.
    assert "2023-12-31" in rendered_text

    at.selectbox[0].select("TEST").run()
    assert not at.exception

    trace_text = " ".join(element.value for element in at.code)
    # Le composant tracé de l'EBIT doit remonter jusqu'au fait déposé :
    # champ source, end, filed, accn (critère 9) -- jamais une trace vide
    # pour un indicateur dont le tag primaire existe réellement.
    assert "OperatingIncomeLoss" in trace_text
    assert "2023, 12, 31" in trace_text  # end -- repr(date(2023, 12, 31))
    assert "2024, 2, 1" in trace_text  # filed -- repr(date(2024, 2, 1))
    assert "9999999999-24-000001" in trace_text  # accn
