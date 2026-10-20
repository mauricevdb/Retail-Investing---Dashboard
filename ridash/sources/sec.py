"""SEC EDGAR: ticker/CIK map, XBRL frames and company SIC codes."""

import os
import time
from itertools import batched
from pathlib import Path

import polars as pl

from ridash.sources.http import get_json

FRAME_SCHEMA = {
    "cik": pl.Int64,
    "tag": pl.Utf8,
    "end": pl.Date,
    "value": pl.Float64,
    "accn": pl.Utf8,
}
COMPANY_SCHEMA = {"cik": pl.Int64, "sic": pl.Int64, "industry": pl.Utf8}

_MIN_INTERVAL = 0.11  # SEC fair-access policy: at most 10 requests per second


class Sec:
    def __init__(self, user_agent: str | None = None) -> None:
        self._headers = {"User-Agent": user_agent or os.environ["SEC_USER_AGENT"]}
        self._last_call = 0.0

    def _get(self, url: str):
        wait = self._last_call + _MIN_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()
        return get_json(url, self._headers)

    def tickers(self) -> pl.DataFrame:
        raw = self._get("https://www.sec.gov/files/company_tickers.json")
        return pl.DataFrame(list(raw.values())).select(
            pl.col("cik_str").cast(pl.Int64).alias("cik"),
            "ticker",
            pl.col("title").alias("name"),
        )

    def frame(self, tag: str, period: str) -> pl.DataFrame:
        """One us-gaap concept, in USD, for every filer over a calendar period."""
        raw = self._get(f"https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/{period}.json")
        return parse_frame(raw, tag)

    def companies(self, ciks: list[int], cache: Path) -> pl.DataFrame:
        """SIC classification per company, fetched once then served from a local cache."""
        known = pl.read_parquet(cache) if cache.exists() else pl.DataFrame(schema=COMPANY_SCHEMA)
        missing = sorted(set(ciks) - set(known["cik"].to_list()))
        cache.parent.mkdir(parents=True, exist_ok=True)
        for chunk in batched(missing, 200):
            fetched = pl.DataFrame([self._company(cik) for cik in chunk], schema=COMPANY_SCHEMA)
            known = pl.concat([known, fetched])
            known.write_parquet(cache)
        return known

    def filings(self, cik: int) -> pl.DataFrame:
        """Most recent filings of a company: form, date, 8-K items, document URL."""
        raw = self._get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json") or {}
        return parse_filings(raw.get("filings", {}).get("recent", {}), cik)

    def _company(self, cik: int) -> dict:
        raw = self._get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json") or {}
        sic = raw.get("sic")
        return {"cik": cik, "sic": int(sic) if sic else None, "industry": raw.get("sicDescription")}


def parse_filings(recent: dict, cik: int) -> pl.DataFrame:
    schema = {"form": pl.Utf8, "filed": pl.Utf8, "items": pl.Utf8, "accn": pl.Utf8, "url": pl.Utf8}
    if not recent.get("form"):
        return pl.DataFrame(schema=schema).with_columns(pl.col("filed").str.to_date())
    rows = [
        {
            "form": form,
            "filed": filed,
            "items": items,
            "accn": accn,
            "url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{accn.replace('-', '')}/{doc}",
        }
        for form, filed, items, accn, doc in zip(
            recent["form"],
            recent["filingDate"],
            recent["items"],
            recent["accessionNumber"],
            recent["primaryDocument"],
            strict=True,
        )
    ]
    return pl.DataFrame(rows, schema=schema).with_columns(pl.col("filed").str.to_date())


def parse_frame(raw: dict | None, tag: str) -> pl.DataFrame:
    if not raw or not raw.get("data"):
        return pl.DataFrame(schema=FRAME_SCHEMA)
    return pl.DataFrame(raw["data"], infer_schema_length=None).select(
        pl.col("cik").cast(pl.Int64),
        pl.lit(tag).alias("tag"),
        pl.col("end").str.to_date(),
        pl.col("val").cast(pl.Float64).alias("value"),
        pl.col("accn"),
    )
