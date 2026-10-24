from datetime import date

import polars as pl
import pytest

from ridash.value import candidates, classify, metrics, score

DAY = date(2026, 9, 23)


def quote(ticker, market_cap=5e9, type_="Common Stock", exchange="NYSE", volume=1e6, day=DAY):
    return {
        "ticker": ticker,
        "date": day,
        "type": type_,
        "close": 10.0,
        "market_cap": market_cap,
        "avg_volume": volume,
        "exchange": exchange,
        "currency": "USD",
    }


def test_candidates_keep_listed_common_stocks_above_threshold_once_per_company():
    quotes = pl.DataFrame(
        [
            quote("KEEP"),
            quote("SMALL", market_cap=1e8),
            quote("FUND", type_="ETF"),
            quote("OTC", exchange="PINK"),
            quote("STALE", day=date(2026, 9, 1)),
            quote("GOOG", volume=1e6),
            quote("GOOGL", volume=2e6),
        ]
    )
    tickers = pl.DataFrame(
        {
            "cik": [1, 2, 3, 4, 5, 6, 6],
            "ticker": ["KEEP", "SMALL", "FUND", "OTC", "STALE", "GOOG", "GOOGL"],
            "name": ["k", "s", "f", "o", "st", "g", "g"],
        }
    )
    result = candidates(quotes, tickers, min_market_cap=2e9)
    assert sorted(result["ticker"]) == ["GOOGL", "KEEP"]


def test_classify_drops_financials_and_keeps_unclassified():
    df = pl.DataFrame({"cik": [1, 2, 3]})
    companies = pl.DataFrame(
        {"cik": [1, 2, 3], "sic": [3571, 6022, None], "industry": ["Computers", "Banks", None]},
        schema={"cik": pl.Int64, "sic": pl.Int64, "industry": pl.Utf8},
    )
    result = classify(df, companies)
    assert result["cik"].to_list() == [1, 3]
    assert result["sector"].to_list() == ["Information Technology", None]


@pytest.mark.parametrize(
    ("sic", "sector"),
    [
        (2834, "Health Care"),  # specific range inside chemicals
        (2870, "Materials"),
        (1311, "Energy"),  # specific range inside mining
        (1040, "Materials"),
        (3021, "Consumer Discretionary"),  # footwear inside rubber and plastics
        (5331, "Consumer Staples"),  # discount stores inside retail
        (5961, "Consumer Discretionary"),
        (7372, "Information Technology"),  # software inside business services
        (7389, "Industrials"),
        (4911, "Utilities"),
    ],
)
def test_specific_sic_ranges_take_precedence(sic, sector):
    companies = pl.DataFrame({"cik": [1], "sic": [sic], "industry": ["x"]})
    assert classify(pl.DataFrame({"cik": [1]}), companies)["sector"].item() == sector


def company(**overrides):
    base = {
        "sector": "Industrials",
        "market_cap": 1000.0,
        "debt": 300.0,
        "cash": 100.0,
        "minority_interest": None,
        "ebit": 120.0,
        "revenue": 1000.0,
        "normal_margin": 0.10,
        "depreciation": 30.0,
        "operating_cash_flow": 150.0,
        "capex": 50.0,
        "stock_compensation": 20.0,
        "equity": 600.0,
    }
    return {**base, **overrides}


def test_metrics_formulas():
    result = metrics(pl.DataFrame([company(minority_interest=40.0)])).row(0, named=True)
    assert result["ev"] == pytest.approx(1240.0)  # 1000 + 300 - 100 + 40
    assert result["ev_ebit"] == pytest.approx(1240.0 / 120.0)
    assert result["ev_normal_ebit"] == pytest.approx(1240.0 / 100.0)  # revenue × normal margin
    assert result["fcf_yield"] == pytest.approx(0.08)  # (150 - 50 - 20) / 1000
    assert result["roce"] == pytest.approx(120.0 / 800.0)  # EBIT / (equity + net debt)
    assert result["net_debt_ebitda"] == pytest.approx(200.0 / 150.0)


def test_unreported_stock_compensation_counts_as_zero_but_missing_capex_does_not():
    result = metrics(pl.DataFrame([company(stock_compensation=None), company(capex=None)]))
    assert result["fcf_yield"].to_list() == [pytest.approx(0.10), None]


def test_negative_ebit_has_no_ev_ebit_and_missing_debt_propagates():
    result = metrics(pl.DataFrame([company(ebit=-10.0), company(debt=None)]))
    assert result["ev_ebit"].to_list() == [None, None]


def test_cheaper_company_ranks_first_and_unvaluable_company_is_not_scored():
    df = metrics(
        pl.DataFrame(
            [
                {"ticker": "CHEAP", **company(market_cap=500.0)},
                {"ticker": "DEAR", **company(market_cap=5000.0)},
                {"ticker": "LOSS", **company(ebit=-10.0)},
            ]
        )
    )
    result = score(df)
    assert result["ticker"].to_list() == ["CHEAP", "DEAR", "LOSS"]
    assert result["rank"].to_list() == [1, 2, None]


def test_quality_gate_removes_weak_companies_from_the_ranking_but_not_from_the_scores():
    df = metrics(
        pl.DataFrame(
            [
                {"ticker": "SOUND", **company()},
                {"ticker": "LOW_RETURN", **company(market_cap=400.0, equity=2000.0)},
                {"ticker": "INDEBTED", **company(market_cap=400.0, debt=1000.0)},
                {"ticker": "NO_EQUITY", **company(market_cap=800.0, equity=-600.0)},
            ]
        )
    )
    result = {r["ticker"]: r for r in score(df).iter_rows(named=True)}
    assert result["LOW_RETURN"]["roce"] < 0.10 and result["LOW_RETURN"]["rank"] is None
    assert result["INDEBTED"]["net_debt_ebitda"] > 3 and result["INDEBTED"]["rank"] is None
    assert result["INDEBTED"]["value_score"] is not None
    # A ratio that cannot be computed does not fail the gate, but is flagged.
    assert result["NO_EQUITY"]["roce"] is None and result["NO_EQUITY"]["quality_unchecked"]
    assert (result["NO_EQUITY"]["rank"], result["SOUND"]["rank"]) == (1, 2)


def test_return_on_capital_does_not_raise_the_value_score():
    df = metrics(pl.DataFrame([company(), company(equity=100.0)]))
    first, second = score(df)["value_score"].to_list()
    assert first == second


def test_company_missing_a_price_metric_is_not_scored_on_the_other_alone():
    df = metrics(pl.DataFrame([company(), company(market_cap=500.0, capex=None)]))
    result = score(df)
    assert result["value_score"].null_count() == 1
    assert result.filter(pl.col("fcf_yield").is_null())["rank"].item() is None


def test_normal_earnings_without_enough_history_or_with_a_normal_loss_give_no_multiple():
    result = metrics(pl.DataFrame([company(normal_margin=None), company(normal_margin=-0.02)]))
    assert result["ev_normal_ebit"].to_list() == [None, None]


def test_companies_are_compared_within_their_sector():
    """A software company at 15 times EBIT is cheap among software companies at 30, even though
    a retailer at 10 is cheaper in absolute terms: the retailer is the dearest of retailers."""
    rows = [
        {"ticker": f"{sector[:4]}{multiple}", **company(sector=sector, market_cap=cap)}
        for sector, caps in {
            "Information Technology": (1600.0, 3400.0, 3400.0),  # EV/EBIT 15, 30, 30
            "Consumer Discretionary": (1000.0, 600.0, 600.0),  # EV/EBIT 10, 6.7, 6.7
        }.items()
        for multiple, cap in enumerate(caps)
    ]
    result = {r["ticker"]: r for r in score(metrics(pl.DataFrame(rows))).iter_rows(named=True)}
    assert result["Info0"]["pct_ev_ebit"] == 100.0
    assert result["Cons0"]["pct_ev_ebit"] == pytest.approx(100 / 3)
    assert result["Info0"]["value_score"] > result["Cons0"]["value_score"]


def test_peak_margin_ranks_below_the_same_multiple_on_normal_earnings():
    df = metrics(
        pl.DataFrame(
            [
                {"ticker": "STEADY", **company()},
                {"ticker": "PEAK", **company(revenue=600.0, normal_margin=0.05)},  # EBIT 120 vs 30
            ]
        )
    )
    assert score(df)["ticker"].to_list() == ["STEADY", "PEAK"]


def test_company_without_sector_or_normal_earnings_is_not_scored():
    df = metrics(
        pl.DataFrame(
            [
                {"ticker": "SCORED", **company()},
                {"ticker": "NO_SECTOR", **company(sector=None)},
                {"ticker": "YOUNG", **company(normal_margin=None)},
            ]
        )
    )
    result = score(df)
    assert result.filter(pl.col("value_score").is_not_null())["ticker"].to_list() == ["SCORED"]
