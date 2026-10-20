import asyncio
from datetime import date, timedelta

import polars as pl
import pytest
from claude_agent_sdk import ClaudeSDKError, ResultMessage

from ridash import review
from ridash.sources.sec import parse_filings

AS_OF = date(2026, 10, 19)


def test_market_signals_measure_returns_and_drawdown():
    days = [AS_OF - timedelta(days=300 - i) for i in range(300)]
    closes = [100.0 + i for i in range(299)] + [450.0]  # steady rise to a new high
    prices = pl.DataFrame({"ticker": "X", "date": days, "adj_close": closes})
    row = review.market_signals(prices).row(0, named=True)
    assert row["ret_1m"] == pytest.approx(450 / closes[-22] - 1)
    assert row["ret_12m"] == pytest.approx(450 / closes[-253] - 1)
    assert row["drawdown"] == pytest.approx(0)


def test_market_signals_leave_long_returns_empty_for_short_histories():
    prices = pl.DataFrame(
        {
            "ticker": "NEW",
            "date": [AS_OF - timedelta(days=i) for i in range(30)],
            "adj_close": [10.0] * 30,
        }
    )
    row = review.market_signals(prices).row(0, named=True)
    assert row["ret_1m"] == pytest.approx(0) and row["ret_12m"] is None


def test_sentiment_is_weighted_by_article_count_and_empty_without_articles():
    sentiment = pl.DataFrame(
        {
            "ticker": ["A", "A", "A"],
            "date": [
                AS_OF - timedelta(days=1),
                AS_OF - timedelta(days=2),
                AS_OF - timedelta(days=50),
            ],
            "count": [3, 1, 2],
            "sentiment": [0.8, 0.0, -0.5],
        }
    )
    row = review.sentiment_signals(sentiment, AS_OF).row(0, named=True)
    assert row["sentiment_30d"] == pytest.approx(0.6) and row["news_30d"] == 4
    assert row["sentiment_prev"] == pytest.approx(-0.5)
    old_only = sentiment.filter(pl.col("date") < AS_OF - timedelta(days=30))
    assert review.sentiment_signals(old_only, AS_OF).row(0, named=True)["sentiment_30d"] is None


def test_material_events_keep_recent_8k_and_late_filings_with_red_flags():
    recent = {
        "form": ["8-K", "10-Q", "8-K", "NT 10-K", "8-K"],
        "filingDate": ["2026-09-01", "2026-08-01", "2026-05-01", "2026-03-31", "2025-01-01"],
        "items": ["2.02,9.01", "", "4.02", "", "5.02"],
        "accessionNumber": ["a-1", "a-2", "a-3", "a-4", "a-5"],
        "primaryDocument": ["d1.htm", "d2.htm", "d3.htm", "d4.htm", "d5.htm"],
    }
    events = review.material_events(parse_filings(recent, 42), AS_OF)
    assert [(e["accn"], e["red_flag"]) for e in events] == [
        ("a-1", False),
        ("a-3", True),
        ("a-4", True),
    ]
    assert events[0]["description"] == "Results of operations"
    assert events[0]["url"] == "https://www.sec.gov/Archives/edgar/data/42/a1/d1.htm"


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
    ranked = review.relevant_news(articles, "HRMY", "Harmony Biosciences Holdings, Inc.", AS_OF)
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


def test_evidence_cites_sources_and_fingerprint_tracks_new_information():
    news = [article("2026-10-10", "Harmony cuts guidance", link="l1")]
    evidence = review.build_evidence(STOCK, news, [EVENT], {"ret_12m": -0.25, "spy_12m": 0.08})
    assert "[F1] 2026-09-01 8-K: Change of auditor [RED FLAG]" in evidence.text
    assert '[N1] 2026-10-10 "Harmony cuts guidance"' in evidence.text
    assert "net debt/EBITDA n/a" in evidence.text
    assert [s["id"] for s in evidence.sources] == ["F1", "N1"]

    same = review.build_evidence(STOCK, news, [EVENT], {"ret_12m": -0.30})
    more = review.build_evidence(STOCK, [*news, article("2026-10-11", "x", link="l2")], [EVENT], {})
    assert same.fingerprint == evidence.fingerprint != more.fingerprint


def test_verdict_is_reused_only_when_unchanged_and_recent():
    prior = {"verdict": "explained", "fingerprint": "f", "analysed_on": AS_OF - timedelta(days=3)}
    assert review.reusable(prior, "f", AS_OF)
    assert not review.reusable(prior, "g", AS_OF)
    assert not review.reusable({**prior, "analysed_on": AS_OF - timedelta(days=30)}, "f", AS_OF)
    assert not review.reusable({**prior, "verdict": None}, "f", AS_OF)
    assert not review.reusable(None, "f", AS_OF)


VERDICT = {
    "verdict": "explained",
    "confidence": "high",
    "news_tone": "negative",
    "suggestion": "exclude",
    "summary": "s",
    "factors": [],
    "red_flags": [],
}


def result(subtype="success", structured_output=VERDICT, cost=0.05):
    return ResultMessage(
        subtype=subtype,
        duration_ms=1,
        duration_api_ms=1,
        is_error=subtype != "success",
        num_turns=1,
        session_id="s",
        structured_output=structured_output,
        total_cost_usd=cost,
    )


def fake_query(*messages, calls=None, fail_on=None):
    async def query(prompt, options):
        if calls is not None:
            calls.append((prompt, options))
        if prompt == fail_on:
            raise ClaudeSDKError("Claude Code is not logged in")
        for message in messages:
            yield message

    return query


def test_ask_claude_returns_verdict_and_cost(monkeypatch):
    calls = []
    monkeypatch.setattr(review, "query", fake_query(object(), result(), calls=calls))
    verdict, usd = asyncio.run(review.ask_claude("evidence"))
    assert verdict == VERDICT and usd == 0.05

    prompt, options = calls[0]
    assert prompt == "evidence"
    assert options.output_format == {"type": "json_schema", "schema": review.VERDICT_SCHEMA}
    assert options.tools == [] and options.setting_sources == []
    assert options.system_prompt == {
        "type": "preset",
        "preset": "claude_code",
        "append": review.INSTRUCTIONS,
    }


def test_run_without_structured_output_is_an_error(monkeypatch):
    failed = result("error_max_structured_output_retries", structured_output=None)
    monkeypatch.setattr(review, "query", fake_query(failed))
    with pytest.raises(review.ReviewError):
        asyncio.run(review.ask_claude("evidence"))


def test_one_failure_does_not_stop_the_other_analyses(monkeypatch):
    monkeypatch.setattr(review, "query", fake_query(result(), fail_on="bad"))
    answers = asyncio.run(review.ask_all(["good", "bad", "good"]))
    assert [verdict is not None for verdict, _, _ in answers] == [True, False, True]
    assert "not logged in" in answers[1][2]


def test_user_decision_overrides_suggestion_and_latest_wins():
    reviewed = pl.DataFrame({"ticker": ["A", "B"], "suggestion": ["keep", "exclude"]})
    decisions = pl.DataFrame(
        {
            "ticker": ["A", "A"],
            "decision": ["keep", "exclude"],
            "decided_at": [date(2026, 10, 1), date(2026, 10, 2)],
        }
    )
    result = review.with_decisions(reviewed, decisions).sort("ticker")
    assert result["decision"].to_list() == ["exclude", "exclude"]
    assert review.with_decisions(reviewed, None)["decision"].to_list() == ["keep", "exclude"]
