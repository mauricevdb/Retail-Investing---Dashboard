from datetime import date

import polars as pl


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
