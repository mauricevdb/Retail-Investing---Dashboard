from datetime import date

import polars as pl

from dashboard.calc.normalized_5y import normalized_5y
from dashboard.calc.ttm import trace_ttm, ttm


def test_ttm_and_5y_median_computed() -> None:
    cik = "0000000001"
    concept = "OperatingIncomeLoss"
    t = date(2024, 3, 1)

    quarterly = [
        {
            "cik": cik,
            "concept": concept,
            "start": date(2022, 10, 1),
            "end": date(2022, 12, 31),
            "filed": date(2023, 2, 10),
            "value": 50.0,
            "fiscal_period": "Q4",
            "fiscal_year": 2022,
            "accn": "0000000001-23-000001",
        },
        {
            "cik": cik,
            "concept": concept,
            "start": date(2023, 1, 1),
            "end": date(2023, 3, 31),
            "filed": date(2023, 5, 10),
            "value": 100.0,
            "fiscal_period": "Q1",
            "fiscal_year": 2023,
            "accn": "0000000001-23-000002",
        },
        {
            "cik": cik,
            "concept": concept,
            "start": date(2023, 4, 1),
            "end": date(2023, 6, 30),
            "filed": date(2023, 8, 10),
            "value": 110.0,
            "fiscal_period": "Q2",
            "fiscal_year": 2023,
            "accn": "0000000001-23-000003",
        },
        {
            "cik": cik,
            "concept": concept,
            "start": date(2023, 7, 1),
            "end": date(2023, 9, 30),
            "filed": date(2023, 11, 10),
            "value": 120.0,
            "fiscal_period": "Q3",
            "fiscal_year": 2023,
            "accn": "0000000001-23-000004",
        },
        {
            "cik": cik,
            "concept": concept,
            "start": date(2023, 10, 1),
            "end": date(2023, 12, 31),
            "filed": date(2024, 2, 15),
            "value": 130.0,
            "fiscal_period": "Q4",
            "fiscal_year": 2023,
            "accn": "0000000001-24-000001",
        },
    ]

    annual = [
        {
            "cik": cik,
            "concept": concept,
            "end": date(2019, 12, 31),
            "filed": date(2020, 2, 15),
            "value": 200.0,
            "fiscal_period": "FY",
            "fiscal_year": 2019,
        },
        {
            "cik": cik,
            "concept": concept,
            "end": date(2020, 12, 31),
            "filed": date(2021, 2, 15),
            "value": 210.0,
            "fiscal_period": "FY",
            "fiscal_year": 2020,
        },
        {
            "cik": cik,
            "concept": concept,
            "end": date(2021, 12, 31),
            "filed": date(2022, 2, 15),
            "value": 190.0,
            "fiscal_period": "FY",
            "fiscal_year": 2021,
        },
        {
            "cik": cik,
            "concept": concept,
            "end": date(2022, 12, 31),
            "filed": date(2023, 2, 10),
            "value": 205.0,
            "fiscal_period": "FY",
            "fiscal_year": 2022,
        },
        {
            "cik": cik,
            "concept": concept,
            "end": date(2023, 12, 31),
            "filed": date(2024, 2, 15),
            "value": 240.0,
            "fiscal_period": "FY",
            "fiscal_year": 2023,
        },
    ]

    facts = pl.DataFrame(quarterly + annual)

    # Quatre derniers trimestres connus à t : 100+110+120+130 = 460 --
    # le trimestre 2022 (50) glisse hors de la fenêtre.
    ttm_value = ttm(facts, cik=cik, concept=concept, t=t)
    assert ttm_value == 460.0

    # Médiane des cinq derniers exercices [190, 200, 205, 210, 240] = 205.
    median_value = normalized_5y(facts, cik=cik, concept=concept, t=t)
    assert median_value == 205.0

    assert ttm_value != median_value


def test_ttm_excludes_year_to_date_cumulative_facts() -> None:
    # Reproduit exactement FISV (T90, /spec-verify sixième passage) : un
    # dépôt 10-Q publie systématiquement, pour un même trimestre, à la fois
    # le cumul depuis le début de l'exercice et le trimestre seul --
    # partageant end/filed/fiscal_period, mais avec un start différent.
    # calc.ttm doit toujours retenir le trimestre seul, jamais le cumul,
    # même si celui-ci apparaît en premier dans les données.
    cik = "0000000001"
    concept = "OperatingIncomeLoss"
    t = date(2024, 3, 1)

    def _quarter(
        fiscal_year_start: date,
        q_start: date,
        end: date,
        filed: date,
        cumulative_value: float,
        quarter_value: float,
        fiscal_period: str,
        fiscal_year: int,
    ) -> list[dict]:
        return [
            {
                "cik": cik,
                "concept": concept,
                "start": fiscal_year_start,
                "end": end,
                "filed": filed,
                "value": cumulative_value,
                "fiscal_period": fiscal_period,
                "fiscal_year": fiscal_year,
            },
            {
                "cik": cik,
                "concept": concept,
                "start": q_start,
                "end": end,
                "filed": filed,
                "value": quarter_value,
                "fiscal_period": fiscal_period,
                "fiscal_year": fiscal_year,
            },
        ]

    fy_start_2023 = date(2023, 1, 1)
    rows = []
    rows += _quarter(
        date(2022, 1, 1),
        date(2022, 10, 1),
        date(2022, 12, 31),
        date(2023, 2, 10),
        cumulative_value=999_999.0,
        quarter_value=50.0,
        fiscal_period="Q4",
        fiscal_year=2022,
    )
    rows += _quarter(
        fy_start_2023,
        date(2023, 1, 1),
        date(2023, 3, 31),
        date(2023, 5, 10),
        cumulative_value=100.0,
        quarter_value=100.0,
        fiscal_period="Q1",
        fiscal_year=2023,
    )
    rows += _quarter(
        fy_start_2023,
        date(2023, 4, 1),
        date(2023, 6, 30),
        date(2023, 8, 10),
        cumulative_value=210.0,
        quarter_value=110.0,
        fiscal_period="Q2",
        fiscal_year=2023,
    )
    rows += _quarter(
        fy_start_2023,
        date(2023, 7, 1),
        date(2023, 9, 30),
        date(2023, 11, 10),
        cumulative_value=330.0,
        quarter_value=120.0,
        fiscal_period="Q3",
        fiscal_year=2023,
    )
    rows += _quarter(
        fy_start_2023,
        date(2023, 10, 1),
        date(2023, 12, 31),
        date(2024, 2, 15),
        cumulative_value=460.0,
        quarter_value=130.0,
        fiscal_period="Q4",
        fiscal_year=2023,
    )

    facts = pl.DataFrame(rows)

    # Même résultat que le test précédent (460 = 100+110+120+130) --
    # jamais une valeur mêlant un cumul, quel que soit l'ordre des lignes
    # ou lequel des deux la déduplication aurait choisi par défaut.
    assert ttm(facts, cik=cik, concept=concept, t=t) == 460.0


def test_ttm_trace_returns_the_four_quarters_summed() -> None:
    # trace_ttm (T91) doit exposer les faits réellement sommés par ttm() --
    # sans quoi une valeur TTM affichée redeviendrait intraçable jusqu'à
    # ses faits déposés (invariant 8, même défaut que celui corrigé pour
    # roic en T79).
    cik = "0000000001"
    concept = "OperatingIncomeLoss"
    t = date(2024, 3, 1)

    quarterly = [
        {
            "cik": cik,
            "concept": concept,
            "start": date(2022, 10, 1),
            "end": date(2022, 12, 31),
            "filed": date(2023, 2, 10),
            "value": 50.0,
            "fiscal_period": "Q4",
            "fiscal_year": 2022,
            "accn": "0000000001-23-000001",
        },
        {
            "cik": cik,
            "concept": concept,
            "start": date(2023, 1, 1),
            "end": date(2023, 3, 31),
            "filed": date(2023, 5, 10),
            "value": 100.0,
            "fiscal_period": "Q1",
            "fiscal_year": 2023,
            "accn": "0000000001-23-000002",
        },
        {
            "cik": cik,
            "concept": concept,
            "start": date(2023, 4, 1),
            "end": date(2023, 6, 30),
            "filed": date(2023, 8, 10),
            "value": 110.0,
            "fiscal_period": "Q2",
            "fiscal_year": 2023,
            "accn": "0000000001-23-000003",
        },
        {
            "cik": cik,
            "concept": concept,
            "start": date(2023, 7, 1),
            "end": date(2023, 9, 30),
            "filed": date(2023, 11, 10),
            "value": 120.0,
            "fiscal_period": "Q3",
            "fiscal_year": 2023,
            "accn": "0000000001-23-000004",
        },
        {
            "cik": cik,
            "concept": concept,
            "start": date(2023, 10, 1),
            "end": date(2023, 12, 31),
            "filed": date(2024, 2, 15),
            "value": 130.0,
            "fiscal_period": "Q4",
            "fiscal_year": 2023,
            "accn": "0000000001-24-000001",
        },
    ]
    facts = pl.DataFrame(quarterly)

    components = trace_ttm(facts, cik=cik, concept=concept, t=t)

    # Quatre composantes -- le trimestre 2022 glisse hors de la fenêtre,
    # comme pour ttm() lui-même.
    assert len(components) == 4
    assert {c["end"] for c in components} == {
        date(2023, 3, 31),
        date(2023, 6, 30),
        date(2023, 9, 30),
        date(2023, 12, 31),
    }
    for component in components:
        assert component["concept"] == concept
        assert component["filed"] is not None
        assert component["accn"] is not None

    assert sum(c["value"] for c in components) == ttm(facts, cik=cik, concept=concept, t=t)
