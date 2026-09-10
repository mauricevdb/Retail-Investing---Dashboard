_MAX_RANKED = 25


def rank(
    statuses: list[dict[str, float | str | None]],
    primary_indicator: str = "ev_ebit",
    cap: int = _MAX_RANKED,
) -> list[dict[str, float | str | None]]:
    ordered = sorted(statuses, key=lambda status: status[primary_indicator])
    capped = ordered[:cap]
    return [{**status, "rank": position + 1} for position, status in enumerate(capped)]
