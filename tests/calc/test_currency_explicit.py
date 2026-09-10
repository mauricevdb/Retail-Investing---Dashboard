from datetime import date

import polars as pl

from dashboard.calc.ratios import indicator_status

END = date(2023, 12, 31)
FILED = date(2024, 2, 15)
T = date(2024, 3, 1)


def _fact(cik: str, concept: str, value: float) -> dict:
    return {"cik": cik, "concept": concept, "end": END, "filed": FILED, "value": value}


def _base_facts(cik: str, scale: float) -> pl.DataFrame:
    return pl.DataFrame(
        [
            _fact(cik, "OperatingIncomeLoss", 100_000_000 * scale),
            _fact(cik, "LongTermDebtNoncurrent", 50_000_000 * scale),
            _fact(cik, "CashAndCashEquivalentsAtCarryingValue", 20_000_000 * scale),
        ]
    )


def test_currency_explicit_no_conversion() -> None:
    # Deux titres, mêmes proportions, échelle en dollars doublée pour le
    # second -- une conversion implicite modifierait le ratio, une simple
    # mise à l'échelle proportionnelle en USD ne le doit pas.
    status_a = indicator_status(
        market_cap=500_000_000,
        facts=_base_facts("A1", scale=1),
        cik="A1",
        end=END,
        t=T,
        pct_own_history=0.5,
        pct_sector=0.5,
    )
    status_b = indicator_status(
        market_cap=1_000_000_000,
        facts=_base_facts("A2", scale=2),
        cik="A2",
        end=END,
        t=T,
        pct_own_history=0.5,
        pct_sector=0.5,
    )

    assert status_a["currency"] == "USD"
    assert status_b["currency"] == "USD"
    assert status_a["currency"] == status_b["currency"]

    # Aucune conversion appliquée : le ratio (sans dimension monétaire)
    # reste identique malgré le doublement de toutes les grandeurs en USD.
    assert status_a["ev_ebit"] == status_b["ev_ebit"]
