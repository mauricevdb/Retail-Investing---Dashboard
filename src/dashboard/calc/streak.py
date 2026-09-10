from datetime import date


def consecutive_days(history: list[tuple[date, bool]], t: date) -> int:
    relevant = sorted((day, passed) for day, passed in history if day <= t)

    streak = 0
    for _, passed in reversed(relevant):
        if not passed:
            break
        streak += 1

    return streak
