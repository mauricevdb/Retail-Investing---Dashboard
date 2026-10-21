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
    assert result["sector"].to_list() == ["Manufacturing", None]


def company(**overrides):
    base = {
        "market_cap": 1000.0,
        "debt": 300.0,
        "cash": 100.0,
        "minority_interest": None,
        "ebit": 120.0,
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
