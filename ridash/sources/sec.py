"""SEC EDGAR: ticker/CIK map, XBRL frames, company SIC codes, filings, earnings releases and
insider transactions."""

import json
import os
import re
import time
from datetime import date
from html.parser import HTMLParser
from itertools import batched
from pathlib import Path
from xml.etree import ElementTree

import polars as pl

from ridash.sources.http import get

FRAME_SCHEMA = {
    "cik": pl.Int64,
    "tag": pl.Utf8,
    "end": pl.Date,
    "value": pl.Float64,
    "accn": pl.Utf8,
}
FACT_SCHEMA = {
    "cik": pl.Int64,
    "tag": pl.Utf8,
    "start": pl.Date,  # empty for balance-sheet items, which are measured at a date
    "end": pl.Date,
    "value": pl.Float64,
    "accn": pl.Utf8,
    "form": pl.Utf8,
    "filed": pl.Date,
}
COMPANY_SCHEMA = {"cik": pl.Int64, "sic": pl.Int64, "industry": pl.Utf8, "country": pl.Utf8}

_MIN_INTERVAL = 0.11  # SEC fair-access policy: at most 10 requests per second


class Sec:
    def __init__(self, user_agent: str | None = None) -> None:
        self._headers = {
            "User-Agent": user_agent or os.environ["SEC_USER_AGENT"],
            "Accept-Encoding": "gzip",
        }
        self._last_call = 0.0

    def _fetch(self, url: str) -> bytes | None:
        wait = self._last_call + _MIN_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()
        return get(url, self._headers)

    def _get(self, url: str):
        body = self._fetch(url)
        return None if body is None else json.loads(body)

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

    def company_facts(self, cik: int, tags: set[str], since: date) -> pl.DataFrame:
        """Every value of the given us-gaap concepts in USD reported by a company for periods
        ending on or after `since`: annual, year-to-date and quarterly amounts and balance
        sheets, each with the filing it comes from."""
        raw = self._get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json")
        return parse_company_facts(raw, cik, tags, since)

    def companies(self, ciks: list[int], cache: Path) -> pl.DataFrame:
        """SIC classification and country per company, fetched once then served from a local
        cache."""
        known = pl.read_parquet(cache) if cache.exists() else pl.DataFrame(schema=COMPANY_SCHEMA)
        if "country" not in known.columns:  # cache written before countries were recorded
            known = pl.DataFrame(schema=COMPANY_SCHEMA)
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

    def earnings_release(self, cik: int, accn: str, primary_url: str) -> tuple[str, str] | None:
        """Text and URL of the press release attached to an 8-K (exhibit 99.1), or of the 8-K
        itself when the results are written into it."""
        folder = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accn.replace('-', '')}"
        index = self._get(f"{folder}/index.json") or {}
        exhibit = pick_exhibit(
            [item["name"] for item in index.get("directory", {}).get("item", [])]
        )
        url = f"{folder}/{exhibit}" if exhibit else primary_url
        body = self._fetch(url)
        if body is None:
            return None
        return html_to_text(body.decode("utf-8", errors="replace")), url

    def insider_transactions(self, form4_url: str) -> list[dict]:
        """Open-market purchases and sales reported on a Form 4 (URL of its rendered page)."""
        body = self._fetch(re.sub(r"/xslF345X\d+/", "/", form4_url))
        return parse_form4(body) if body else []

    def _company(self, cik: int) -> dict:
        raw = self._get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json") or {}
        sic = raw.get("sic")
        return {
            "cik": cik,
            "sic": int(sic) if sic else None,
            "industry": raw.get("sicDescription"),
            "country": business_country(raw),
        }


def business_country(submissions: dict) -> str | None:
    """Country of the company's business address, the place it is run from (the state of
    incorporation is often a tax haven)."""
    address = (submissions.get("addresses") or {}).get("business") or {}
    if address.get("isForeignLocation"):
        country = address.get("country")
        # Canadian addresses read "British Columbia, Canada": keep the country only.
        return country.split(", ")[-1] if country else None
    return "United States" if address.get("stateOrCountry") else None


def parse_company_facts(raw: dict | None, cik: int, tags: set[str], since: date) -> pl.DataFrame:
    concepts = ((raw or {}).get("facts") or {}).get("us-gaap") or {}
    rows = [
        {
            "cik": cik,
            "tag": tag,
            "start": fact.get("start"),
            "end": fact["end"],
            "value": fact["val"],
            "accn": fact["accn"],
            "form": fact["form"],
            "filed": fact["filed"],
        }
        for tag in tags & concepts.keys()
        for fact in concepts[tag]["units"].get("USD", [])
        if fact["end"] >= since.isoformat()
    ]
    schema = {**FACT_SCHEMA, "start": pl.Utf8, "end": pl.Utf8, "filed": pl.Utf8}
    return pl.DataFrame(rows, schema=schema).with_columns(
        pl.col("start", "end", "filed").str.to_date()
    )


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


def pick_exhibit(names: list[str]) -> str | None:
    """Exhibit 99.1 (the press release) among the documents of a filing, else another 99.x."""
    exhibits = [
        name
        for name in names
        if re.search(r"ex(hibit)?[-_]?99", name, re.IGNORECASE)
        and name.lower().endswith((".htm", ".html", ".txt"))
    ]
    first = [name for name in exhibits if re.search(r"99[-_.d]?0?1(?!\d)", name, re.IGNORECASE)]
    return (first or exhibits or [None])[0]


class _TextExtractor(HTMLParser):
    _BREAKS = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "table"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._hidden += 1
        elif tag in self._BREAKS:
            self.parts.append("\n")
        elif tag in ("td", "th"):
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._hidden -= 1

    def handle_data(self, data):
        if not self._hidden:
            self.parts.append(data)


_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍﻿"))


def html_to_text(markup: str) -> str:
    extractor = _TextExtractor()
    extractor.feed(markup)
    text = "".join(extractor.parts).translate(_ZERO_WIDTH)
    lines = (" ".join(line.split()) for line in text.splitlines())
    return "\n".join(line for line in lines if line)


def parse_form4(body: bytes) -> list[dict]:
    root = ElementTree.fromstring(body)
    relation = root.find("reportingOwner/reportingOwnerRelationship")

    def flag(name: str) -> bool:
        return (relation.findtext(name) if relation is not None else None) in ("1", "true")

    title = (relation.findtext("officerTitle") if relation is not None else None) or (
        "Director" if flag("isDirector") else "10% owner" if flag("isTenPercentOwner") else "Other"
    )
    insider = root.findtext("reportingOwner/reportingOwnerId/rptOwnerName")
    planned = root.findtext("aff10b5One") in ("1", "true")
    transactions = []
    for transaction in root.iter("nonDerivativeTransaction"):
        code = transaction.findtext("transactionCoding/transactionCode")
        shares = _number(transaction.findtext("transactionAmounts/transactionShares/value"))
        price = _number(transaction.findtext("transactionAmounts/transactionPricePerShare/value"))
        if code in ("P", "S") and shares:
            transactions.append(
                {
                    "date": transaction.findtext("transactionDate/value"),
                    "insider": insider,
                    "title": title,
                    "code": code,
                    "shares": shares,
                    "value": shares * price if price is not None else None,
                    "planned": planned,
                }
            )
    return transactions


def _number(text: str | None) -> float | None:
    try:
        return float(text) if text else None
    except ValueError:
        return None


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
