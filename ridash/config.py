from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
COMPANY_CACHE = DATA_DIR / "companies.parquet"

MIN_MARKET_CAP = 2e9
MAJOR_EXCHANGES = ("NYSE", "NASDAQ", "NYSE MKT", "NYSE ARCA", "BATS", "AMEX")

# A company that reports no debt at all is treated as debt-free only if its interest
# expense stays below this share of EBIT; otherwise its debt is unknown.
DEBT_FREE_MAX_INTEREST_TO_EBIT = 0.02
