import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.ebit_bridge import resolve, resolve_ttm, trace, trace_ttm
from dashboard.calc.ttm import ttm
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_ebit_bridge_fallback_chain() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Primaire : Alpha porte us-gaap:OperatingIncomeLoss.
    alpha_value, alpha_tag = resolve(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_value == 500000000
    assert alpha_tag == "us-gaap:OperatingIncomeLoss"

    # Repli : Gamma n'a pas OperatingIncomeLoss, reconstruction depuis le
    # résultat net (40M) + impôts (10M) + intérêts (5M) = 55M.
    gamma_value, gamma_tag = resolve(_facts("0000000003"), cik="0000000003", end=end, t=t)
    assert gamma_value == 55000000
    assert gamma_tag == (
        "us-gaap:NetIncomeLoss + us-gaap:IncomeTaxExpenseBenefit + interest_bridge"
    )

    # Non calculable : Beta est IFRS, zéro fait après la liste blanche (T5).
    beta_value, beta_tag = resolve(_facts("0000000002"), cik="0000000002", end=end, t=t)
    assert beta_value is None
    assert beta_tag is None


def _four_quarters(cik: str) -> pl.DataFrame:
    return pl.DataFrame(
        [
            {
                "cik": cik,
                "concept": "OperatingIncomeLoss",
                "start": date(2023, 1, 1),
                "end": date(2023, 3, 31),
                "filed": date(2023, 5, 10),
                "value": 100.0,
                "fiscal_period": "Q1",
                "fiscal_year": 2023,
                "accn": f"{cik}-23-000001",
            },
            {
                "cik": cik,
                "concept": "OperatingIncomeLoss",
                "start": date(2023, 4, 1),
                "end": date(2023, 6, 30),
                "filed": date(2023, 8, 10),
                "value": 110.0,
                "fiscal_period": "Q2",
                "fiscal_year": 2023,
                "accn": f"{cik}-23-000002",
            },
            {
                "cik": cik,
                "concept": "OperatingIncomeLoss",
                "start": date(2023, 7, 1),
                "end": date(2023, 9, 30),
                "filed": date(2023, 11, 10),
                "value": 120.0,
                "fiscal_period": "Q3",
                "fiscal_year": 2023,
                "accn": f"{cik}-23-000003",
            },
            {
                "cik": cik,
                "concept": "OperatingIncomeLoss",
                "start": date(2023, 10, 1),
                "end": date(2023, 12, 31),
                "filed": date(2024, 2, 15),
                "value": 130.0,
                "fiscal_period": "Q4",
                "fiscal_year": 2023,
                "accn": f"{cik}-24-000001",
            },
        ]
    )


def test_ebit_bridge_resolve_ttm_uses_four_quarters() -> None:
    cik = "0000000001"
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)
    facts = _four_quarters(cik)

    value, tag = resolve_ttm(facts, cik=cik, end=end, t=t)

    assert value == ttm(facts, cik=cik, concept="OperatingIncomeLoss", t=t)
    assert value == 460.0
    assert tag == "us-gaap:OperatingIncomeLoss (TTM)"

    components = trace_ttm(facts, cik=cik, end=end, t=t)
    assert len(components) == 4
    assert sum(c["value"] for c in components) == value


def test_ebit_bridge_resolve_ttm_falls_back_to_point_in_time_below_four_quarters() -> None:
    # Alpha (fixture figée) ne porte qu'un fait annuel, jamais de trimestres
    # -- repli explicite sur la chaîne point-in-time existante (T91),
    # jamais un non-calculable qui jetterait une donnée par ailleurs
    # parfaitement exploitable (invariant 7).
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)
    alpha_facts = _facts("0000000001")

    ttm_value, ttm_tag = resolve_ttm(alpha_facts, cik="0000000001", end=end, t=t)
    point_in_time_value, point_in_time_tag = resolve(alpha_facts, cik="0000000001", end=end, t=t)

    assert ttm_value == point_in_time_value == 500000000
    assert ttm_tag == point_in_time_tag == "us-gaap:OperatingIncomeLoss"

    # La trace doit correspondre exactement au chemin réellement emprunté --
    # jamais quatre composantes fictives pour un repli point-in-time.
    components = trace_ttm(alpha_facts, cik="0000000001", end=end, t=t)
    assert components == trace(alpha_facts, cik="0000000001", end=end, t=t)

    # Trois trimestres seulement, aucun fait annuel de repli disponible :
    # jamais une approximation sur trois (invariant 7).
    cik_no_fallback = "0000000099"
    three_quarters = _four_quarters(cik_no_fallback).head(3)
    missing_value, missing_tag = resolve_ttm(three_quarters, cik=cik_no_fallback, end=end, t=t)
    assert missing_value is None
    assert missing_tag is None
    assert trace_ttm(three_quarters, cik=cik_no_fallback, end=end, t=t) == []
