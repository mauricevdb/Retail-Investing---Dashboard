"""EODHD end-of-day market data, using the bulk endpoints of the EOD plan."""

import os

import polars as pl

from ridash.sources.http import get_json

_BASE = "https://eodhd.com/api"


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
