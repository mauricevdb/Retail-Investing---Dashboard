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


def test_ranking_excludes_non_calculable_primary_indicator() -> None:
    # Découvert en ingestion réelle (T75) : un titre sans indicateur de tri
    # calculable ne peut jamais être classé, quels que soient les seuils
    # appliqués en amont -- il doit être exclu du classement, jamais faire
    # planter le tri des autres (invariant 7 : pas de comparaison
    # impossible qui fait tout échouer silencieusement).
    statuses = [
        {"ev_ebit": 5.0},
        {"ev_ebit": None},
        {"ev_ebit": 2.0},
    ]

    ranked = rank(statuses)

    assert len(ranked) == 2
    assert [status["ev_ebit"] for status in ranked] == [2.0, 5.0]
    assert [status["rank"] for status in ranked] == [1, 2]
