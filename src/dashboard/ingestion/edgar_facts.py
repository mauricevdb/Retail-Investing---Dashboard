from datetime import date

import polars as pl

_SCHEMA = {
    "cik": pl.Utf8,
    "concept": pl.Utf8,
    "taxonomy": pl.Utf8,
    "unit": pl.Utf8,
    "end": pl.Date,
    "start": pl.Date,
    "filed": pl.Date,
    "accn": pl.Utf8,
    "value": pl.Float64,
    "fiscal_period": pl.Utf8,
    "fiscal_year": pl.Int64,
}


def parse_company_facts(raw: dict) -> pl.DataFrame:
    cik = str(raw["cik"]).zfill(10)
    us_gaap = raw["facts"].get("us-gaap", {})

    rows = [
        {
            "cik": cik,
            "concept": concept,
            "taxonomy": "us-gaap",
            "unit": unit,
            "end": date.fromisoformat(entry["end"]),
            "start": date.fromisoformat(entry["start"]) if "start" in entry else None,
            "filed": date.fromisoformat(entry["filed"]),
            "accn": entry["accn"],
            "value": entry["val"],
            "fiscal_period": entry["fp"],
            "fiscal_year": entry["fy"],
        }
        for concept, concept_data in us_gaap.items()
        for unit, entries in concept_data["units"].items()
        for entry in entries
    ]
    return pl.DataFrame(rows, schema=_SCHEMA)
