from datetime import date
from pathlib import Path

import polars as pl

from dashboard.storage.fundamentals_history import append


def _fact_row(filed: date, accn: str, value: float) -> dict:
    return {
        "cik": "0000000001",
        "concept": "NetIncomeLoss",
        "taxonomy": "us-gaap",
        "unit": "USD",
        "end": date(2023, 12, 31),
        "start": date(2023, 1, 1),
        "filed": filed,
        "accn": accn,
        "value": value,
        "fiscal_period": "FY",
        "fiscal_year": 2023,
    }


def test_fundamentals_history_append_only_no_dedup(tmp_path: Path) -> None:
    path = tmp_path / "fundamentals_raw.parquet"

    original = pl.DataFrame([_fact_row(date(2024, 2, 1), "0000000001-24-000001", 100.0)])
    append(path, original)
    assert pl.read_parquet(path).height == 1

    # Un retraitement dépose une deuxième valeur pour le même (cik, concept,
    # end) -- jamais dédupliqué ni écrasant la première (invariant 2, même
    # garantie que T6 côté calcul, ici côté persistance).
    restated = pl.DataFrame([_fact_row(date(2024, 5, 1), "0000000001-24-000042", 105.0)])
    append(path, restated)

    stored = pl.read_parquet(path)
    assert stored.height == 2
    assert sorted(stored["value"].to_list()) == [100.0, 105.0]
    assert sorted(stored["accn"].to_list()) == ["0000000001-24-000001", "0000000001-24-000042"]
