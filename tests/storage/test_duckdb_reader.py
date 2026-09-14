from datetime import date
from pathlib import Path

import polars as pl
import pytest

from dashboard.storage.duckdb_reader import (
    ScreenResultsUnavailableError,
    read_facts_for_cik,
    read_latest_screen,
)


def test_duckdb_reader_reads_latest_day_read_only(tmp_path: Path) -> None:
    path = tmp_path / "screen_results.parquet"
    rows = pl.DataFrame(
        {
            "date": [date(2024, 2, 14), date(2024, 2, 14), date(2024, 2, 15)],
            "cik": ["0000000001", "0000000002", "0000000001"],
            "ev_ebit": [5.0, 7.0, 5.5],
        }
    )
    rows.write_parquet(path)
    before = path.read_bytes()

    latest = read_latest_screen(path)

    assert latest.sort("cik")["date"].to_list() == [date(2024, 2, 15)]
    assert latest["cik"].to_list() == ["0000000001"]
    # Lecture seule : le fichier sur disque n'a pas bougé (invariant 7 -- ce
    # module ne fait jamais une écriture déguisée en lecture).
    assert path.read_bytes() == before


def test_duckdb_reader_missing_file_raises(tmp_path: Path) -> None:
    missing = tmp_path / "screen_results.parquet"

    with pytest.raises(ScreenResultsUnavailableError):
        read_latest_screen(missing)


def test_duckdb_reader_empty_file_raises(tmp_path: Path) -> None:
    path = tmp_path / "screen_results.parquet"
    pl.DataFrame(
        {"date": [], "cik": [], "ev_ebit": []},
        schema={"date": pl.Date, "cik": pl.Utf8, "ev_ebit": pl.Float64},
    ).write_parquet(path)

    with pytest.raises(ScreenResultsUnavailableError):
        read_latest_screen(path)


def test_duckdb_reader_reads_facts_for_one_cik(tmp_path: Path) -> None:
    path = tmp_path / "fundamentals_raw.parquet"
    rows = pl.DataFrame(
        {
            "cik": ["0000000001", "0000000001", "0000000002"],
            "concept": ["LongTermDebtNoncurrent", "OperatingIncomeLoss", "OperatingIncomeLoss"],
            "taxonomy": ["us-gaap", "us-gaap", "us-gaap"],
            "unit": ["USD", "USD", "USD"],
            "end": [date(2023, 12, 31), date(2023, 12, 31), date(2023, 12, 31)],
            "start": [None, date(2023, 1, 1), date(2023, 1, 1)],
            "filed": [date(2024, 2, 1), date(2024, 2, 1), date(2024, 2, 1)],
            "accn": ["0000000001-24-000001", "0000000001-24-000001", "0000000002-24-000001"],
            "value": [100_000_000.0, 20_000_000.0, 15_000_000.0],
            "fiscal_period": ["FY", "FY", "FY"],
            "fiscal_year": [2023, 2023, 2023],
        },
        schema_overrides={"start": pl.Date},
    )
    rows.write_parquet(path)
    before = path.read_bytes()

    facts = read_facts_for_cik(path, "0000000001")

    assert facts.height == 2
    assert set(facts["cik"].to_list()) == {"0000000001"}
    assert path.read_bytes() == before
