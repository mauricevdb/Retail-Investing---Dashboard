from datetime import date, timedelta

from dashboard.calc.streak import consecutive_days


def test_consecutive_days_streak() -> None:
    start = date(2024, 2, 1)
    history = [(start + timedelta(days=i), True) for i in range(5)]
    history.append((start + timedelta(days=5), False))  # 6e jour, absent

    # Évalué au 5e jour (le dernier où le titre est présent) : série de 5,
    # pas 6 -- le 6e jour (absent, postérieur à t) n'est pas pris en compte.
    streak = consecutive_days(history, t=start + timedelta(days=4))
    assert streak == 5
