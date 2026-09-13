from datetime import date

import polars as pl

from dashboard.ingestion.edgar_client import EdgarClient

_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"


def fetch_company_tickers(client: EdgarClient, as_of: date) -> pl.DataFrame:
    raw = client.get_json(_COMPANY_TICKERS_URL)
    return parse_company_tickers(raw, as_of)


def parse_company_tickers(raw: dict, as_of: date) -> pl.DataFrame:
    rows = [
        {
            "cik": str(entry["cik_str"]).zfill(10),
            "ticker": entry["ticker"],
            "name": entry["title"],
            "as_of": as_of,
        }
        for entry in raw.values()
    ]
    return pl.DataFrame(rows)
