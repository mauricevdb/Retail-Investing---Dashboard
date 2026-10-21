"""Universe selection, valuation metrics and the composite value score."""

import polars as pl

from ridash.config import MAJOR_EXCHANGES

# (metric, higher is better) — each contributes a 0-100 percentile to the value score.
SCORED_METRICS = {
    "ev_ebit": False,
    "fcf_yield": True,
    "roce": True,
    "net_debt_ebitda": False,
}

_SIC_DIVISIONS = [
    (100, 999, "Agriculture"),
    (1000, 1499, "Mining"),
    (1500, 1799, "Construction"),
    (2000, 3999, "Manufacturing"),
    (4000, 4999, "Transportation & Utilities"),
    (5000, 5199, "Wholesale Trade"),
    (5200, 5999, "Retail Trade"),
    (6000, 6799, "Finance & Real Estate"),
    (7000, 8999, "Services"),
    (9100, 9999, "Public Administration"),
]


def candidates(quotes: pl.DataFrame, tickers: pl.DataFrame, min_market_cap: float) -> pl.DataFrame:
    """Listed US common stocks above the size threshold, one line per company."""
    return (
        quotes.filter(
            (pl.col("date") == pl.col("date").max())
            & (pl.col("type") == "Common Stock")
            & (pl.col("currency") == "USD")
            & pl.col("exchange").is_in(MAJOR_EXCHANGES)
            & (pl.col("market_cap") >= min_market_cap)
        )
        .join(tickers, on="ticker")
        .sort("avg_volume", descending=True, nulls_last=True)
        .unique("cik", keep="first", maintain_order=True)
    )


def classify(df: pl.DataFrame, companies: pl.DataFrame) -> pl.DataFrame:
    """Attach the SIC sector and drop financials and real estate, whose EBIT-based
    ratios are not meaningful."""
    division = pl.lit(None, pl.Utf8)
    for low, high, name in reversed(_SIC_DIVISIONS):
        division = (
            pl.when(pl.col("sic").is_between(low, high)).then(pl.lit(name)).otherwise(division)
        )
    return (
        df.join(companies, on="cik", how="left")
        .with_columns(sector=division)
        .filter(pl.col("sector").ne_missing("Finance & Real Estate"))
    )


def metrics(df: pl.DataFrame) -> pl.DataFrame:
    net_debt = pl.col("debt") - pl.col("cash")
    ev = pl.col("market_cap") + net_debt + pl.col("minority_interest").fill_null(0)
    capital_employed = pl.col("equity") + net_debt
    ebitda = pl.col("ebit") + pl.col("depreciation")
    # Stock-based compensation is a real cost that operating cash flow adds back. Companies
    # that do not report it (mostly utilities and partnerships) count it as zero.
    fcf = (
        pl.col("operating_cash_flow") - pl.col("capex") - pl.col("stock_compensation").fill_null(0)
    )
    return df.with_columns(ev=ev).with_columns(
        ev_ebit=pl.when((pl.col("ebit") > 0) & (pl.col("ev") > 0)).then(
            pl.col("ev") / pl.col("ebit")
        ),
        fcf_yield=fcf / pl.col("market_cap"),
        roce=pl.when(capital_employed > 0).then(pl.col("ebit") / capital_employed),
        net_debt_ebitda=pl.when(ebitda > 0).then(net_debt / ebitda),
    )


def score(df: pl.DataFrame) -> pl.DataFrame:
    """Percentile of each metric, averaged into a 0-100 value score (higher = cheaper and
    sounder). Only companies with a meaningful EV/EBIT are scored and compared."""
    percentiles = {
        f"pct_{name}": _percentile(name, higher_is_better)
        for name, higher_is_better in SCORED_METRICS.items()
    }
    value_score = pl.when(pl.col("ev_ebit").is_not_null()).then(pl.mean_horizontal(*percentiles))
    return (
        df.with_columns(**percentiles)
        .with_columns(value_score=value_score)
        .with_columns(rank=pl.col("value_score").rank("ordinal", descending=True).cast(pl.Int32))
        .sort("rank", nulls_last=True)
    )


def _percentile(column: str, higher_is_better: bool) -> pl.Expr:
    values = pl.col(column) if higher_is_better else -pl.col(column)
    values = pl.when(pl.col("ev_ebit").is_not_null()).then(values)
    return values.rank("average") / values.count() * 100
