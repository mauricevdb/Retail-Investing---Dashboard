from dashboard.calc.ranking import rank


def test_ranking_capped_at_25() -> None:
    # 40 titres retenus, EV/EBIT distincts -- le plus bas (le plus bon
    # marché) doit arriver en tête, et jamais plus de 25 lignes classées.
    statuses = [{"ev_ebit": float(i)} for i in range(40)]

    ranked = rank(statuses)

    assert len(ranked) == 25
    assert ranked[0]["rank"] == 1
    assert ranked[0]["ev_ebit"] == 0.0
    assert ranked[-1]["rank"] == 25
    assert ranked[-1]["ev_ebit"] == 24.0
