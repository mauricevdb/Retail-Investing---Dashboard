"""FINRA short interest: positions reported twice a month for every US equity."""

import io
from datetime import date, timedelta

import polars as pl

from ridash.sources.http import get

_URL = "https://cdn.finra.org/equity/otcmarket/biweekly/shrt{day:%Y%m%d}.csv"
_HEADERS = {"User-Agent": "ridash/0.1"}  # requests without one are refused (403)


def short_interest(as_of: date) -> pl.DataFrame:
    """The latest file settled on or before `as_of`. Files appear about a week after their
    settlement date (mid-month and month-end); later ones answer 403 until then."""
    for back in range(45):
        day = as_of - timedelta(days=back)
        if day.weekday() < 5 and (body := get(_URL.format(day=day), _HEADERS, missing=(403, 404))):
            return parse_short_interest(body)
    raise RuntimeError(f"no FINRA short interest file in the 45 days before {as_of}")


def parse_short_interest(body: bytes) -> pl.DataFrame:
    return pl.read_csv(io.BytesIO(body), separator="|", infer_schema_length=0).select(
        pl.col("symbolCode").alias("ticker"),
        pl.col("settlementDate").str.to_date().alias("short_date"),
        pl.col("currentShortPositionQuantity").cast(pl.Float64).alias("short_shares"),
        pl.col("previousShortPositionQuantity").cast(pl.Float64).alias("short_shares_prev"),
        pl.col("daysToCoverQuantity").cast(pl.Float64).alias("days_to_cover"),
    )
