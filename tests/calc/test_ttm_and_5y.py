from datetime import date

import polars as pl

from dashboard.calc.normalized_5y import normalized_5y
from dashboard.calc.ttm import ttm


def test_ttm_and_5y_median_computed() -> None:
    cik = "0000000001"
    concept = "OperatingIncomeLoss"
    t = date(2024, 3, 1)

    quarterly = [
        {
            "cik": cik,
            "concept": concept,
            "end": date(2022, 12, 31),
            "filed": date(2023, 2, 10),
            "value": 50.0,
            "fiscal_period": "Q4",
            "fiscal_year": 2022,
        },
        {
            "cik": cik,
            "concept": concept,
            "end": date(2023, 3, 31),
            "filed": date(2023, 5, 10),
            "value": 100.0,
            "fiscal_period": "Q1",
            "fiscal_year": 2023,
        },
        {
            "cik": cik,
            "concept": concept,
            "end": date(2023, 6, 30),
            "filed": date(2023, 8, 10),
            "value": 110.0,
            "fiscal_period": "Q2",
            "fiscal_year": 2023,
        },
        {
            "cik": cik,
            "concept": concept,
            "end": date(2023, 9, 30),
            "filed": date(2023, 11, 10),
            "value": 120.0,
            "fiscal_period": "Q3",
            "fiscal_year": 2023,
        },
        {
            "cik": cik,
            "concept": concept,
            "end": date(2023, 12, 31),
            "filed": date(2024, 2, 15),
            "value": 130.0,
            "fiscal_period": "Q4",
            "fiscal_year": 2023,
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
