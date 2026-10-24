from datetime import date

import polars as pl
import pytest

from ridash import update


@pytest.fixture
def commands(monkeypatch, tmp_path):
    ran = []
    monkeypatch.setattr(update, "run", ran.append)
    monkeypatch.setattr(update, "STABILITY_DIR", tmp_path)
    review = pl.DataFrame({"date": [date(2026, 10, 23)]})
    monkeypatch.setattr(update, "latest_review", lambda: review)
    return ran, tmp_path


def test_update_tests_a_new_review_once(commands):
    ran, stability_dir = commands
    update.main()
    assert ran == ["ridash.refresh", "ridash.review", "ridash.stability"]

    ran.clear()
    (stability_dir / "2026-10-23.parquet").write_bytes(b"done")
    update.main()
    assert ran == ["ridash.refresh", "ridash.review"]


def test_a_failed_step_stops_the_update(monkeypatch):
    monkeypatch.setattr(update.subprocess, "run", lambda *_: type("Done", (), {"returncode": 1}))
    with pytest.raises(SystemExit, match="ridash.refresh failed"):
        update.run("ridash.refresh")
