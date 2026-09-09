def is_divergent(ttm_value: float, normalized_value: float, threshold: float) -> bool:
    relative_gap = abs(ttm_value - normalized_value) / abs(normalized_value)
    return relative_gap > threshold
