from datetime import date

import polars as pl

from dashboard.ingestion.edgar_client import EdgarClient


def fetch_submissions(
    client: EdgarClient, cik: str, as_of: date
) -> tuple[pl.DataFrame, pl.DataFrame]:
    raw = client.get_json(f"https://data.sec.gov/submissions/CIK{cik}.json")
    return parse_filings(raw), parse_sic_and_entity_type(raw, as_of)


def parse_filings(raw: dict) -> pl.DataFrame:
    cik = raw["cik"]
    recent = raw["filings"]["recent"]
    rows = [
        {
            "cik": cik,
            "accn": accn,
            "form": form,
            "filed": date.fromisoformat(filed),
            "period_of_report": date.fromisoformat(report_date),
        }
        for accn, form, filed, report_date in zip(
            recent["accessionNumber"],
            recent["form"],
            recent["filingDate"],
            recent["reportDate"],
        )
    ]
    return pl.DataFrame(rows)


def parse_sic_and_entity_type(raw: dict, as_of: date) -> pl.DataFrame:
    row = {
        "cik": raw["cik"],
        "sic": raw["sic"],
        "sic_description": raw["sicDescription"],
        "entity_type": raw["entityType"],
        "as_of": as_of,
    }
    return pl.DataFrame([row])
