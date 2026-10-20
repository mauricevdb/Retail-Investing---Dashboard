"""Mean-variance portfolio construction: returns, covariance and efficient portfolios.

Portfolios are long-only, fully invested and capped per asset. Every efficient portfolio
minimises  ½·w'Σw − λ·μ'w  for some risk tolerance λ ≥ 0: λ = 0 gives the minimum-variance
portfolio and a growing λ moves along the frontier towards the highest expected return.
Each problem is a small convex quadratic program, solved by accelerated projected gradient.
"""

from dataclasses import dataclass

import numpy as np
import polars as pl

WEEKS_PER_YEAR = 52


@dataclass(frozen=True)
class Estimates:
    mean: np.ndarray  # annualised expected returns
    cov: np.ndarray  # annualised covariance
    shrinkage: float | None  # Ledoit-Wolf intensity, None for the sample covariance


@dataclass(frozen=True)
class Portfolio:
    weights: np.ndarray
    expected_return: float
    volatility: float

    def sharpe(self, risk_free: float) -> float:
        return (self.expected_return - risk_free) / self.volatility


def weekly_returns(
    prices: pl.DataFrame, min_coverage: float = 0.9
) -> tuple[pl.DataFrame, list[str]]:
    """Weekly returns from daily adjusted closes: one column per ticker, common weeks only.

    Tickers quoted over less than `min_coverage` of the weeks (recent listings) are left
    out rather than shortening the window for every other asset."""
    order = prices["ticker"].unique(maintain_order=True).to_list()
    weekly = (
        prices.sort("date")
        .group_by("ticker", pl.col("date").dt.truncate("1w").alias("week"))
        .agg(pl.col("adj_close").last())
        .pivot(on="ticker", index="week", values="adj_close")
        .sort("week")
    )
    quoted = [t for t in order if t in weekly.columns]
    kept = [t for t in quoted if weekly[t].is_not_null().mean() >= min_coverage]
    returns = weekly.select("week", *(pl.col(t).pct_change() for t in kept)).slice(1).drop_nulls()
    return returns, [t for t in order if t not in kept]


def estimate(returns: np.ndarray, shrink: bool = True) -> Estimates:
    """Annualised mean and covariance of weekly returns (rows = weeks, columns = assets)."""
    mean = returns.mean(axis=0) * WEEKS_PER_YEAR
    if shrink:
        cov, intensity = ledoit_wolf(returns)
    else:
        cov, intensity = np.cov(returns, rowvar=False), None
    return Estimates(mean, cov * WEEKS_PER_YEAR, intensity)


def ledoit_wolf(returns: np.ndarray) -> tuple[np.ndarray, float]:
    """Sample covariance shrunk towards a scaled identity (Ledoit & Wolf, 2004).

    The intensity is estimated from the data: it grows when there are few observations per
    asset, which keeps the matrix well conditioned and the optimal weights stable."""
    x = returns - returns.mean(axis=0)
    t, n = x.shape
    sample = x.T @ x / t
    target = np.trace(sample) / n * np.eye(n)
    distance = ((sample - target) ** 2).sum()
    # Average squared distance between each week's outer product and the sample covariance.
    noise = (
        (x * x).sum(axis=1) ** 2 - 2 * np.einsum("ti,ij,tj->t", x, sample, x) + (sample**2).sum()
    ).sum() / t**2
    intensity = min(noise, distance) / distance
    return intensity * target + (1 - intensity) * sample, float(intensity)


def project_capped_simplex(v: np.ndarray, cap: float) -> np.ndarray:
    """Closest point to v with weights in [0, cap] summing to 1.

    The solution is clip(v − τ, 0, cap) for the τ that makes the weights sum to 1. That sum
    is piecewise linear in τ with breakpoints at v and v − cap, so τ is found exactly by
    evaluating it at every breakpoint and interpolating in the right segment."""
    taus = np.sort(np.concatenate([v - cap, v]))
    sums = np.clip(v[None, :] - taus[:, None], 0, cap).sum(axis=1)
    k = np.nonzero(sums >= 1)[0][-1]
    tau = taus[k] + (sums[k] - 1) * (taus[k + 1] - taus[k]) / (sums[k] - sums[k + 1])
    return np.clip(v - tau, 0, cap)


class EfficientSet:
    """Efficient long-only portfolios for given estimates and maximum weight per asset."""

    def __init__(self, estimates: Estimates, max_weight: float) -> None:
        n = len(estimates.mean)
        if max_weight * n < 1:
            raise ValueError(f"a {max_weight:.0%} cap cannot fully invest {n} assets")
        self.estimates = estimates
        self.max_weight = max_weight
        self._step = 1 / np.linalg.eigvalsh(estimates.cov)[-1]
        # Beyond this risk tolerance the expected-return term dominates: the solution is the
        # highest-return corner of the feasible set.
        spread = max(float(np.ptp(estimates.mean)), 1e-9)
        self.max_tolerance = 1e3 / (self._step * spread)
        self._last = np.full(n, 1 / n)

    def portfolio(self, weights: np.ndarray) -> Portfolio:
        mean, cov = self.estimates.mean, self.estimates.cov
        return Portfolio(weights, float(mean @ weights), float(np.sqrt(weights @ cov @ weights)))

    def solve(self, risk_tolerance: float) -> Portfolio:
        mean, cov = self.estimates.mean, self.estimates.cov
        w = y = self._last
        t = 1.0
        for _ in range(20_000):
            gradient = cov @ y - risk_tolerance * mean
            w_next = project_capped_simplex(y - self._step * gradient, self.max_weight)
            if np.abs(w_next - w).max() < 1e-10:
                break
            t_next = (1 + np.sqrt(1 + 4 * t * t)) / 2
            y = w_next + (t - 1) / t_next * (w_next - w)
            w, t = w_next, t_next
        self._last = w_next
        return self.portfolio(w_next)

    def tolerances(self, points: int = 60) -> np.ndarray:
        return np.concatenate(
            [[0.0], np.geomspace(self.max_tolerance * 1e-6, self.max_tolerance, points)]
        )

    def min_variance(self) -> Portfolio:
        return self.solve(0.0)

    def frontier(self, points: int = 60) -> list[Portfolio]:
        return [self.solve(tolerance) for tolerance in self.tolerances(points)]

    def max_sharpe(self, risk_free: float) -> Portfolio | None:
        """Tangency portfolio: best Sharpe ratio on the frontier, refined by golden-section
        search around the best grid point. None when no asset beats the risk-free rate."""
        if self.estimates.mean.max() <= risk_free:
            return None
        grid = self.tolerances()
        sharpes = [self.solve(tolerance).sharpe(risk_free) for tolerance in grid]
        best = int(np.argmax(sharpes))
        low = np.log(grid[max(best - 1, 1)])
        high = np.log(grid[min(best + 1, len(grid) - 1)])
        ratio = (np.sqrt(5) - 1) / 2
        for _ in range(30):
            a, b = high - ratio * (high - low), low + ratio * (high - low)
            if self.solve(np.exp(a)).sharpe(risk_free) >= self.solve(np.exp(b)).sharpe(risk_free):
                high = b
            else:
                low = a
        candidates = [self.solve(np.exp((low + high) / 2)), self.solve(grid[best])]
        return max(candidates, key=lambda p: p.sharpe(risk_free))

    def target_volatility(self, volatility: float) -> Portfolio:
        """Highest-return efficient portfolio whose volatility does not exceed the target."""
        low, high = np.log(self.max_tolerance * 1e-6), np.log(self.max_tolerance)
        if volatility <= self.min_variance().volatility:
            return self.min_variance()
        if volatility >= self.solve(self.max_tolerance).volatility:
            return self.solve(self.max_tolerance)
        for _ in range(40):
            middle = (low + high) / 2
            if self.solve(np.exp(middle)).volatility > volatility:
                high = middle
            else:
                low = middle
        return self.solve(np.exp(low))
