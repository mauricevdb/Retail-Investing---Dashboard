"""Mean-variance portfolio construction: returns, covariance and efficient portfolios.

Portfolios are long-only, fully invested, capped per asset and, optionally, per group of
assets (sector, country). Every efficient portfolio minimises  ½·w'Σw − λ·μ'w  for some risk
tolerance λ ≥ 0: λ = 0 gives the minimum-variance portfolio and a growing λ moves along the
frontier towards the highest expected return. Each problem is a small convex quadratic program.
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


@dataclass(frozen=True)
class GroupCap:
    """At most `cap` of the portfolio in the assets flagged by `members` (a sector, a country)."""

    name: str
    members: np.ndarray  # boolean, one entry per asset
    cap: float


class QuadraticProgram:
    """min ½·x'Px + q'x  subject to  lo ≤ Ax ≤ hi, for a fixed P, A, lo, hi and any q.

    Solved by ADMM as in OSQP (Stellato et al., 2020): each iteration solves one linear system,
    whose matrix is inverted once, then clips Ax to its bounds. Equality rows (lo = hi) get a
    stiffer penalty, and the penalty is rebalanced while the primal and dual residuals drift
    apart. Warm starts make a sequence of nearby problems cheap."""

    SIGMA = 1e-6
    ALPHA = 1.6  # over-relaxation

    def __init__(self, P: np.ndarray, A: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> None:
        self.P, self.A, self.lo, self.hi = P, A, lo, hi
        self._equality = lo == hi
        self._factor(0.1)
        n, m = A.shape[1], A.shape[0]
        self._x, self._z, self._y = np.full(n, 1 / n), np.zeros(m), np.zeros(m)

    def _factor(self, rho: float) -> None:
        self._rho_scalar = rho
        self._rho = np.where(self._equality, 1e3 * rho, rho)
        n = self.P.shape[0]
        matrix = self.P + self.SIGMA * np.eye(n) + self.A.T @ (self._rho[:, None] * self.A)
        self._inverse = np.linalg.inv(matrix)

    def solve(self, q: np.ndarray, tolerance: float = 1e-9, max_iter: int = 100_000) -> np.ndarray:
        P, A, lo, hi = self.P, self.A, self.lo, self.hi
        x, z, y = self._x, self._z, self._y
        for iteration in range(1, max_iter + 1):
            x_tilde = self._inverse @ (self.SIGMA * x - q + A.T @ (self._rho * z - y))
            z_tilde = A @ x_tilde
            x = self.ALPHA * x_tilde + (1 - self.ALPHA) * x
            z_relaxed = self.ALPHA * z_tilde + (1 - self.ALPHA) * z
            z_next = np.clip(z_relaxed + y / self._rho, lo, hi)
            y = y + self._rho * (z_relaxed - z_next)
            z = z_next
            if iteration % 10:
                continue
            Ax, Px, Aty = A @ x, P @ x, A.T @ y
            primal = np.abs(Ax - z).max()
            dual = np.abs(Px + q + Aty).max()
            primal_scale = max(np.abs(Ax).max(), np.abs(z).max(), 1e-12)
            dual_scale = max(np.abs(Px).max(), np.abs(Aty).max(), np.abs(q).max(), 1e-12)
            if primal <= tolerance * (1 + primal_scale) and dual <= tolerance * (1 + dual_scale):
                self._x, self._z, self._y = x, z, y
                return x
            ratio = np.sqrt((primal / primal_scale) / max(dual / dual_scale, 1e-30))
            if iteration % 50 == 0 and not 0.2 < ratio < 5:
                self._factor(float(np.clip(self._rho_scalar * ratio, 1e-6, 1e6)))
        raise ValueError("constraints cannot all be met")


class EfficientSet:
    """Efficient long-only portfolios for given estimates, maximum weight per asset and caps
    on groups of assets."""

    def __init__(
        self, estimates: Estimates, max_weight: float, groups: tuple[GroupCap, ...] = ()
    ) -> None:
        n = len(estimates.mean)
        if max_weight * n < 1:
            raise ValueError(f"a {max_weight:.0%} cap cannot fully invest {n} assets")
        self.estimates = estimates
        self.max_weight = max_weight
        self.groups = groups
        # Asset bounds, full investment, then one row per group.
        A = np.vstack([np.eye(n), np.ones(n), *(g.members.astype(float) for g in groups)])
        lo = np.concatenate([np.zeros(n), [1.0], np.full(len(groups), -np.inf)])
        hi = np.concatenate([np.full(n, max_weight), [1.0], [g.cap for g in groups]])
        self._program = QuadraticProgram(estimates.cov, A, lo, hi)
        self._projection = QuadraticProgram(np.eye(n), A, lo, hi)
        # Beyond this risk tolerance the expected-return term dominates: the solution is the
        # highest-return corner of the feasible set.
        spread = max(float(np.ptp(estimates.mean)), 1e-9)
        top_eigenvalue = np.linalg.eigvalsh(estimates.cov)[-1]
        self.max_tolerance = 1e3 * top_eigenvalue / spread

    def portfolio(self, weights: np.ndarray) -> Portfolio:
        mean, cov = self.estimates.mean, self.estimates.cov
        return Portfolio(weights, float(mean @ weights), float(np.sqrt(weights @ cov @ weights)))

    def _clean(self, weights: np.ndarray) -> np.ndarray:
        # Remove the solver's residual noise (around 1e-9) so that weights read exactly.
        weights = np.clip(weights, 0, self.max_weight)
        return weights / weights.sum()

    def solve(self, risk_tolerance: float) -> Portfolio:
        weights = self._program.solve(-risk_tolerance * self.estimates.mean)
        return self.portfolio(self._clean(weights))

    def equal_weight(self) -> Portfolio:
        """The same weight in every asset or, when a cap binds, the closest portfolio to it
        that respects the caps."""
        n = len(self.estimates.mean)
        return self.portfolio(self._clean(self._projection.solve(-np.full(n, 1 / n))))

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
