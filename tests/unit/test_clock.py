from datetime import datetime, timedelta, timezone

from dashboard.ingestion.clock import now


def test_clock_now_returns_utc_aware_datetime() -> None:
    before = datetime.now(timezone.utc)
    result = now()
    after = datetime.now(timezone.utc)

    assert result.tzinfo is not None
    assert result.utcoffset() == timedelta(0)
    assert before <= result <= after
