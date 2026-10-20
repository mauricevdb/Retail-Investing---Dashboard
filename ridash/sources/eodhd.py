"""EODHD end-of-day market data (EOD plan): bulk last session and per-ticker history."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import polars as pl

from ridash.sources.http import get_json

_BASE = "https://eodhd.com/api"
HISTORY_SCHEMA = {"ticker": pl.Utf8, "date": pl.Date, "adj_close": pl.Float64}


def quotes(api_key: str | None = None) -> pl.DataFrame:
    """Last session of every US ticker: price, market cap, security type, exchange, currency."""
    key = api_key or os.environ["EODHD_API_KEY"]
    bulk = get_json(f"{_BASE}/eod-bulk-last-day/US?filter=extended&fmt=json&api_token={key}")
    listings = get_json(f"{_BASE}/exchange-symbol-list/US?fmt=json&api_token={key}")
    return parse_quotes(bulk, listings)


def parse_quotes(bulk: list[dict], listings: list[dict]) -> pl.DataFrame:
    exchanges = (
        pl.DataFrame(listings, infer_schema_length=None)
        .select(
            pl.col("Code").alias("ticker"),
            pl.col("Exchange").alias("exchange"),
            pl.col("Currency").alias("currency"),
        )
        .unique("ticker", keep="first")
    )
    return (
        pl.DataFrame(bulk, infer_schema_length=None)
        .select(
            pl.col("code").alias("ticker"),
            pl.col("date").str.to_date(),
            pl.col("type"),
            pl.col("close").cast(pl.Float64),
            pl.col("MarketCapitalization").cast(pl.Float64).alias("market_cap"),
            pl.col("avgvol_50d").cast(pl.Float64).alias("avg_volume"),
        )
        .join(exchanges, on="ticker", how="left")
    )


def price_history(
    tickers: list[str], start: date, end: date, api_key: str | None = None
) -> pl.DataFrame:
    """Daily closes adjusted for splits and dividends, one request per ticker."""
    key = api_key or os.environ["EODHD_API_KEY"]

    def fetch(ticker: str) -> pl.DataFrame:
        url = f"{_BASE}/eod/{ticker}.US?from={start}&to={end}&fmt=json&api_token={key}"
        return parse_history(get_json(url), ticker)

    with ThreadPoolExecutor(max_workers=8) as pool:
        return pl.concat(pool.map(fetch, tickers))


def parse_history(raw: list[dict] | None, ticker: str) -> pl.DataFrame:
    if not raw:
        return pl.DataFrame(schema=HISTORY_SCHEMA)
    return pl.DataFrame(raw, infer_schema_length=None).select(
        pl.lit(ticker).alias("ticker"),
        pl.col("date").str.to_date(),
        pl.col("adjusted_close").cast(pl.Float64).alias("adj_close"),
    )
