def _passes(
    status: dict[str, float | str | None], thresholds: dict[str, tuple[float | None, float | None]]
) -> bool:
    if status.get("in_universe") is False:
        return False

    for indicator, (low, high) in thresholds.items():
        value = status.get(indicator)
        if value is None:
            return False
        if low is not None and value < low:
            return False
        if high is not None and value > high:
            return False
    return True


def apply_filters(
    statuses: list[dict[str, float | str | None]],
    thresholds: dict[str, tuple[float | None, float | None]],
) -> tuple[list[dict[str, float | str | None]], int]:
    retained = [status for status in statuses if _passes(status, thresholds)]
    return retained, len(retained)
