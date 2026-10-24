"""Daily refresh: market data + SEC fundamentals (twelve months and ten fiscal years) ->
scored snapshot.

uv run --env-file .env python -m ridash.refresh
"""

import time

import polars as pl

from ridash import fundamentals, value
from ridash.config import COMPANY_CACHE, FACTS_CACHE, MIN_MARKET_CAP, SNAPSHOT_DIR
from ridash.sources import eodhd
from ridash.sources.sec import Sec


def build_snapshot(sec: Sec, quotes: pl.DataFrame) -> pl.DataFrame:
    as_of = quotes["date"].max()
    universe = value.candidates(quotes, sec.tickers(), MIN_MARKET_CAP)
    universe = value.classify(universe, sec.companies(universe["cik"].to_list(), COMPANY_CACHE))
    facts = fundamentals.load(sec, universe["cik"].to_list(), as_of, FACTS_CACHE)
    trailing = fundamentals.trailing(facts, as_of)
    screen = value.score(value.metrics(universe.join(trailing, on="cik", how="left")))
    return screen.select(
        pl.lit(as_of).alias("date"),
        "rank",
        "ticker",
        "name",
        "cik",
        "sector",
        "industry",
        "country",
        "exchange",
        "close",
        "market_cap",
        "period_end",
        "form",
        "accn",
        "ebit",
        "ebit_source",
        "revenue",
        "normal_margin",
        "margin_years",
        "normal_ebit",
        "operating_cash_flow",
        "capex",
        "stock_compensation",
        "depreciation",
        "interest_expense",
        "cash",
        "debt",
        "debt_source",
        "equity",
        "minority_interest",
        "ev",
        *value.SCORED_METRICS,
        "roce",
        "net_debt_ebitda",
        *(f"pct_{name}" for name in value.SCORED_METRICS),
        "value_score",
        "quality_pass",
        "quality_unchecked",
    )


def main() -> None:
    started = time.monotonic()
    quotes = eodhd.quotes()
    as_of = quotes["date"].max()
    path = SNAPSHOT_DIR / f"{as_of.isoformat()}.parquet"
    # A snapshot records what was known on that session; a later run (e.g. at the
    # weekend) must not rewrite it with filings published since.
    if path.exists():
        print(f"{as_of}: snapshot already written, nothing to do")
        return

    snapshot = build_snapshot(Sec(), quotes)
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    snapshot.write_parquet(path)

    scored = snapshot.filter(pl.col("value_score").is_not_null())
    ranked = snapshot.filter(pl.col("rank").is_not_null())
    print(
        f"{as_of}: {scored.height}/{snapshot.height} companies valued, {ranked.height} pass the "
        f"quality gate -> {path.name}"
    )
    print(f"done in {time.monotonic() - started:.0f}s")
    with pl.Config(tbl_rows=15, fmt_str_lengths=30, tbl_formatting="ASCII_MARKDOWN"):
        print(
            ranked.select("rank", "ticker", "sector", *value.SCORED_METRICS, "value_score").head(15)
        )


if __name__ == "__main__":
    main()
