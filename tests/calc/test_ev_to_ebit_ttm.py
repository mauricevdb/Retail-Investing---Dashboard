from datetime import date

import polars as pl

from dashboard.calc.ratios import ev_to_ebit

_CIK = "0000000001"
_END = date(2023, 12, 31)
_T = date(2024, 3, 1)


def _facts() -> pl.DataFrame:
    quarterly = [
        {
            "cik": _CIK,
            "concept": "OperatingIncomeLoss",
            "start": date(2023, 1, 1),
            "end": date(2023, 3, 31),
            "filed": date(2023, 5, 10),
            "value": 100_000_000.0,
            "fiscal_period": "Q1",
            "fiscal_year": 2023,
        },
        {
            "cik": _CIK,
            "concept": "OperatingIncomeLoss",
            "start": date(2023, 4, 1),
            "end": date(2023, 6, 30),
            "filed": date(2023, 8, 10),
            "value": 110_000_000.0,
            "fiscal_period": "Q2",
            "fiscal_year": 2023,
        },
        {
            "cik": _CIK,
            "concept": "OperatingIncomeLoss",
            "start": date(2023, 7, 1),
            "end": date(2023, 9, 30),
            "filed": date(2023, 11, 10),
            "value": 120_000_000.0,
            "fiscal_period": "Q3",
            "fiscal_year": 2023,
        },
        {
            "cik": _CIK,
            "concept": "OperatingIncomeLoss",
            "start": date(2023, 10, 1),
            "end": date(2023, 12, 31),
            "filed": date(2024, 2, 15),
            "value": 130_000_000.0,
            "fiscal_period": "Q4",
            "fiscal_year": 2023,
        },
        # Valeur annuelle (FY) très différente de la somme des quatre
        # trimestres -- si ev_to_ebit utilisait encore le point-in-time,
        # ce test échouerait plutôt que de confirmer le câblage du TTM.
        {
            "cik": _CIK,
            "concept": "OperatingIncomeLoss",
            "start": date(2023, 1, 1),
            "end": date(2023, 12, 31),
            "filed": date(2024, 2, 15),
            "value": 999_000_000.0,
            "fiscal_period": "FY",
            "fiscal_year": 2023,
        },
    ]
    balance_sheet = [
        {
            "cik": _CIK,
            "concept": "LongTermDebtNoncurrent",
            "start": None,
            "end": _END,
            "filed": date(2024, 2, 15),
            "value": 40_000_000.0,
            "fiscal_period": "FY",
            "fiscal_year": 2023,
        },
        {
            "cik": _CIK,
            "concept": "CashAndCashEquivalentsAtCarryingValue",
            "start": None,
            "end": _END,
            "filed": date(2024, 2, 15),
            "value": 10_000_000.0,
            "fiscal_period": "FY",
            "fiscal_year": 2023,
        },
    ]
    return pl.DataFrame(quarterly + balance_sheet)


def test_ev_to_ebit_uses_ttm() -> None:
    facts = _facts()
    market_cap = 2_000_000_000.0

    # TTM EBIT = 100+110+120+130 = 460M, jamais la valeur annuelle FY
    # (999M) que le point-in-time aurait résolue en priorité.
    ttm_ebit = 460_000_000.0
    net_debt = 40_000_000.0 - 10_000_000.0
    expected = (market_cap + net_debt) / ttm_ebit

    value = ev_to_ebit(market_cap=market_cap, facts=facts, cik=_CIK, end=_END, t=_T)

    assert value == expected
