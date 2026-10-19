from datetime import date

import polars as pl

from ridash import refresh


def test_existing_snapshot_is_never_rewritten(monkeypatch, tmp_path):
    existing = tmp_path / "2026-10-16.parquet"
    existing.write_bytes(b"original")
    monkeypatch.setattr(refresh, "SNAPSHOT_DIR", tmp_path)
    monkeypatch.setattr(
        refresh.eodhd, "quotes", lambda: pl.DataFrame({"date": [date(2026, 10, 16)]})
    )

    def fail(*_):
        raise AssertionError("snapshot rebuilt")

    monkeypatch.setattr(refresh, "build_snapshot", fail)
    refresh.main()
    assert existing.read_bytes() == b"original"
