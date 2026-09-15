from datetime import date

import polars as pl

from dashboard.ingestion.edgar_client import EdgarClient

_FRAMES_URL = "https://data.sec.gov/api/xbrl/frames/{taxonomy}/{tag}/{unit}/{period}.json"


def fetch_shares_outstanding_frame(
    client: EdgarClient,
    period: str,
    taxonomy: str = "dei",
    tag: str = "EntityCommonStockSharesOutstanding",
    unit: str = "shares",
) -> pl.DataFrame:
    url = _FRAMES_URL.format(taxonomy=taxonomy, tag=tag, unit=unit, period=period)
    raw = client.get_json(url)
    return parse_shares_outstanding_frame(raw)


def parse_shares_outstanding_frame(raw: dict) -> pl.DataFrame:
    rows = [
        {
            "cik": str(entry["cik"]).zfill(10),
            "end": date.fromisoformat(entry["end"]),
            "value": float(entry["val"]),
        }
        for entry in raw["data"]
    ]
    return pl.DataFrame(rows)
