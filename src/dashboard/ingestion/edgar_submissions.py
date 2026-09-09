from datetime import date

import polars as pl


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
