import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.debt_bridge import resolve
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_debt_bridge_sums_available_components() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Alpha porte dette long terme (100M) et courante (20M) : somme = 120M.
    alpha_value, alpha_tag = resolve(_facts("0000000001"), cik="0000000001", end=end, t=t)
    assert alpha_value == 120000000
    assert alpha_tag == "us-gaap:LongTermDebtNoncurrent + us-gaap:LongTermDebtCurrent"

    # Non calculable : Beta est IFRS, aucune composante trouvée -- jamais zéro.
    beta_value, beta_tag = resolve(_facts("0000000002"), cik="0000000002", end=end, t=t)
    assert beta_value is None
    assert beta_tag is None


def test_debt_bridge_falls_back_to_combined_total_when_no_component_found() -> None:
    # Découvert sur Ford (T75/T76) : la dette y est taguée sous un total
    # déjà combiné court terme + long terme (DebtAndCapitalLeaseObligations),
    # jamais décomposée sous les tags que les trois sous-résolutions
    # connaissent. Ce repli n'est utilisé qu'en dernier recours -- jamais
    # additionné à une décomposition partielle.
    end = date(2023, 12, 31)
    filed = date(2024, 2, 15)
    t = date(2024, 3, 1)
    cik = "9999999901"

    facts = pl.DataFrame(
        [
            {
                "cik": cik,
                "concept": "DebtAndCapitalLeaseObligations",
                "end": end,
                "filed": filed,
                "value": 49_319_000_000.0,
            },
        ]
    )

    value, tag = resolve(facts, cik=cik, end=end, t=t)

    assert value == 49_319_000_000.0
    assert tag == "us-gaap:DebtAndCapitalLeaseObligations"


def test_debt_bridge_never_double_counts_combined_total() -> None:
    # Un émetteur dont au moins une composante se résout normalement ne
    # doit jamais voir DebtAndCapitalLeaseObligations s'additionner
    # par-dessus, même s'il est présent dans les faits.
    end = date(2023, 12, 31)
    filed = date(2024, 2, 15)
    t = date(2024, 3, 1)
    cik = "9999999902"

    facts = pl.DataFrame(
        [
            {
                "cik": cik,
                "concept": "LongTermDebtNoncurrent",
                "end": end,
                "filed": filed,
                "value": 100_000_000.0,
            },
            {
                "cik": cik,
                "concept": "DebtAndCapitalLeaseObligations",
                "end": end,
                "filed": filed,
                "value": 49_319_000_000.0,
            },
        ]
    )

    value, tag = resolve(facts, cik=cik, end=end, t=t)

    assert value == 100_000_000.0
    assert tag == "us-gaap:LongTermDebtNoncurrent"
