"""Universe selection, valuation metrics and the value score, relative to the sector."""

import polars as pl

from ridash.config import MAJOR_EXCHANGES, MAX_NET_DEBT_EBITDA, MIN_ROCE

# (price metric, higher is better) — each contributes a 0-100 percentile within the sector to
# the value score: the price against the last twelve months' earnings, against normal
# earnings, and against free cash flow. Return on capital and leverage are not scored: they are
# a gate (see `quality`), so that a high return on capital cannot make up for a higher price.
SCORED_METRICS = {
    "ev_ebit": False,
    "ev_normal_ebit": False,
    "fcf_yield": True,
}

FINANCIALS = "Financials & Real Estate"
_HEALTH = "Health Care"
_TECH = "Information Technology"
_MEDIA = "Communication Services"
_ENERGY = "Energy"
_STAPLES = "Consumer Staples"
_DISCRETIONARY = "Consumer Discretionary"
_MATERIALS = "Materials"
_INDUSTRIALS = "Industrials"

# Sectors close to the GICS ones, from SIC code ranges: the first range containing the code
# wins, so the specific ranges come before the broad ones. SIC codes describe products, not
# business models: a few companies land in an unexpected sector (PayPal in Industrials).
_SECTORS = [
    (6000, 6799, FINANCIALS),
    (2830, 2836, _HEALTH),  # drugs and biologicals
    (3841, 3851, _HEALTH),  # medical instruments and supplies
    (5047, 5047, _HEALTH),
    (5122, 5122, _HEALTH),
    (8000, 8099, _HEALTH),
    (8731, 8731, _HEALTH),  # biological research
    (3570, 3579, _TECH),  # computers and peripherals
    (3660, 3679, _TECH),  # communications equipment, semiconductors, components
    (3820, 3829, _TECH),  # measuring instruments
    (5045, 5045, _TECH),
    (7370, 7379, _TECH),  # software and IT services
    (2710, 2799, _MEDIA),  # publishing
    (4800, 4899, _MEDIA),  # telecoms and broadcasting
    (7310, 7319, _MEDIA),  # advertising
    (7810, 7849, _MEDIA),  # films
    (1200, 1399, _ENERGY),  # coal, oil and gas
    (2900, 2999, _ENERGY),  # refining
    (3533, 3533, _ENERGY),  # oilfield equipment
    (4610, 4619, _ENERGY),  # pipelines
    (4922, 4922, _ENERGY),
    (5171, 5172, _ENERGY),
    (4900, 4999, "Utilities"),
    (100, 999, _STAPLES),  # agriculture
    (2000, 2199, _STAPLES),  # food, beverages, tobacco
    (2840, 2844, _STAPLES),  # household and personal products
    (5140, 5149, _STAPLES),
    (5180, 5182, _STAPLES),
    (5331, 5331, _STAPLES),  # discount stores
    (5399, 5399, _STAPLES),
    (5400, 5499, _STAPLES),  # food stores
    (5912, 5912, _STAPLES),  # drug stores
    (1520, 1531, _DISCRETIONARY),  # homebuilders
    (2200, 2399, _DISCRETIONARY),  # textiles and apparel
    (2500, 2599, _DISCRETIONARY),  # furniture
    (3011, 3011, _DISCRETIONARY),  # tyres
    (3021, 3021, _DISCRETIONARY),  # footwear
    (3100, 3199, _DISCRETIONARY),  # leather goods
    (3630, 3639, _DISCRETIONARY),  # household appliances
    (3651, 3652, _DISCRETIONARY),
    (3710, 3716, _DISCRETIONARY),  # cars and parts
    (3751, 3751, _DISCRETIONARY),
    (3790, 3799, _DISCRETIONARY),
    (3910, 3915, _DISCRETIONARY),  # jewellery
    (3940, 3949, _DISCRETIONARY),  # toys and sporting goods
    (5200, 5999, _DISCRETIONARY),  # retail and restaurants
    (7000, 7099, _DISCRETIONARY),  # hotels
    (7200, 7299, _DISCRETIONARY),  # personal services
    (7500, 7599, _DISCRETIONARY),
    (7900, 7999, _DISCRETIONARY),  # leisure
    (8200, 8299, _DISCRETIONARY),  # education
    (1000, 1499, _MATERIALS),  # mining
    (2400, 2499, _MATERIALS),
    (2600, 2699, _MATERIALS),  # paper
    (2800, 2899, _MATERIALS),  # chemicals
    (3000, 3099, _MATERIALS),
    (3200, 3399, _MATERIALS),  # glass, cement, metals
    (3410, 3412, _MATERIALS),  # metal cans
    (1500, 1799, _INDUSTRIALS),  # construction
    (3400, 3999, _INDUSTRIALS),  # machinery, electrical and transport equipment
    (4000, 4799, _INDUSTRIALS),  # transportation
    (5000, 5199, _INDUSTRIALS),  # wholesale
    (7300, 7899, _INDUSTRIALS),  # business services
    (8100, 8999, _INDUSTRIALS),  # engineering and professional services
    (9100, 9999, _INDUSTRIALS),
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
    """Attach the sector and drop financials and real estate, whose EBIT-based ratios are
    not meaningful."""
    sector = pl.lit(None, pl.Utf8)
    for low, high, name in reversed(_SECTORS):
        sector = pl.when(pl.col("sic").is_between(low, high)).then(pl.lit(name)).otherwise(sector)
    return (
        df.join(companies, on="cik", how="left")
        .with_columns(sector=sector)
        .filter(pl.col("sector").ne_missing(FINANCIALS))
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
    normal_ebit = pl.col("revenue") * pl.col("normal_margin")
    return df.with_columns(ev=ev, normal_ebit=normal_ebit).with_columns(
        ev_ebit=_multiple("ebit"),
        ev_normal_ebit=_multiple("normal_ebit"),
        fcf_yield=fcf / pl.col("market_cap"),
        roce=pl.when(capital_employed > 0).then(pl.col("ebit") / capital_employed),
        net_debt_ebitda=pl.when(ebitda > 0).then(net_debt / ebitda),
    )


def _multiple(earnings: str) -> pl.Expr:
    """EV / earnings, only when both are positive: a loss has no meaningful multiple."""
    positive = (pl.col(earnings) > 0) & (pl.col("ev") > 0)
    return pl.when(positive).then(pl.col("ev") / pl.col(earnings))


def quality(df: pl.DataFrame) -> pl.DataFrame:
    """Quality gate: return on capital employed above MIN_ROCE and net debt below
    MAX_NET_DEBT_EBITDA times EBITDA. A ratio that cannot be computed (negative capital
    employed, no depreciation reported) does not fail the gate, but the company is flagged."""
    roce, leverage = pl.col("roce"), pl.col("net_debt_ebitda")
    return df.with_columns(
        quality_pass=(roce.is_null() | (roce > MIN_ROCE))
        & (leverage.is_null() | (leverage < MAX_NET_DEBT_EBITDA)),
        quality_unchecked=roce.is_null() | leverage.is_null(),
    )


def score(df: pl.DataFrame) -> pl.DataFrame:
    """Percentiles of the price metrics within the sector, averaged into a 0-100 value score
    (higher = cheaper): a company is compared with businesses priced on similar economics,
    not with whole industries that the market always values lower. A company gets a score
    only when it has a sector and every price metric can be computed, rather than being judged
    on part of them; only those passing the quality gate are ranked."""
    complete = pl.col("sector").is_not_null() & pl.all_horizontal(
        pl.col(name).is_not_null() for name in SCORED_METRICS
    )
    percentiles = {
        f"pct_{name}": _percentile(name, higher_is_better, complete)
        for name, higher_is_better in SCORED_METRICS.items()
    }
    value_score = pl.when(complete).then(pl.mean_horizontal(*percentiles))
    ranked = pl.when(pl.col("quality_pass")).then(pl.col("value_score"))
    return (
        quality(df)
        .with_columns(**percentiles)
        .with_columns(value_score=value_score)
        .with_columns(rank=ranked.rank("ordinal", descending=True).cast(pl.Int32))
        .sort("rank", "value_score", descending=[False, True], nulls_last=True)
    )


def _percentile(column: str, higher_is_better: bool, among: pl.Expr) -> pl.Expr:
    """Share of the sector's scored companies that are dearer or as dear, from 0 to 100."""
    values = pl.when(among).then(pl.col(column) if higher_is_better else -pl.col(column))
    return (values.rank("average") / values.count() * 100).over("sector")
