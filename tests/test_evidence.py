from datetime import date, timedelta

import polars as pl
import pytest

from ridash import evidence
from ridash.sources.sec import parse_filings

AS_OF = date(2026, 10, 19)


def test_market_signals_measure_returns_and_drawdown():
    days = [AS_OF - timedelta(days=300 - i) for i in range(300)]
    closes = [100.0 + i for i in range(299)] + [450.0]  # steady rise to a new high
    prices = pl.DataFrame({"ticker": "X", "date": days, "adj_close": closes})
    row = evidence.market_signals(prices).row(0, named=True)
    assert row["ret_1m"] == pytest.approx(450 / closes[-22] - 1)
    assert row["ret_12m"] == pytest.approx(450 / closes[-253] - 1)
    assert row["drawdown"] == pytest.approx(0)


def test_market_signals_leave_long_returns_empty_for_short_histories():
    prices = pl.DataFrame(
        {"ticker": "NEW", "date": [AS_OF - timedelta(days=i) for i in range(30)], "adj_close": 10.0}
    )
    row = evidence.market_signals(prices).row(0, named=True)
    assert row["ret_1m"] == pytest.approx(0) and row["ret_12m"] is None


def test_sentiment_is_weighted_by_article_count_and_empty_without_articles():
    sentiment = pl.DataFrame(
        {
            "ticker": ["A", "A", "A"],
            "date": [AS_OF - timedelta(days=d) for d in (1, 2, 50)],
            "count": [3, 1, 2],
            "sentiment": [0.8, 0.0, -0.5],
        }
    )
    row = evidence.sentiment_signals(sentiment, AS_OF).row(0, named=True)
    assert row["sentiment_30d"] == pytest.approx(0.6) and row["news_30d"] == 4
    assert row["sentiment_prev"] == pytest.approx(-0.5)
    old_only = sentiment.filter(pl.col("date") < AS_OF - timedelta(days=30))
    assert evidence.sentiment_signals(old_only, AS_OF).row(0, named=True)["sentiment_30d"] is None


def test_short_interest_is_measured_against_shares_outstanding():
    short = pl.DataFrame(
        {
            "ticker": ["X"],
            "short_date": [date(2026, 9, 30)],
            "short_shares": [5e6],
            "short_shares_prev": [4e6],
            "days_to_cover": [5.0],
        }
    )
    stocks = pl.DataFrame({"ticker": ["X"], "market_cap": [2e9], "close": [40.0]})  # 50m shares
    row = evidence.short_signals(short, stocks).row(0, named=True)
    assert row["short_pct"] == pytest.approx(0.10)
    assert row["short_change"] == pytest.approx(0.25)


RECENT = {
    "form": ["8-K", "10-Q", "8-K", "NT 10-K", "8-K", "8-K"],
    "filingDate": [
        "2026-09-01",
        "2026-08-01",
        "2026-05-01",
        "2026-03-31",
        "2025-01-01",
        "2026-08-05",
    ],
    "items": ["7.01", "", "4.02", "", "5.02", "2.02,9.01"],
    "accessionNumber": ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6"],
    "primaryDocument": ["d1.htm", "d2.htm", "d3.htm", "d4.htm", "d5.htm", "d6.htm"],
}


def test_material_events_keep_recent_8k_and_late_filings_with_red_flags():
    events = evidence.material_events(parse_filings(RECENT, 42), AS_OF)
    assert [(e["accn"], e["red_flag"]) for e in events] == [
        ("a-3", True),
        ("a-4", True),
        ("a-6", False),
    ]
    assert events[2]["url"] == "https://www.sec.gov/Archives/edgar/data/42/a6/d6.htm"


def test_latest_results_filing_is_the_recent_item_2_02():
    assert evidence.latest_results_filing(parse_filings(RECENT, 42), AS_OF)["accn"] == "a-6"
    assert evidence.latest_results_filing(parse_filings(RECENT, 42), date(2027, 6, 1)) is None


def test_release_excerpt_adds_a_late_outlook_section():
    text = "A" * evidence.RELEASE_CHARS + "B" * 500 + "2027 Outlook: revenue down" + "C" * 5000
    excerpt = evidence.release_excerpt(text)
    assert excerpt.startswith("A" * 100)
    assert "2027 Outlook: revenue down" in excerpt
    assert len(excerpt) < len(text)


def test_quarter_periods_are_the_last_complete_calendar_quarters():
    assert evidence.quarter_periods(date(2026, 10, 19), count=5) == [
        "CY2026Q3",
        "CY2026Q2",
        "CY2026Q1",
        "CY2025Q4",
        "CY2025Q3",
    ]


def frame_rows(*rows):
    return pl.DataFrame(
        [
            {"cik": 1, "tag": tag, "end": end, "value": value, "accn": "a"}
            for tag, end, value in rows
        ],
        schema={
            "cik": pl.Int64,
            "tag": pl.Utf8,
            "end": pl.Date,
            "value": pl.Float64,
            "accn": pl.Utf8,
        },
    )


def test_quarterly_results_compare_each_quarter_with_the_year_before():
    q, q_prior = date(2026, 6, 27), date(2025, 6, 28)  # 52-week fiscal quarters
    facts = frame_rows(
        ("Revenues", q, 120.0),
        ("RevenueFromContractWithCustomerExcludingAssessedTax", q, 110.0),
        ("RevenueFromContractWithCustomerExcludingAssessedTax", q_prior, 100.0),
        ("OperatingIncomeLoss", q, 15.0),
        ("OperatingIncomeLoss", q_prior, 20.0),
    )
    latest = evidence.quarterly_results(facts).row(0, named=True)
    assert latest["end"] == q and latest["revenue"] == 110.0
    assert latest["revenue_yoy"] == pytest.approx(0.10)
    assert latest["operating_income_yoy"] == pytest.approx(-0.25)


def transaction(code, value, planned=False, insider="A"):
    return {
        "date": "2026-09-01",
        "insider": insider,
        "title": "CEO",
        "code": code,
        "shares": 100.0,
        "value": value,
        "planned": planned,
    }


def test_insider_summary_separates_purchases_from_sales_and_planned_sales():
    summary = evidence.insider_summary(
        [
            transaction("P", 50.0, insider="A"),
            transaction("P", 30.0, insider="B"),
            transaction("S", 200.0, planned=True),
            transaction("S", 100.0),
        ]
    )
    assert (summary["buy_count"], summary["buyers"], summary["buy_value"]) == (2, 2, 80.0)
    assert (summary["sell_value"], summary["planned_sell_value"]) == (300.0, 200.0)
    assert [t["value"] for t in summary["largest"]] == [50.0, 30.0, 200.0, 100.0]


def article(day: str, title: str, symbols: int = 1, link: str | None = None) -> dict:
    return {
        "date": f"{day}T10:00:00+00:00",
        "title": title,
        "content": "text",
        "symbols": [f"S{i}.US" for i in range(symbols)],
        "link": link or title,
    }


def test_relevant_news_prefers_company_in_title_and_drops_future_articles():
    articles = [
        article("2026-10-18", "Top 10 stocks to watch", symbols=10),
        article("2026-10-10", "Harmony Biosciences cuts guidance"),
        article("2026-10-15", "Pharma sector update", symbols=2),
        article("2026-10-20", "Harmony after the review date"),
    ]
    ranked = evidence.relevant_news(articles, "HRMY", "Harmony Biosciences Holdings, Inc.", AS_OF)
    assert [a["title"] for a in ranked] == [
        "Harmony Biosciences cuts guidance",
        "Pharma sector update",
        "Top 10 stocks to watch",
    ]


STOCK = {
    "ticker": "HRMY",
    "name": "Harmony",
    "industry": "Pharma",
    "sector": "Manufacturing",
    "cik": 42,
    "date": AS_OF,
    "fiscal_end": date(2025, 12, 31),
    "value_score": 96.0,
    "rank": 1,
    "ev_ebit": 8.4,
    "fcf_yield": 0.148,
    "roce": 0.74,
    "net_debt_ebitda": None,
    "market_cap": 2.4e9,
    "ebit": 2.085e8,
    "ebit_source": "operating income",
}
EVENT = {
    "filed": date(2026, 9, 1),
    "form": "8-K",
    "description": "Change of auditor",
    "red_flag": True,
    "accn": "a-1",
    "url": "u",
}
QUARTER = {
    "end": date(2026, 6, 30),
    "revenue": 2.45e8,
    "operating_income": 5.8e7,
    "revenue_yoy": 0.12,
    "operating_income_yoy": -0.081,
}
RELEASE = {"filed": date(2026, 8, 4), "accn": "r-1", "url": "https://sec/ex99", "text": "Q2 up"}
SIGNALS = {
    "ret_12m": -0.25,
    "spy_12m": 0.08,
    "short_date": date(2026, 9, 30),
    "short_pct": 0.098,
    "short_change": 0.195,
    "days_to_cover": 5.0,
}


def brief(news, **overrides):
    parts = {
        "signals": SIGNALS,
        "events": [EVENT],
        "quarters": [QUARTER],
        "release": RELEASE,
        "insiders": evidence.insider_summary([transaction("S", 2.5e5, planned=True)]),
    }
    parts.update(overrides)
    return evidence.build_evidence(
        STOCK,
        parts["signals"],
        news,
        parts["events"],
        parts["quarters"],
        parts["release"],
        parts["insiders"],
    )


def test_brief_cites_every_source_and_reports_new_evidence():
    news = [article("2026-10-10", "Harmony cuts guidance", link="l1")]
    text = brief(news).text
    assert "quarter ended 2026-06-30: revenue $245.0m (+12.0% y/y)" in text
    assert "operating income $58.0m (-8.1% y/y)" in text
    assert "(8-K item 2.02 filed 2026-08-04) [E1]:\nQ2 up" in text
    assert "Sales: 1, $0.2m in total, of which $0.2m under pre-arranged 10b5-1 plans" in text
    assert "9.8% of shares outstanding (+19.5% since the previous report)" in text
    assert "[F1] 2026-09-01 8-K: Change of auditor [RED FLAG]" in text
    assert "net debt/EBITDA n/a" in text
    assert [s["id"] for s in brief(news).sources] == ["Q1", "E1", "I1", "S1", "F1", "N1"]


def test_fingerprint_changes_with_new_information_only():
    news = [article("2026-10-10", "Harmony cuts guidance", link="l1")]
    base = brief(news).fingerprint
    assert brief(news, signals={**SIGNALS, "ret_12m": -0.30}).fingerprint == base
    assert brief([*news, article("2026-10-11", "x", link="l2")]).fingerprint != base
    assert brief(news, release={**RELEASE, "accn": "r-2"}).fingerprint != base
    assert brief(news, signals={**SIGNALS, "short_date": date(2026, 10, 15)}).fingerprint != base
