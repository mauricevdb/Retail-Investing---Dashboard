from datetime import date

import polars as pl
import pytest

from dashboard.calc.ratios import indicator_status


def _fact(cik: str, concept: str, value: float, end: date, filed: date) -> dict:
    return {"cik": cik, "concept": concept, "end": end, "filed": filed, "value": value}


def test_missing_fundamental_flagged() -> None:
    cik = "0000000099"
    end = date(2023, 12, 31)
    filed = date(2024, 2, 15)
    t = date(2024, 3, 1)

    # Toutes les composantes fondamentales des quatre ratios sont présentes,
    # sauf les capitaux propres (et leur repli) -- capital investi, donc
    # ROIC, seul non calculable ; EV/EBIT, rendement FCF/EV et dette
    # nette/EBITDA n'en dépendent pas.
    facts = pl.DataFrame(
        [
            _fact(cik, "OperatingIncomeLoss", 100_000_000, end, filed),
            _fact(cik, "NetCashProvidedByUsedInOperatingActivities", 40_000_000, end, filed),
            _fact(cik, "PaymentsToAcquirePropertyPlantAndEquipment", 10_000_000, end, filed),
            _fact(cik, "LongTermDebtNoncurrent", 50_000_000, end, filed),
            _fact(cik, "CashAndCashEquivalentsAtCarryingValue", 20_000_000, end, filed),
            _fact(cik, "DepreciationDepletionAndAmortization", 15_000_000, end, filed),
        ]
    )

    status = indicator_status(
        market_cap=500_000_000,
        facts=facts,
        cik=cik,
        end=end,
        t=t,
        pct_own_history=0.65,
        pct_sector=0.40,
    )

    # Seul indicateur non calculable.
    assert status["roic"] is None

    # Les cinq autres sont produits normalement.
    # EV = 500M + dette nette 30M = 530M ; EBIT = 100M.
    assert status["ev_ebit"] == pytest.approx(530_000_000 / 100_000_000)
    # FCF = 40M - 10M = 30M.
    assert status["fcf_yield"] == pytest.approx(30_000_000 / 530_000_000)
    # EBITDA = 100M + 15M = 115M.
    assert status["net_debt_ebitda"] == pytest.approx(30_000_000 / 115_000_000)
    assert status["pct_own_history"] == 0.65
    assert status["pct_sector"] == 0.40
