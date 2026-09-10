def own_history_percentile(
    historical_values: list[tuple[int, float]], t_year: int, since_year: int = 2011
) -> tuple[float | None, int]:
    window = [(year, value) for year, value in historical_values if since_year <= year <= t_year]
    years_available = len(window)

    current = next((value for year, value in window if year == t_year), None)
    if current is None or not window:
        return None, years_available

    values = [value for _, value in window]
    percentile = sum(1 for value in values if value <= current) / len(values)
    return percentile, years_available
