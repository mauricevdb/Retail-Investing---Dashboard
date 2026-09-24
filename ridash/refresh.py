"""Daily refresh: market data + SEC fundamentals -> scored snapshot.

uv run --env-file .env python -m ridash.refresh
"""

import time

import polars as pl

from ridash import fundamentals, value
from ridash.config import COMPANY_CACHE, MIN_MARKET_CAP, SNAPSHOT_DIR
from ridash.sources import eodhd
from ridash.sources.sec import Sec


def build_snapshot(sec: Sec) -> pl.DataFrame:
    quotes = eodhd.quotes()
    as_of = quotes["date"].max()
    universe = value.candidates(quotes, sec.tickers(), MIN_MARKET_CAP)
    universe = value.classify(universe, sec.companies(universe["cik"].to_list(), COMPANY_CACHE))
    annual = fundamentals.latest_annual(fundamentals.fetch(sec, as_of.year))
    screen = value.score(value.metrics(universe.join(annual, on="cik", how="left")))
    return screen.select(
        pl.lit(as_of).alias("date"),
        "rank",
        "ticker",
        "name",
        "cik",
        "sector",
        "industry",
        "exchange",
        "close",
        "market_cap",
        "fiscal_end",
        "accn",
        "ebit",
        "ebit_source",
        "operating_cash_flow",
        "capex",
        "depreciation",
        "interest_expense",
        "cash",
        "debt",
        "debt_source",
        "equity",
        "minority_interest",
        "ev",
        *value.SCORED_METRICS,
        *(f"pct_{name}" for name in value.SCORED_METRICS),
        "value_score",
    )


def main() -> None:
    started = time.monotonic()
    snapshot = build_snapshot(Sec())
    as_of = snapshot["date"][0]
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    path = SNAPSHOT_DIR / f"{as_of.isoformat()}.parquet"
    snapshot.write_parquet(path)

    scored = snapshot.filter(pl.col("value_score").is_not_null())
    print(f"{as_of}: {scored.height}/{snapshot.height} companies scored -> {path.name}")
    print(f"done in {time.monotonic() - started:.0f}s")
    with pl.Config(tbl_rows=15, fmt_str_lengths=30, tbl_formatting="ASCII_MARKDOWN"):
        print(
            scored.select("rank", "ticker", "name", "ev_ebit", "fcf_yield", "value_score").head(15)
        )


if __name__ == "__main__":
    main()
