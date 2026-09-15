_MAX_RANKED = 25


def rank(
    statuses: list[dict[str, float | str | None]],
    primary_indicator: str = "ev_ebit",
    cap: int = _MAX_RANKED,
) -> list[dict[str, float | str | None]]:
    # Un titre dont l'indicateur de tri est non calculable ne peut être
    # comparé à aucun autre -- il ne peut jamais entrer dans un classement,
    # quels que soient les seuils appliqués en amont par apply_filters
    # (invariant 7 : jamais un plantage silencieux sur une comparaison
    # impossible).
    rankable = [status for status in statuses if status[primary_indicator] is not None]
    ordered = sorted(rankable, key=lambda status: status[primary_indicator])
    capped = ordered[:cap]
    return [{**status, "rank": position + 1} for position, status in enumerate(capped)]
