from datetime import date, timedelta

import numpy as np
import polars as pl
import pytest

from ridash.portfolio import (
    EfficientSet,
    Estimates,
    GroupCap,
    estimate,
    ledoit_wolf,
    weekly_returns,
)


def uncorrelated(mean, vol):
    return Estimates(np.array(mean), np.diag(np.array(vol) ** 2), None)


def test_min_variance_weights_are_inverse_variances():
    vol = [0.1, 0.2, 0.4]
    weights = EfficientSet(uncorrelated([0.05, 0.05, 0.05], vol), 1.0).min_variance().weights
    inverse = 1 / np.array(vol) ** 2
    np.testing.assert_allclose(weights, inverse / inverse.sum(), atol=1e-6)


def test_cap_binds_on_the_dominant_asset():
    weights = EfficientSet(uncorrelated([0.05] * 3, [0.05, 0.3, 0.3]), 0.4).min_variance().weights
    np.testing.assert_allclose(weights, [0.4, 0.3, 0.3], atol=1e-6)


def test_group_cap_limits_the_weight_of_a_sector():
    est = uncorrelated([0.05] * 4, [0.1, 0.1, 0.3, 0.3])
    sector = GroupCap("Energy", np.array([True, True, False, False]), 0.5)
    weights = EfficientSet(est, 1.0, (sector,)).min_variance().weights
    assert weights[:2].sum() == pytest.approx(0.5, abs=1e-6)
    np.testing.assert_allclose(weights, [0.25, 0.25, 0.25, 0.25], atol=1e-6)


def test_equal_weight_moves_only_as_far_as_the_caps_require():
    est = uncorrelated([0.05] * 5, [0.2] * 5)
    china = GroupCap("China", np.array([True, True, True, False, False]), 0.3)
    efficient = EfficientSet(est, 1.0, (china,))
    np.testing.assert_allclose(efficient.equal_weight().weights, [0.1] * 3 + [0.35] * 2, atol=1e-6)
    uncapped = EfficientSet(est, 1.0).equal_weight().weights
    np.testing.assert_allclose(uncapped, [0.2] * 5, atol=1e-9)


def test_caps_that_cannot_be_met_are_reported():
    est = uncorrelated([0.05] * 2, [0.2] * 2)
    both = GroupCap("Energy", np.array([True, True]), 0.6)
    with pytest.raises(ValueError):
        EfficientSet(est, 1.0, (both,)).min_variance()


def test_max_sharpe_matches_tangency_formula():
    est = uncorrelated([0.08, 0.10, 0.12], [0.15, 0.20, 0.25])
    risk_free = 0.02
    tangency = np.linalg.solve(est.cov, est.mean - risk_free)
    tangency /= tangency.sum()
    result = EfficientSet(est, 1.0).max_sharpe(risk_free)
    np.testing.assert_allclose(result.weights, tangency, atol=1e-4)


def test_no_tangency_when_nothing_beats_the_risk_free_rate():
    assert EfficientSet(uncorrelated([0.01, 0.02], [0.1, 0.2]), 1.0).max_sharpe(0.05) is None


def test_frontier_return_and_risk_increase_together():
    rng = np.random.default_rng(1)
    est = estimate(rng.normal(0.002, 0.03, size=(150, 8)) + rng.normal(0, 0.002, size=8))
    frontier = EfficientSet(est, 0.3).frontier()
    returns = [p.expected_return for p in frontier]
    vols = [p.volatility for p in frontier]
    # Up to the solver precision: the end of the frontier is one corner portfolio.
    assert np.all(np.diff(returns) >= -1e-8) and np.all(np.diff(vols) >= -1e-8)


def test_target_volatility_is_respected():
    est = uncorrelated([0.05, 0.10, 0.20], [0.10, 0.20, 0.40])
    efficient = EfficientSet(est, 1.0)
    target = efficient.target_volatility(0.2)
    assert target.volatility == pytest.approx(0.2, abs=1e-4)
    assert target.expected_return > efficient.min_variance().expected_return


def test_ledoit_wolf_keeps_matrix_invertible_with_few_observations():
    returns = np.random.default_rng(2).normal(0, 0.03, size=(20, 40))  # fewer weeks than assets
    cov, intensity = ledoit_wolf(returns)
    assert 0 < intensity <= 1
    assert np.linalg.eigvalsh(cov).min() > 0


def test_weekly_returns_use_last_close_of_each_week_and_drop_short_histories():
    monday = date(2026, 1, 5)
    days = [monday + timedelta(days=7 * week + day) for week in range(10) for day in range(5)]
    old = [{"ticker": "OLD", "date": d, "adj_close": 100.0 + i} for i, d in enumerate(days)]
    new = [{"ticker": "NEW", "date": d, "adj_close": 50.0} for d in days[-10:]]
    returns, excluded = weekly_returns(pl.DataFrame(old + new))
    assert excluded == ["NEW"]
    assert returns.columns == ["week", "OLD"]
    assert returns["OLD"][0] == pytest.approx(109 / 104 - 1)  # Friday close to Friday close
