import json

import polars as pl
import pytest

from ridash import stability
from ridash.config import TRAP_WEIGHTS


def criteria(score):
    return {name: {"score": score, "rationale": "r", "sources": []} for name in TRAP_WEIGHTS}


def test_sample_spreads_from_lowest_to_highest_risk():
    review = pl.DataFrame(
        {"ticker": list("ABCDEFG"), "trap_risk": [70.0, 10, 40, 20, 50, 30, None]}
    )
    assert stability.spread_sample(review, 3)["ticker"].to_list() == ["B", "F", "A"]


def test_cutoff_lies_between_last_kept_and_first_excluded():
    review = pl.DataFrame(
        {
            "trap_risk": [10.0, 22.0, 26.0, 60.0],
            "suggestion": ["keep", "keep", "exclude", "exclude"],
        }
    )
    assert stability.cutoff(review) == pytest.approx(24.0)


def test_compare_measures_spread_agreement_and_flips():
    sample = pl.DataFrame(
        {
            "ticker": ["A", "B"],
            "trap_risk": [20.0, 40.0],
            "criteria": [json.dumps(criteria(1)), json.dumps(criteria(2))],
        }
    )
    reruns = {"A": [criteria(1), criteria(2)], "B": [criteria(2)]}
    result = {
        r["ticker"]: r for r in stability.compare(sample, reruns, cut=30.0).iter_rows(named=True)
    }
    assert result["A"]["reruns"] == [20.0, 40.0]
    assert result["A"]["spread"] == 20.0 and result["A"]["same_scores"] == 0.5
    assert result["A"]["flips"]  # one rerun lands above the cut-off
    assert result["B"]["spread"] == 0.0 and not result["B"]["flips"]
