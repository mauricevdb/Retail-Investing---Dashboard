from datetime import date

import polars as pl

from dashboard.calc.ratios import coverage_rate, indicator_status

END = date(2023, 12, 31)
FILED = date(2024, 2, 15)
T = date(2024, 3, 1)


def _fact(cik: str, concept: str, value: float) -> dict:
    return {"cik": cik, "concept": concept, "end": END, "filed": FILED, "value": value}


def _base_facts(cik: str, *, with_equity: bool, with_dna: bool, with_fcf: bool) -> pl.DataFrame:
    rows = [
        _fact(cik, "OperatingIncomeLoss", 100_000_000),
        _fact(cik, "LongTermDebtNoncurrent", 50_000_000),
        _fact(cik, "CashAndCashEquivalentsAtCarryingValue", 20_000_000),
    ]
    if with_equity:
        rows.append(_fact(cik, "StockholdersEquity", 200_000_000))
    if with_dna:
        rows.append(_fact(cik, "DepreciationDepletionAndAmortization", 15_000_000))
    if with_fcf:
        rows.append(_fact(cik, "NetCashProvidedByUsedInOperatingActivities", 40_000_000))
        rows.append(_fact(cik, "PaymentsToAcquirePropertyPlantAndEquipment", 10_000_000))
    return pl.DataFrame(rows)


def test_coverage_rate_reported_per_indicator() -> None:
    # Cinq titres, chacun manquant d'une seule composante différente, pour
    # une couverture partielle connue et distincte par indicateur.
    titres = {
        "T001": _base_facts("T001", with_equity=True, with_dna=True, with_fcf=True),  # complet
        "T002": _base_facts("T002", with_equity=False, with_dna=True, with_fcf=True),  # ROIC KO
        "T003": _base_facts(
            "T003", with_equity=True, with_dna=False, with_fcf=True
        ),  # net_debt/EBITDA KO
        "T004": _base_facts(
            "T004", with_equity=True, with_dna=True, with_fcf=True
        ),  # pct_sector KO
        "T005": _base_facts(
            "T005", with_equity=True, with_dna=True, with_fcf=False
        ),  # fcf_yield KO
    }
    pct_sector_by_titre = {"T001": 0.5, "T002": 0.5, "T003": 0.5, "T004": None, "T005": 0.5}

    statuses = [
        indicator_status(
            market_cap=500_000_000,
            facts=facts,
            cik=cik,
            end=END,
            t=T,
            pct_own_history=0.6,
            pct_sector=pct_sector_by_titre[cik],
        )
        for cik, facts in titres.items()
    ]

    rates = coverage_rate(statuses)

    assert rates["ev_ebit"] == (5, 5)
    assert rates["fcf_yield"] == (4, 5)
    assert rates["roic"] == (4, 5)
    assert rates["net_debt_ebitda"] == (4, 5)
    assert rates["pct_own_history"] == (5, 5)
    assert rates["pct_sector"] == (4, 5)
