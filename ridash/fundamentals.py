"""Trailing-twelve-month fundamentals per company, from the facts it reports to the SEC.

Every figure of a company is aligned on the end of its latest reported period, a quarter or
a fiscal year: income and cash-flow items cover the twelve months to that date, balance-sheet
items are taken at that date. Quarterly reports (10-Q) give income and cash flows from the
start of the fiscal year, so the twelve months are rebuilt as

    last fiscal year + year to date − same period of the year before

Normal earnings put the twelve months' revenue at the median operating margin of the last ten
fiscal years, so that a margin at a cyclical peak or trough does not set the price of a stock.

Only facts filed on or before the snapshot date are used, so a snapshot never sees a filing
published after it, and a figure restated later is read as it was known at the time.
"""

from datetime import date, timedelta
from itertools import batched
from pathlib import Path

import polars as pl

from ridash.config import DEBT_FREE_MAX_INTEREST_TO_EBIT, MIN_NORMAL_YEARS, NORMAL_YEARS
from ridash.sources.sec import FACT_SCHEMA, Sec

# A company whose latest report ended longer ago than this is left out: it files late or
# no longer files (a year plus the four months foreign issuers have to file a 20-F).
MAX_PERIOD_AGE = timedelta(days=500)
# Facts kept per company: the NORMAL_YEARS fiscal years before a period ending up to
# MAX_PERIOD_AGE ago.
FACT_HISTORY = MAX_PERIOD_AGE + timedelta(days=(NORMAL_YEARS + 1) * 365)
# Without a new report, a company's facts are downloaded again after this delay anyway.
FACT_MAX_AGE = timedelta(days=30)

# Output column -> us-gaap tags, most specific first. The facts cache only holds these tags
# over FACT_HISTORY: after changing either, delete data/facts.parquet so that every company is
# downloaded again.
# Revenue is the larger of the first two (see `_revenue`), else the first of the others.
REVENUE_TAGS = [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
]
FLOW_TAGS = {
    "revenue": REVENUE_TAGS,
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
    "capex": [
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
        "PaymentsToAcquireOilAndGasPropertyAndEquipment",
        "PaymentsToAcquireOilAndGasProperty",
    ],
    "stock_compensation": ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
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

_EBIT_TAGS = FLOW_TAGS["operating_income"] + FLOW_TAGS["pretax_income"]
_EBIT_PARTS = ("operating_income", "pretax_income", "interest_expense")
FLOW_TAG_LIST = sorted({t for tags in FLOW_TAGS.values() for t in tags})
BALANCE_SHEET_TAG_LIST = sorted(
    {t for tags in BALANCE_TAGS.values() for t in tags}
    | {t for tag, complements in DEBT_DEFINITIONS for t in (tag, *complements)}
)


# ---------------------------------------------------------------- download and cache


def latest_reports(sec: Sec, as_of: date) -> pl.DataFrame:
    """Accession number of the latest report of every filer: the one that last reported its
    total assets, over the current and the last four quarter ends (5 requests for the whole
    market)."""
    year, quarter = as_of.year, (as_of.month - 1) // 3 + 1
    frames = []
    for _ in range(5):
        frames.append(sec.frame("Assets", f"CY{year}Q{quarter}I"))
        year, quarter = (year, quarter - 1) if quarter > 1 else (year - 1, 4)
    recent = pl.concat(frames).filter(pl.col("end") <= as_of).sort("end")
    return recent.group_by("cik").last().select("cik", "accn")


def load(sec: Sec, ciks: list[int], as_of: date, cache: Path) -> pl.DataFrame:
    """Facts of the given companies, downloaded again only for those that have published a
    report since they were cached, or whose copy is older than FACT_MAX_AGE."""
    schema = {**FACT_SCHEMA, "fetched": pl.Date}
    cached = pl.read_parquet(cache) if cache.exists() else pl.DataFrame(schema=schema)
    fetched = cached.group_by("cik").agg(pl.col("fetched").max(), accns=pl.col("accn").unique())
    current = fetched.join(latest_reports(sec, as_of), on="cik", how="left").filter(
        (pl.col("fetched") >= as_of - FACT_MAX_AGE)
        & (pl.col("accn").is_null() | pl.col("accns").list.contains(pl.col("accn")))
    )
    stale = sorted(set(ciks) - set(current["cik"].to_list()))
    cache.parent.mkdir(parents=True, exist_ok=True)
    for chunk in batched(stale, 100):
        downloaded = [
            sec.company_facts(
                cik, set(FLOW_TAG_LIST + BALANCE_SHEET_TAG_LIST), as_of - FACT_HISTORY
            )
            # A company without any of these facts (an IFRS filer) keeps an empty row, so that
            # it is not downloaded again every day.
            .vstack(pl.DataFrame([{"cik": cik}], schema=FACT_SCHEMA))
            for cik in chunk
        ]
        cached = pl.concat(
            [
                cached.filter(~pl.col("cik").is_in(chunk)),
                pl.concat(downloaded).with_columns(fetched=pl.lit(as_of)),
            ]
        )
        cached.write_parquet(cache)
    return cached.filter(pl.col("cik").is_in(ciks) & pl.col("tag").is_not_null()).drop("fetched")


# ---------------------------------------------------------------- trailing twelve months


def trailing(facts: pl.DataFrame, as_of: date) -> pl.DataFrame:
    """One row per company reporting an operating or pre-tax income, over the twelve months
    to the end of its latest reported period, as known on `as_of`."""
    known = (
        facts.filter(pl.col("filed") <= as_of)
        .sort("filed")
        .group_by("cik", "tag", "start", "end")
        .last()
    )
    flows = known.filter(pl.col("start").is_not_null()).with_columns(
        days=(pl.col("end") - pl.col("start")).dt.total_days()
    )
    periods = (
        flows.filter(pl.col("tag").is_in(_EBIT_TAGS))
        .sort("end", "filed")
        .group_by("cik")
        .last()
        .filter(pl.col("end") >= as_of - MAX_PERIOD_AGE)
        .select("cik", period_end="end", form="form", accn="accn")
    )
    balances = known.filter(pl.col("start").is_null()).join(
        periods, left_on=["cik", "end"], right_on=["cik", "period_end"]
    )
    long = pl.concat([twelve_months(flows, periods), balances.select("cik", "tag", "value")])
    wide = _with_every_tag(
        long.pivot(on="tag", index="cik", values="value", aggregate_function="first")
    )

    columns = {name: pl.coalesce(tags) for name, tags in {**FLOW_TAGS, **BALANCE_TAGS}.items()}
    columns["revenue"] = _revenue()
    return (
        periods.join(wide, on="cik")
        .join(normal_margin(flows, periods), on="cik", how="left")
        .with_columns(**columns)
        .with_columns(ebit=_ebit(), ebit_source=_ebit_source())
        .with_columns(debt=_debt(), debt_source=_debt_source())
        .select(
            "cik",
            "period_end",
            "form",
            "accn",
            "ebit",
            "ebit_source",
            *(name for name in columns if name not in ("operating_income", "pretax_income")),
            "debt",
            "debt_source",
            "normal_margin",
            "margin_years",
        )
    )


def normal_margin(flows: pl.DataFrame, periods: pl.DataFrame) -> pl.DataFrame:
    """Median operating margin (EBIT / revenue) over the last NORMAL_YEARS fiscal years ending
    by each company's period end, given only from MIN_NORMAL_YEARS years: the margin of an
    ordinary year rather than of the last one."""
    years = (
        flows.filter(pl.col("days").is_between(350, 380))
        .join(periods.select("cik", "period_end"), on="cik")
        .filter(pl.col("end") <= pl.col("period_end"))
        .pivot(on="tag", index=["cik", "end"], values="value", aggregate_function="first")
        .pipe(_with_every_tag)
        .with_columns(
            revenue=_revenue(),
            **{name: pl.coalesce(FLOW_TAGS[name]) for name in _EBIT_PARTS},
        )
        .with_columns(margin=pl.when(pl.col("revenue") > 0).then(_ebit() / pl.col("revenue")))
        .filter(pl.col("margin").is_not_null())
        .sort("end", descending=True)
        .group_by("cik")
        .head(NORMAL_YEARS)
    )
    return years.group_by("cik").agg(
        normal_margin=pl.when(pl.len() >= MIN_NORMAL_YEARS).then(pl.col("margin").median()),
        margin_years=pl.len().cast(pl.Int32),
    )


def _with_every_tag(wide: pl.DataFrame) -> pl.DataFrame:
    """Add the tags nobody reported, as empty columns, so that every expression can name them."""
    absent = [tag for tag in FLOW_TAG_LIST + BALANCE_SHEET_TAG_LIST if tag not in wide.columns]
    return wide.with_columns(pl.lit(None, pl.Float64).alias(tag) for tag in absent)


def twelve_months(flows: pl.DataFrame, periods: pl.DataFrame) -> pl.DataFrame:
    """Income and cash-flow items over the twelve months to each company's period end:
    the fiscal year itself when the period closes one, else rebuilt from the year to date."""
    annual = pl.col("days").is_between(350, 380)
    at_end = flows.join(
        periods.select("cik", "period_end"), left_on=["cik", "end"], right_on=["cik", "period_end"]
    )
    full_year = at_end.filter(annual).select("cik", "tag", "value")
    year_to_date = (
        at_end.filter(~annual & (pl.col("days") < 350))
        .join(full_year, on=["cik", "tag"], how="anti")
        .sort("days")
        .group_by("cik", "tag")
        .last()  # the longest period ending at the date: from the start of the fiscal year
        .select("cik", "tag", "start", "days", ytd="value")
    )
    fiscal_years = flows.filter(annual).select(
        "cik", "tag", fy_start="start", fy_end="end", fy="value"
    )
    year_before = flows.filter(~annual).select(
        "cik", "tag", fy_start="start", prior_days="days", prior="value"
    )
    rebuilt = (
        year_to_date.with_columns(fy_end=pl.col("start") - timedelta(days=1))
        .join(fiscal_years, on=["cik", "tag", "fy_end"])
        .join(year_before, on=["cik", "tag", "fy_start"])
        .filter((pl.col("prior_days") - pl.col("days")).abs() <= 10)
        .unique(["cik", "tag"])
        .select("cik", "tag", value=pl.col("fy") + pl.col("ytd") - pl.col("prior"))
    )
    return pl.concat([full_year, rebuilt])


def _revenue() -> pl.Expr:
    # Total revenue includes the lease and other income that the contract-revenue tag leaves
    # out (equipment renters, commodity traders); a few filers report a partial or zero total,
    # so the larger of the two is taken.
    total = pl.max_horizontal(REVENUE_TAGS[:2])
    return pl.coalesce(total, *REVENUE_TAGS[2:])


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
    # Only a reported interest expense is evidence: without one, the debt stays unknown.
    interest = pl.col("interest_expense").abs()
    return interest < DEBT_FREE_MAX_INTEREST_TO_EBIT * pl.col("ebit").abs()


def _debt() -> pl.Expr:
    return pl.coalesce(_reported_debt(), pl.when(_no_material_interest()).then(pl.lit(0.0)))


def _debt_source() -> pl.Expr:
    reported_tag = pl.coalesce(
        pl.when(pl.col(tag) > 0).then(pl.lit(tag)) for tag, _ in DEBT_DEFINITIONS
    )
    return pl.coalesce(
        reported_tag, pl.when(_no_material_interest()).then(pl.lit(NO_DEBT_REPORTED))
    )
