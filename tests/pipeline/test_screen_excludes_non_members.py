from dashboard.calc.filters import apply_filters


def test_screen_excludes_non_members() -> None:
    # Les deux titres ont un EV/EBIT identique, passant les seuils --
    # seule l'appartenance à l'univers du jour doit faire la différence.
    statuses = [
        {"cik": "0000000001", "ev_ebit": 5.0, "in_universe": True},
        {"cik": "0000000002", "ev_ebit": 5.0, "in_universe": False},  # sorti, hors hystérésis
    ]

    retained, count = apply_filters(statuses, {"ev_ebit": (0.0, 100.0)})

    assert count == 1
    assert retained[0]["cik"] == "0000000001"
