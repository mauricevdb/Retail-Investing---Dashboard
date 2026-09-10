from dashboard.calc.percentiles import sector_percentile


def test_sector_percentile_fallback_below_10() -> None:
    # Groupe de dix titres ou plus : percentile calculé normalement.
    large_group = [float(i) for i in range(1, 11)]  # 10 valeurs, 1..10
    percentile, available = sector_percentile(large_group, current_value=10.0)
    assert available is True
    assert percentile == 1.0

    # Groupe réduit à moins de dix titres : repli, percentile non calculé.
    small_group = [5.0, 6.0, 7.0]
    percentile, available = sector_percentile(small_group, current_value=6.0)
    assert available is False
    assert percentile is None
