from datetime import date

import polars as pl
import pytest

from ridash.fundamentals import ANNUAL_TAGS, latest_annual

FY24, FY25 = date(2024, 12, 31), date(2025, 12, 31)


def facts(*rows):
    return pl.DataFrame(
        [
            {"cik": cik, "tag": tag, "end": end, "value": value, "accn": "a"}
            for cik, tag, end, value in rows
        ],
        schema={
            "cik": pl.Int64,
            "tag": pl.Utf8,
            "end": pl.Date,
            "value": pl.Float64,
            "accn": pl.Utf8,
        },
    )


def row(df, cik=1):
    return df.filter(pl.col("cik") == cik).row(0, named=True)


def test_uses_latest_fiscal_year_and_balance_sheet_at_that_date():
    result = latest_annual(
        facts(
            (1, "OperatingIncomeLoss", FY24, 50.0),
            (1, "OperatingIncomeLoss", FY25, 80.0),
            (1, "CashAndCashEquivalentsAtCarryingValue", FY25, 10.0),
            (1, "CashAndCashEquivalentsAtCarryingValue", date(2026, 3, 31), 99.0),
        )
    )
    company = row(result)
    assert (company["fiscal_end"], company["ebit"], company["cash"]) == (FY25, 80.0, 10.0)


def test_tag_priority_falls_back_when_preferred_tag_is_missing():
    result = latest_annual(
        facts(
            (1, "OperatingIncomeLoss", FY25, 80.0),
            (1, "PaymentsToAcquireProductiveAssets", FY25, 7.0),
            (2, "OperatingIncomeLoss", FY25, 80.0),
            (2, "PaymentsToAcquirePropertyPlantAndEquipment", FY25, 5.0),
            (2, "PaymentsToAcquireProductiveAssets", FY25, 7.0),
        )
    )
    assert row(result, 1)["capex"] == 7.0
    assert row(result, 2)["capex"] == 5.0


def test_debt_adds_current_portion_and_short_term_borrowings():
    result = latest_annual(
        facts(
            (1, "OperatingIncomeLoss", FY25, 80.0),
            (1, "LongTermDebtNoncurrent", FY25, 100.0),
            (1, "LongTermDebtCurrent", FY25, 20.0),
            (1, "ShortTermBorrowings", FY25, 5.0),
        )
    )
    company = row(result)
    assert company["debt"] == pytest.approx(125.0)
    assert company["debt_source"] == "LongTermDebtNoncurrent"


@pytest.mark.parametrize(
    ("interest", "expected_debt"),
    [(None, None), (1.0, 0.0), (10.0, None)],
    ids=["no-interest-reported", "immaterial-interest", "material-interest"],
)
def test_unreported_debt_is_zero_only_with_immaterial_reported_interest(interest, expected_debt):
    rows = [(1, "OperatingIncomeLoss", FY25, 100.0)]
    if interest is not None:
        rows.append((1, "InterestExpense", FY25, interest))
    assert row(latest_annual(facts(*rows)))["debt"] == expected_debt


def test_combined_debt_total_is_not_topped_up_with_short_term_borrowings():
    result = latest_annual(
        facts(
            (1, "OperatingIncomeLoss", FY25, 80.0),
            (1, "DebtLongtermAndShorttermCombinedAmount", FY25, 40.0),
            (1, "LongTermDebt", FY25, 30.0),
            (1, "ShortTermBorrowings", FY25, 10.0),
        )
    )
    assert row(result)["debt"] == 40.0


def test_zero_current_portion_is_not_proof_of_no_debt():
    result = latest_annual(
        facts(
            (1, "OperatingIncomeLoss", FY25, 100.0),
            (1, "ConvertibleNotesPayableCurrent", FY25, 0.0),
            (1, "InterestPaidNet", FY25, 30.0),
        )
    )
    assert row(result)["debt"] is None


def test_interest_paid_counts_as_evidence_of_debt():
    result = latest_annual(
        facts((1, "OperatingIncomeLoss", FY25, 100.0), (1, "InterestPaidNet", FY25, 50.0))
    )
    assert row(result)["debt"] is None


def test_ebit_falls_back_to_pretax_income_plus_interest():
    pretax = ANNUAL_TAGS["pretax_income"][0]
    result = latest_annual(facts((1, pretax, FY25, 90.0), (1, "InterestExpense", FY25, 10.0)))
    company = row(result)
    assert (company["ebit"], company["ebit_source"]) == (100.0, "pre-tax income + interest")


def test_company_without_income_statement_is_left_out():
    result = latest_annual(
        facts((1, "OperatingIncomeLoss", FY25, 80.0), (2, "StockholdersEquity", FY25, 10.0))
    )
    assert result["cik"].to_list() == [1]
