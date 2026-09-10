from dashboard.calc.filters import apply_filters


def test_filter_count_including_zero() -> None:
    statuses = [
        {"ev_ebit": 5.0, "roic": 0.10},
        {"ev_ebit": 8.0, "roic": 0.15},
        {"ev_ebit": 12.0, "roic": 0.05},
    ]

    # Seuils n'excluant aucun titre.
    permissive = {"ev_ebit": (0.0, 100.0)}
    retained, count = apply_filters(statuses, permissive)
    assert count == 3
    assert retained == statuses

    # Seuils excluant tous les titres : le compteur vaut zéro, sans erreur.
    strict = {"ev_ebit": (0.0, 1.0)}
    retained, count = apply_filters(statuses, strict)
    assert count == 0
    assert retained == []
