from datetime import date

import polars as pl

from dashboard.ingestion.eodhd_client import EodhdClient


def fetch_bulk_prices(client: EodhdClient, day: date) -> tuple[pl.DataFrame, pl.DataFrame]:
    raw = client.get_json(f"https://eodhd.com/api/eod-bulk-last-day/US?date={day.isoformat()}")
    return parse_bulk_prices(raw)


def parse_bulk_prices(raw: list[dict]) -> tuple[pl.DataFrame, pl.DataFrame]:
    raw_rows = [
        {
            "ticker": entry["code"],
            "date": date.fromisoformat(entry["date"]),
            "open": entry["open"],
            "high": entry["high"],
            "low": entry["low"],
            "close": entry["close"],
            "volume": entry["volume"],
        }
        for entry in raw
    ]
    adjusted_rows = [
        {
            "ticker": entry["code"],
            "date": date.fromisoformat(entry["date"]),
            "close_adj": entry["adjusted_close"],
        }
        for entry in raw
    ]
    return pl.DataFrame(raw_rows), pl.DataFrame(adjusted_rows)
