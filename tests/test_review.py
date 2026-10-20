import asyncio
from datetime import date, timedelta

import polars as pl
import pytest
from claude_agent_sdk import ClaudeSDKError, ResultMessage

from ridash import review
from ridash.config import EXPLAINED_RISK, KEEP_COUNT, TRAP_WEIGHTS

AS_OF = date(2026, 10, 19)


def criteria(**scores):
    return {
        name: {"score": scores.get(name, 0), "rationale": "r", "sources": []}
        for name in TRAP_WEIGHTS
    }


def test_criteria_and_weights_cover_the_same_grid():
    assert set(review.CRITERIA) == set(TRAP_WEIGHTS)
    assert sum(TRAP_WEIGHTS.values()) == pytest.approx(1)


def test_trap_risk_is_the_weighted_share_of_the_maximum():
    assert review.trap_risk(criteria()) == 0
    assert review.trap_risk(criteria(**dict.fromkeys(TRAP_WEIGHTS, 5))) == 100
    assert review.trap_risk(criteria(earnings=5)) == pytest.approx(100 * TRAP_WEIGHTS["earnings"])


def test_lowest_risks_are_kept_but_never_an_explained_or_critical_discount():
    risks = [10.0 + i for i in range(KEEP_COUNT + 3)] + [EXPLAINED_RISK + 5, None]
    rows = pl.DataFrame(
        {
            "ticker": [f"T{i}" for i in range(len(risks))],
            "trap_risk": risks,
            "critical": [
                i == 0 for i in range(len(risks))
            ],  # lowest risk, but one critical criterion
        }
    )
    result = {r["ticker"]: r for r in review.suggest(rows).iter_rows(named=True)}
    kept = [t for t, r in result.items() if r["suggestion"] == "keep"]
    assert len(kept) == KEEP_COUNT and "T0" not in kept
    assert result[f"T{KEEP_COUNT + 3}"]["verdict"] == "explained"
    assert result[f"T{KEEP_COUNT + 3}"]["suggestion"] == "exclude"
    assert result[f"T{KEEP_COUNT + 4}"]["suggestion"] is None  # failed analysis: no suggestion


def test_verdict_is_reused_only_when_unchanged_and_recent():
    prior = {"trap_risk": 40.0, "fingerprint": "f", "analysed_on": AS_OF - timedelta(days=3)}
    assert review.reusable(prior, "f", AS_OF)
    assert not review.reusable(prior, "g", AS_OF)
    assert not review.reusable({**prior, "analysed_on": AS_OF - timedelta(days=30)}, "f", AS_OF)
    assert not review.reusable({**prior, "trap_risk": None}, "f", AS_OF)
    assert not review.reusable({"fingerprint": "f", "analysed_on": AS_OF}, "f", AS_OF)  # old format
    assert not review.reusable(None, "f", AS_OF)


ASSESSMENT = {
    "bear_case": "b",
    "criteria": criteria(earnings=3),
    "red_flags": [],
    "news_tone": "mixed",
    "confidence": "medium",
    "summary": "s",
}


def result(subtype="success", structured_output=ASSESSMENT, cost=0.05):
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


def test_ask_claude_returns_assessment_and_cost(monkeypatch):
    calls = []
    monkeypatch.setattr(review, "query", fake_query(object(), result(), calls=calls))
    assessment, usd = asyncio.run(review.ask_claude("brief"))
    assert assessment == ASSESSMENT and usd == 0.05

    prompt, options = calls[0]
    assert prompt == "brief"
    assert options.output_format == {"type": "json_schema", "schema": review.VERDICT_SCHEMA}
    assert options.tools == [] and options.setting_sources == []
    assert options.system_prompt == {
        "type": "preset",
        "preset": "claude_code",
        "append": review.INSTRUCTIONS,
    }


def test_instructions_ask_for_the_bear_case_first_and_every_criterion():
    assert all(f"- {name}:" in review.INSTRUCTIONS for name in review.CRITERIA)
    assert list(review.VERDICT_SCHEMA["properties"])[0] == "bear_case"


def test_run_without_structured_output_is_an_error(monkeypatch):
    failed = result("error_max_structured_output_retries", structured_output=None)
    monkeypatch.setattr(review, "query", fake_query(failed))
    with pytest.raises(review.ReviewError):
        asyncio.run(review.ask_claude("brief"))


def test_one_failure_does_not_stop_the_other_analyses(monkeypatch):
    monkeypatch.setattr(review, "query", fake_query(result(), fail_on="bad"))
    answers = asyncio.run(review.ask_all(["good", "bad", "good"]))
    assert [assessment is not None for assessment, _, _ in answers] == [True, False, True]
    assert "not logged in" in answers[1][2]


def test_insider_cache_reads_each_form_once(monkeypatch, tmp_path):
    monkeypatch.setattr(review, "INSIDER_CACHE", tmp_path / "insiders.parquet")
    filings = pl.DataFrame(
        {
            "form": ["4", "4", "8-K"],
            "filed": [AS_OF - timedelta(days=5), AS_OF - timedelta(days=9), AS_OF],
            "accn": ["f-1", "f-2", "k-1"],
            "url": ["u1", "u2", "u3"],
        }
    )
    sale = {
        "date": "2026-10-10",
        "insider": "A",
        "title": "CEO",
        "code": "S",
        "shares": 10.0,
        "value": 100.0,
        "planned": False,
    }

    class FakeSec:
        def __init__(self):
            self.read = []

        def insider_transactions(self, url):
            self.read.append(url)
            return [sale] if url == "u1" else []

    sec = FakeSec()
    cache = review.load_insider_cache()
    assert review.insider_transactions(sec, filings, AS_OF, cache) == [sale]
    review.save_insider_cache(cache)

    again = FakeSec()
    assert review.insider_transactions(again, filings, AS_OF, review.load_insider_cache()) == [sale]
    assert sec.read == ["u1", "u2"] and again.read == []


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
