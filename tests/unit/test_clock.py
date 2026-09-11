from datetime import UTC, datetime, timedelta

from dashboard.ingestion.clock import now


def test_clock_now_returns_utc_aware_datetime() -> None:
    before = datetime.now(UTC)
    result = now()
    after = datetime.now(UTC)

    assert result.tzinfo is not None
    assert result.utcoffset() == timedelta(0)
    assert before <= result <= after
