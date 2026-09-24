"""Latest annual fundamentals per company, assembled from SEC XBRL frames.

A frame holds one concept for every filer over one calendar period, so the whole
market costs a couple of hundred requests instead of one download per company.
Every figure of a company is aligned on its latest fiscal year end: income and
cash-flow items cover that fiscal year, balance-sheet items are taken at that date.
"""

import polars as pl

from ridash.config import DEBT_FREE_MAX_INTEREST_TO_EBIT
from ridash.sources.sec import Sec

# Output column -> us-gaap tags, most specific first.
ANNUAL_TAGS = {
    "operating_income": ["OperatingIncomeLoss"],
    "pretax_income": [
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ],
    "interest_expense": [
        "InterestExpense",
        "InterestExpenseNonoperating",
        "InterestExpenseDebt",
        "InterestPaidNet",
        "InterestPaid",
    ],
    "operating_cash_flow": ["NetCashProvidedByUsedInOperatingActivities"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
    "depreciation": [
        "DepreciationDepletionAndAmortization",
        "DepreciationAndAmortization",
        "DepreciationAmortizationAndAccretionNet",
        "Depreciation",
    ],
}
BALANCE_TAGS = {
    "cash": [
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
    "equity": [
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    "minority_interest": ["MinorityInterest"],
}

# Debt definitions, first one reported with a positive amount wins (a zero current-portion
# tag says nothing about the rest of the debt). The complements (current portion,
# short-term borrowings, commercial paper) are added when reported.
_SHORT_TERM = ["ShortTermBorrowings", "CommercialPaper"]
DEBT_DEFINITIONS = [
    ("DebtLongtermAndShorttermCombinedAmount", []),
    ("LongTermDebt", _SHORT_TERM),
    ("LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities", _SHORT_TERM),
    ("LongTermDebtNoncurrent", ["LongTermDebtCurrent", *_SHORT_TERM]),
    (
        "LongTermDebtAndCapitalLeaseObligations",
        ["LongTermDebtAndCapitalLeaseObligationsCurrent", *_SHORT_TERM],
    ),
    ("ConvertibleDebtNoncurrent", ["ConvertibleDebtCurrent", *_SHORT_TERM]),
    ("ConvertibleNotesPayable", _SHORT_TERM),
    ("LongTermNotesPayable", _SHORT_TERM),
    ("SeniorNotes", _SHORT_TERM),
    ("NotesPayable", _SHORT_TERM),
    ("ConvertibleNotesPayableCurrent", _SHORT_TERM),
    ("ConvertibleDebtCurrent", _SHORT_TERM),
    ("DebtInstrumentCarryingAmount", _SHORT_TERM),
    ("ShortTermBorrowings", ["CommercialPaper"]),
    ("CommercialPaper", []),
]
NO_DEBT_REPORTED = "none reported, no material interest"

_EBIT_TAGS = ANNUAL_TAGS["operating_income"] + ANNUAL_TAGS["pretax_income"]
ANNUAL_TAG_LIST = sorted({t for tags in ANNUAL_TAGS.values() for t in tags})
BALANCE_SHEET_TAG_LIST = sorted(
    {t for tags in BALANCE_TAGS.values() for t in tags}
    | {t for tag, complements in DEBT_DEFINITIONS for t in (tag, *complements)}
)


def fetch(sec: Sec, year: int) -> pl.DataFrame:
    """All frames needed for fiscal years ending in `year - 1` or `year`."""
    years = (year - 1, year)
    annual = [f"CY{y}" for y in years]
    instants = [f"CY{y}Q{q}I" for y in years for q in range(1, 5)]
    frames = [sec.frame(tag, period) for tag in ANNUAL_TAG_LIST for period in annual]
    frames += [sec.frame(tag, period) for tag in BALANCE_SHEET_TAG_LIST for period in instants]
    return pl.concat(frames)


def latest_annual(facts: pl.DataFrame) -> pl.DataFrame:
    """One row per company reporting an operating or pre-tax income, at its latest fiscal
    year end."""
    fiscal_years = (
        facts.filter(pl.col("tag").is_in(_EBIT_TAGS))
        .sort("end")
        .group_by("cik")
        .last()
        .select("cik", pl.col("end").alias("fiscal_end"), "accn")
    )
    wide = (
        facts.join(fiscal_years.select("cik", "fiscal_end"), on="cik")
        .filter(pl.col("end") == pl.col("fiscal_end"))
        .pivot(on="tag", index="cik", values="value", aggregate_function="first")
    )
    absent = [tag for tag in ANNUAL_TAG_LIST + BALANCE_SHEET_TAG_LIST if tag not in wide.columns]
    wide = wide.with_columns(pl.lit(None, pl.Float64).alias(tag) for tag in absent)

    columns = {name: pl.coalesce(tags) for name, tags in {**ANNUAL_TAGS, **BALANCE_TAGS}.items()}
    return (
        fiscal_years.join(wide, on="cik")
        .with_columns(**columns)
        .with_columns(ebit=_ebit(), ebit_source=_ebit_source())
        .with_columns(debt=_debt(), debt_source=_debt_source())
        .select(
            "cik",
            "fiscal_end",
            "accn",
            "ebit",
            "ebit_source",
            *(name for name in columns if name not in ("operating_income", "pretax_income")),
            "debt",
            "debt_source",
        )
    )


def _ebit() -> pl.Expr:
    # Companies that present no operating subtotal (oil majors, most pharma) fall back to
    # pre-tax income plus interest expense.
    derived = pl.col("pretax_income") + pl.col("interest_expense").fill_null(0)
    return pl.coalesce(pl.col("operating_income"), derived)


def _ebit_source() -> pl.Expr:
    return (
        pl.when(pl.col("operating_income").is_not_null())
        .then(pl.lit("operating income"))
        .when(pl.col("pretax_income").is_not_null())
        .then(pl.lit("pre-tax income + interest"))
    )


def _reported_debt() -> pl.Expr:
    return pl.coalesce(
        pl.when(pl.col(tag) > 0).then(pl.sum_horizontal(tag, *complements))
        for tag, complements in DEBT_DEFINITIONS
    )


def _no_material_interest() -> pl.Expr:
    interest = pl.col("interest_expense").abs()
    return interest.is_null() | (interest < DEBT_FREE_MAX_INTEREST_TO_EBIT * pl.col("ebit").abs())


def _debt() -> pl.Expr:
    return pl.coalesce(_reported_debt(), pl.when(_no_material_interest()).then(pl.lit(0.0)))


def _debt_source() -> pl.Expr:
    reported_tag = pl.coalesce(
        pl.when(pl.col(tag) > 0).then(pl.lit(tag)) for tag, _ in DEBT_DEFINITIONS
    )
    return pl.coalesce(
        reported_tag, pl.when(_no_material_interest()).then(pl.lit(NO_DEBT_REPORTED))
    )
