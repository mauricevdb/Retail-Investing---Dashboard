from datetime import date

import polars as pl


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
