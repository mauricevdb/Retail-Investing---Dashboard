import polars as pl

from dashboard.calc.universe import apply_hysteresis


def test_universe_stable_near_cutoff_with_hysteresis() -> None:
    n = 900
    buffer = 100
    ranks_over_days = [850, 950, 860, 940, 870]

    member_status = True  # MMMM commence dans l'univers.
    nonmember_status = False  # NNNN commence hors de l'univers.

    for rank in ranks_over_days:
        ranked = pl.DataFrame({"ticker": ["MMMM", "NNNN"], "rank": [rank, rank]})
        hier_membership = set()
        if member_status:
            hier_membership.add("MMMM")
        if nonmember_status:
            hier_membership.add("NNNN")

        result = apply_hysteresis(ranked, hier_membership, n=n, buffer=buffer)

        member_status = result.filter(pl.col("ticker") == "MMMM").row(0, named=True)[
            "in_universe"
        ]
        nonmember_status = result.filter(pl.col("ticker") == "NNNN").row(0, named=True)[
            "in_universe"
        ]

        # Rang toujours dans la bande neutre [800, 1000] : le statut de la
        # veille doit être reconduit, dans les deux sens.
        assert member_status is True
        assert nonmember_status is False
