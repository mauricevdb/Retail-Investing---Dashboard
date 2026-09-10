import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.ratios import price_variation
from dashboard.ingestion.eodhd_prices import parse_bulk_prices

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "eodhd_bulk_prices_2024-02-15.json"


def test_no_raw_adjusted_mixing() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)
    prices_raw, prices_adjusted = parse_bulk_prices(raw)

    today = date(2024, 2, 15)

    # Mélange interdit (invariant 4), reproduit ici uniquement pour prouver
    # qu'il donnerait un résultat faux -- jamais fait par le pipeline.
    # AAAA a subi un fractionnement 2:1 le 2024-02-15 : le cours brut
    # veille/jour (150.0 -> 76.5) ressemble à tort à une chute de ~49 %.
    raw_rows = (
        prices_raw.filter((pl.col("ticker") == "AAAA") & (pl.col("date") <= today))
        .sort("date", descending=True)
        .head(2)
    )
    wrong_ratio = raw_rows["close"][0] / raw_rows["close"][1]

    # Résultat réel du pipeline : série ajustée uniquement (75.0 -> 76.5,
    # continue à travers le fractionnement).
    correct_ratio = price_variation(prices_adjusted, ticker="AAAA", date_today=today)

    assert correct_ratio == 76.5 / 75.0
    assert wrong_ratio != correct_ratio
