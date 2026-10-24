from datetime import date, timedelta

import polars as pl
import pytest

from ridash.fundamentals import FLOW_TAG_LIST, FLOW_TAGS, load, trailing
from ridash.sources.sec import FACT_SCHEMA

AS_OF = date(2026, 9, 30)
FY24, FY25 = date(2024, 12, 31), date(2025, 12, 31)
H1_25, H1_26 = date(2025, 6, 30), date(2026, 6, 30)


def fact(tag, value, end, start=None, cik=1, filed=None, accn="a", form="10-K"):
    return {
        "cik": cik,
        "tag": tag,
        "start": start,
        "end": end,
        "value": value,
        "accn": accn,
        "form": form,
        "filed": filed or end + timedelta(days=60),
    }


def facts(*rows):
    """(cik, tag, end, value) rows: flows cover the calendar year ending at `end`, balance-sheet
    items are measured at `end`."""
    return pl.DataFrame(
        [
            fact(tag, value, end, cik=cik, start=date(end.year, 1, 1))
            if tag in FLOW_TAG_LIST
            else fact(tag, value, end, cik=cik)
            for cik, tag, end, value in rows
        ],
        schema=FACT_SCHEMA,
    )


def annual(df):
    return trailing(df, AS_OF)


def row(df, cik=1):
    return df.filter(pl.col("cik") == cik).row(0, named=True)


def test_twelve_months_are_rebuilt_from_the_year_to_date():
    jan25, jan26 = date(2025, 1, 1), date(2026, 1, 1)
    df = pl.DataFrame(
        [
            fact("OperatingIncomeLoss", 100.0, FY25, start=jan25),
            fact("OperatingIncomeLoss", 30.0, FY25, start=date(2025, 10, 1)),  # fourth quarter
            fact("OperatingIncomeLoss", 40.0, H1_25, start=jan25, form="10-Q"),
            fact("OperatingIncomeLoss", 60.0, H1_26, start=jan26, accn="q", form="10-Q"),
            fact("OperatingIncomeLoss", 35.0, H1_26, start=date(2026, 4, 1), accn="q", form="10-Q"),
            fact("PaymentsToAcquirePropertyPlantAndEquipment", 12.0, FY25, start=jan25),
            fact("CashAndCashEquivalentsAtCarryingValue", 10.0, FY25),
            fact("CashAndCashEquivalentsAtCarryingValue", 7.0, H1_26, accn="q", form="10-Q"),
        ],
        schema=FACT_SCHEMA,
    )
    company = row(annual(df))
    assert (company["period_end"], company["form"], company["accn"]) == (H1_26, "10-Q", "q")
    assert company["ebit"] == pytest.approx(120.0)  # 100 + 60 - 40
    assert company["cash"] == 7.0  # balance sheet at the end of the period
    assert company["capex"] is None  # reported for the fiscal year only: no twelve months


def test_fiscal_year_is_used_as_is_when_it_is_the_latest_period():
    company = row(
        annual(
            facts((1, "OperatingIncomeLoss", FY24, 50.0), (1, "OperatingIncomeLoss", FY25, 80.0))
        )
    )
    assert (company["period_end"], company["ebit"]) == (FY25, 80.0)


def test_a_snapshot_only_sees_what_was_filed_by_its_date():
    jan25 = date(2025, 1, 1)
    df = pl.DataFrame(
        [
            fact("OperatingIncomeLoss", 80.0, FY25, start=jan25, filed=date(2026, 2, 27)),
            fact("OperatingIncomeLoss", 90.0, FY25, start=jan25, filed=date(2026, 10, 15)),
            fact(
                "OperatingIncomeLoss",
                70.0,
                date(2026, 9, 30),
                start=date(2026, 1, 1),
                filed=date(2026, 10, 30),
            ),
        ],
        schema=FACT_SCHEMA,
    )
    company = row(annual(df))
    assert (company["period_end"], company["ebit"]) == (FY25, 80.0)


def test_company_whose_latest_report_is_too_old_is_left_out():
    result = annual(
        facts((1, "OperatingIncomeLoss", FY25, 80.0), (2, "OperatingIncomeLoss", FY24, 80.0))
    )
    assert result["cik"].to_list() == [1]


def test_tag_priority_falls_back_when_preferred_tag_is_missing():
    result = annual(
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
    result = annual(
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
    assert row(annual(facts(*rows)))["debt"] == expected_debt


def test_combined_debt_total_is_not_topped_up_with_short_term_borrowings():
    result = annual(
        facts(
            (1, "OperatingIncomeLoss", FY25, 80.0),
            (1, "DebtLongtermAndShorttermCombinedAmount", FY25, 40.0),
            (1, "LongTermDebt", FY25, 30.0),
            (1, "ShortTermBorrowings", FY25, 10.0),
        )
    )
    assert row(result)["debt"] == 40.0


def test_zero_current_portion_is_not_proof_of_no_debt():
    result = annual(
        facts(
            (1, "OperatingIncomeLoss", FY25, 100.0),
            (1, "ConvertibleNotesPayableCurrent", FY25, 0.0),
            (1, "InterestPaidNet", FY25, 30.0),
        )
    )
    assert row(result)["debt"] is None


def test_interest_paid_counts_as_evidence_of_debt():
    result = annual(
        facts((1, "OperatingIncomeLoss", FY25, 100.0), (1, "InterestPaidNet", FY25, 50.0))
    )
    assert row(result)["debt"] is None


def test_ebit_falls_back_to_pretax_income_plus_interest():
    pretax = FLOW_TAGS["pretax_income"][0]
    result = annual(facts((1, pretax, FY25, 90.0), (1, "InterestExpense", FY25, 10.0)))
    company = row(result)
    assert (company["ebit"], company["ebit_source"]) == (100.0, "pre-tax income + interest")


def test_company_without_income_statement_is_left_out():
    result = annual(
        facts((1, "OperatingIncomeLoss", FY25, 80.0), (2, "StockholdersEquity", FY25, 10.0))
    )
    assert result["cik"].to_list() == [1]


class FakeSec:
    """Latest report per filer from the Assets frames, and a record of facts downloads."""

    def __init__(self, latest: dict[int, str]):
        self.latest = latest
        self.downloaded = []

    def frame(self, tag, period):
        rows = [
            {"cik": cik, "tag": tag, "end": H1_26, "value": 1.0, "accn": accn}
            for cik, accn in self.latest.items()
        ]
        return pl.DataFrame(
            rows,
            schema={
                "cik": pl.Int64,
                "tag": pl.Utf8,
                "end": pl.Date,
                "value": pl.Float64,
                "accn": pl.Utf8,
            },
        )

    def company_facts(self, cik, tags, since):
        self.downloaded.append(cik)
        if cik == 3:  # an IFRS filer: no us-gaap facts
            return pl.DataFrame(schema=FACT_SCHEMA)
        accn = self.latest[cik]
        return pl.DataFrame(
            [fact("OperatingIncomeLoss", 1.0, H1_26, start=date(2026, 1, 1), cik=cik, accn=accn)],
            schema=FACT_SCHEMA,
        )


def test_facts_are_downloaded_again_only_after_a_new_report(tmp_path):
    cache = tmp_path / "facts.parquet"
    sec = FakeSec({1: "q2", 2: "q2"})
    assert load(sec, [1, 2, 3], AS_OF, cache)["cik"].unique().sort().to_list() == [1, 2]
    assert sec.downloaded == [1, 2, 3]

    sec.downloaded.clear()
    load(sec, [1, 2, 3], AS_OF, cache)
    assert sec.downloaded == []

    sec.latest[1] = "q3"
    load(sec, [1, 2, 3], AS_OF, cache)
    assert sec.downloaded == [1]

    sec.downloaded.clear()
    load(sec, [1, 2, 3], AS_OF + timedelta(days=45), cache)
    assert sec.downloaded == [1, 2, 3]  # copies older than a month are renewed anyway


def history(cik, margins):
    """Revenue of 100 and the given operating margins over consecutive fiscal years, the
    latest (2025) first."""
    return [
        (cik, tag, date(2025 - age, 12, 31), value)
        for age, margin in enumerate(margins)
        for tag, value in (("Revenues", 100.0), ("OperatingIncomeLoss", 100.0 * margin))
    ]


def test_normal_margin_is_the_median_of_the_last_ten_fiscal_years():
    ten_years = [0.30, 0.10, 0.12, 0.08, 0.11, 0.09, 0.10, 0.13, 0.07, 0.10]
    company = row(annual(facts(*history(1, [*ten_years, 0.50, 0.50]))))
    assert company["revenue"] == 100.0
    assert company["margin_years"] == 10
    assert company["normal_margin"] == pytest.approx(0.10)  # the two older years are left out


def test_normal_margin_needs_five_years_of_history():
    company = row(annual(facts(*history(1, [0.10, 0.12, 0.08, 0.11]))))
    assert (company["margin_years"], company["normal_margin"]) == (4, None)


def test_normal_margin_uses_pretax_income_when_operating_income_is_not_reported():
    pretax = FLOW_TAGS["pretax_income"][0]
    rows = [(1, "Revenues", date(2025 - age, 12, 31), 100.0) for age in range(5)]
    rows += [(1, pretax, date(2025 - age, 12, 31), 15.0) for age in range(5)]
    rows += [(1, "InterestExpense", date(2025 - age, 12, 31), 5.0) for age in range(5)]
    assert row(annual(facts(*rows)))["normal_margin"] == pytest.approx(0.20)


def test_revenue_is_the_larger_total_so_that_lease_income_is_not_left_out():
    contract = "RevenueFromContractWithCustomerExcludingAssessedTax"
    result = annual(
        facts(
            (1, "OperatingIncomeLoss", FY25, 30.0),
            (1, "Revenues", FY25, 400.0),  # an equipment renter: rentals + sales
            (1, contract, FY25, 100.0),  # sales only
            (2, "OperatingIncomeLoss", FY25, 30.0),
            (2, "Revenues", FY25, 0.0),
            (2, contract, FY25, 300.0),
        )
    )
    assert (row(result, 1)["revenue"], row(result, 2)["revenue"]) == (400.0, 300.0)
