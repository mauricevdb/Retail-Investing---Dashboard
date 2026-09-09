from datetime import date, datetime, timedelta


def last_session(instant: datetime, holidays: frozenset[date] = frozenset()) -> date:
    day = instant.date()
    while day.weekday() >= 5 or day in holidays:
        day -= timedelta(days=1)
    return day
