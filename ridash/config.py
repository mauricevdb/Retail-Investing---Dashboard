from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
COMPANY_CACHE = DATA_DIR / "companies.parquet"
REVIEW_DIR = DATA_DIR / "reviews"
DECISIONS_FILE = DATA_DIR / "decisions.parquet"

MIN_MARKET_CAP = 2e9
MAJOR_EXCHANGES = ("NYSE", "NASDAQ", "NYSE MKT", "NYSE ARCA", "BATS", "AMEX")

# A company that reports no debt at all is treated as debt-free only if its interest
# expense stays below this share of EBIT; otherwise its debt is unknown.
DEBT_FREE_MAX_INTEREST_TO_EBIT = 0.02

# Qualitative review of the best-ranked stocks.
SHORTLIST_SIZE = 50
REVIEW_MODEL = "claude-sonnet-5-5"
REVIEW_EFFORT = "medium"
# A verdict is reused while its news and filings are unchanged, at most this many days.
REVIEW_MAX_AGE_DAYS = 7
INSIDER_CACHE = DATA_DIR / "insiders.parquet"

# Trap risk (0-100): weighted sum of the criteria Claude scores from 0 (no concern) to 5
# (critical). A 5 on any criterion excludes the stock on its own.
TRAP_WEIGHTS = {
    "earnings": 0.30,
    "one_offs": 0.15,
    "balance_sheet": 0.15,
    "accounting": 0.15,
    "governance": 0.10,
    "market": 0.15,
}
PARTIAL_RISK = 30  # from this trap risk the discount counts as partially explained
EXPLAINED_RISK = 55  # from this one as explained: the stock is excluded
KEEP_COUNT = 20  # stocks suggested for the portfolio: the lowest trap risks of the shortlist
