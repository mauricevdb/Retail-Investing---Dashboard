from datetime import date, datetime, timezone

from dashboard.calc.market_calendar import last_session


def test_last_session_not_calendar_today() -> None:
    # Dimanche 2024-02-18 -> dernière séance effective : vendredi 2024-02-16.
    sunday = datetime(2024, 2, 18, 10, 0, tzinfo=timezone.utc)
    assert last_session(sunday) == date(2024, 2, 16)

    # Lundi férié (MLK Day, 2024-01-15) -> dernière séance : vendredi 2024-01-12.
    holiday_monday = datetime(2024, 1, 15, 10, 0, tzinfo=timezone.utc)
    assert last_session(holiday_monday, holidays=frozenset({date(2024, 1, 15)})) == date(
        2024, 1, 12
    )

    # Jour de séance normal : renvoie la date elle-même.
    wednesday = datetime(2024, 2, 14, 10, 0, tzinfo=timezone.utc)
    assert last_session(wednesday) == date(2024, 2, 14)
