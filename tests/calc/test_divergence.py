from dashboard.calc.divergence import is_divergent


def test_divergence_flag_above_threshold() -> None:
    # Au-dessus du seuil : écart relatif de 33 % (|100-150|/150), seuil 20 %.
    assert is_divergent(ttm_value=100.0, normalized_value=150.0, threshold=0.2) is True

    # En dessous du seuil : écart relatif de 6,7 % (|140-150|/150), seuil 20 %.
    assert is_divergent(ttm_value=140.0, normalized_value=150.0, threshold=0.2) is False
