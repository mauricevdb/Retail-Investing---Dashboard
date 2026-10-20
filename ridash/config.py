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
# Claude Sonnet 5.5 list prices, USD per million tokens (input, cache write, cache read, output).
REVIEW_PRICES = (2.00, 2.50, 0.20, 10.00)
