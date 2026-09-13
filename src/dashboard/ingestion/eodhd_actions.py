from datetime import date

import polars as pl

from dashboard.ingestion.eodhd_client import EodhdClient


def fetch_bulk_actions(client: EodhdClient, day: date) -> pl.DataFrame:
    raw = client.get_json(
        f"https://eodhd.com/api/eod-bulk-last-day/US?type=splits&date={day.isoformat()}"
    )
    return parse_corporate_actions(raw)


def parse_corporate_actions(raw: list[dict]) -> pl.DataFrame:
    rows = []
    for entry in raw:
        if "split" in entry:
            numerator, denominator = entry["split"].split("/")
            rows.append(
                {
                    "ticker": entry["code"],
                    "date_effective": date.fromisoformat(entry["date"]),
                    "action_type": "split",
                    "ratio_or_amount": float(numerator) / float(denominator),
                }
            )
    return pl.DataFrame(rows)
