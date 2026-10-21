"""Qualitative review of the value shortlist: how likely is each cheap stock to be a value trap?

A low multiple is an opportunity only if the market is not pricing in a problem that the
historical figures cannot show. For each of the best-ranked stocks, `ridash.evidence` gathers
ten years of annual results, recent quarters, the latest earnings release, insider
transactions, short interest, material SEC filings, news and price behaviour. Claude first
makes the bear case, then scores eight criteria from 0 to 5; their weighted sum is the trap
risk (0-100). The lowest risks of the
shortlist are suggested for the portfolio; the decision stays with the user.

Claude is reached through Claude Code (Claude Agent SDK) and the Claude subscription it is
logged into on this machine, the way pi-claude-bridge does it: no API key is needed, and the
review counts against the plan's usage limits. Log in once with `claude` beforehand.

    uv run --env-file .env python -m ridash.review [--force]
"""

import asyncio
import json
import os
import sys
import time
from datetime import date, timedelta

import polars as pl
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKError, ResultMessage, query

from ridash import evidence
from ridash.config import (
    BRIEF_DIR,
    DECISIONS_FILE,
    EXPLAINED_RISK,
    INSIDER_CACHE,
    KEEP_COUNT,
    MAX_NET_DEBT_EBITDA,
    MIN_ROCE,
    PARTIAL_RISK,
    REVIEW_DIR,
    REVIEW_EFFORT,
    REVIEW_MAX_AGE_DAYS,
    REVIEW_MODEL,
    SHORTLIST_SIZE,
    SNAPSHOT_DIR,
    TRAP_WEIGHTS,
)
from ridash.sources import eodhd, finra
from ridash.sources.sec import Sec

# Criterion -> (label shown in the app, question asked to Claude).
CRITERIA = {
    "earnings": (
        "Trajectoire des bénéfices",
        "Are revenue or operating income falling, or expected to fall over the next few "
        "quarters: recent quarters, guidance, lost customer or product, patent expiry?",
    ),
    "cyclicality": (
        "Point du cycle",
        "Is the business cyclical, and are its margins or volumes near a cyclical peak judging "
        "by the annual history, so that the last twelve months' EBIT overstates mid-cycle "
        "earnings?",
    ),
    "structural": (
        "Déclin structurel",
        "Is the business in secular decline or exposed to disruption (technology such as AI, "
        "substitution, regulation, loss of competitive position) that threatens its earnings "
        "beyond the next few years?",
    ),
    "one_offs": (
        "Éléments exceptionnels",
        "Did one-off or unsustainable items inflate the last twelve months' EBIT or cash flow, "
        "so that the screen overstates normal earnings?",
    ),
    "balance_sheet": (
        "Bilan et financement",
        "Is there refinancing, liquidity, going-concern or dilution risk?",
    ),
    "accounting": (
        "Comptabilité",
        "Is there a restatement, change of auditor, late filing, material weakness or "
        "aggressive accounting?",
    ),
    "governance": (
        "Gouvernance et pays",
        "Is there a controlling or dual-class shareholder, related-party dealings, a VIE "
        "structure, capital controls, delisting or sanctions exposure, or another country risk "
        "that keeps the stock persistently cheap?",
    ),
    "market": (
        "Signaux de marché",
        "Do insiders sell heavily without buying, is short interest high or rising, or has "
        "the price collapsed for reasons the evidence does not explain?",
    ),
}

VERDICT_LABELS = {
    "explained": "Décote expliquée",
    "partially_explained": "Partiellement expliquée",
    "not_explained": "Non expliquée",
}

_CRITERION_SCHEMA = {
    "type": "object",
    "properties": {
        "score": {"type": "integer", "enum": [0, 1, 2, 3, 4, 5]},
        "rationale": {"type": "string"},
        "sources": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["score", "rationale", "sources"],
    "additionalProperties": False,
}
VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "bear_case": {"type": "string"},
        "criteria": {
            "type": "object",
            "properties": {name: _CRITERION_SCHEMA for name in CRITERIA},
            "required": list(CRITERIA),
            "additionalProperties": False,
        },
        "red_flags": {"type": "array", "items": {"type": "string"}},
        "news_tone": {"type": "string", "enum": ["negative", "mixed", "neutral", "positive"]},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "summary": {"type": "string"},
    },
    "required": ["bear_case", "criteria", "red_flags", "news_tone", "confidence", "summary"],
    "additionalProperties": False,
}

_CRITERIA_TEXT = "\n".join(f"   - {name}: {question}" for name, (_, question) in CRITERIA.items())
INSTRUCTIONS = f"""\
You review stocks that a quantitative value screen ranks as cheap. The screen only sees the \
financial statements of the last twelve months reported: it ranks companies on EV/EBIT and \
free-cash-flow yield, among those with a return on capital employed above {MIN_ROCE:.0%} and \
net debt below {MAX_NET_DEBT_EBITDA:g} times EBITDA. Estimate the risk that the stock is a \
value trap, cheap because of problems the market knows and these figures do not show: a \
deteriorating business, earnings at a cyclical peak, a structural decline, or a discount that \
persists for good reasons.

Work in this order:
1. bear_case: the strongest argument that the market is right to price the stock low, as a \
short seller would make it from the evidence. Make it even if you end up disagreeing.
2. criteria: score each criterion from 0 to 5 and justify the score in one sentence citing \
evidence ids (such as Q1, E1, I1, S1, F2, N3). 0 = no concern in the evidence, 1 = minor, \
2 = moderate, 3 = significant, 4 = severe, 5 = critical, enough on its own to reject the stock.
{_CRITERIA_TEXT}
   Score what the evidence shows: missing information is not a concern in itself, but it \
lowers your confidence.
3. red_flags, news_tone, confidence and summary.

Reference points: short interest above 10% of shares outstanding or above 7 days to cover is \
high. Insider sales under pre-arranged 10b5-1 plans are routine; open-market purchases by \
insiders are a positive sign. A discount shared by the whole sector is at most a partial \
explanation. Earnings releases are written by the company: weigh their claims against the \
reported figures. In a cyclical industry (commodities, chemicals, memory chips, autos, \
building, shipping, energy), a last-year operating margin well above its median over the \
history (H1) is a sign of peak earnings. A VIE structure, or operations and cash held mainly in \
mainland China or another jurisdiction with capital controls, scores at least 3 on governance.

Rules:
- Ground every rationale in the evidence and cite its ids. Do not add company-specific facts \
that are not in the evidence. For the structural criterion only, you may also rely on \
well-established knowledge of the industry; say so in the rationale.
- Ignore articles that mention the company only in passing (market roundups, lists of stocks).
- Write the bear case, the rationales, the red flags and the summary in French. The bear case \
and the summary are at most three sentences each; each rationale is one sentence.
"""


class ReviewError(Exception):
    pass


def shortlist(snapshot: pl.DataFrame) -> pl.DataFrame:
    return snapshot.filter(pl.col("rank").is_not_null()).sort("rank").head(SHORTLIST_SIZE)


# ---------------------------------------------------------------- scoring


def trap_risk(criteria: dict) -> float:
    """Weighted criteria scores, from 0 (no concern anywhere) to 100 (critical everywhere)."""
    return round(100 * sum(w * criteria[name]["score"] for name, w in TRAP_WEIGHTS.items()) / 5, 1)


def suggest(review: pl.DataFrame) -> pl.DataFrame:
    """Verdict from the trap risk, and "keep" for the KEEP_COUNT lowest risks among the stocks
    whose discount is not explained and that score no criterion as critical."""
    risk = pl.col("trap_risk")
    eligible = risk.is_not_null() & (risk < EXPLAINED_RISK) & ~pl.col("critical")
    return review.with_columns(
        verdict=pl.when(risk >= EXPLAINED_RISK)
        .then(pl.lit("explained"))
        .when(risk >= PARTIAL_RISK)
        .then(pl.lit("partially_explained"))
        .when(risk.is_not_null())
        .then(pl.lit("not_explained")),
        suggestion=pl.when(pl.when(eligible).then(risk).rank("ordinal") <= KEEP_COUNT)
        .then(pl.lit("keep"))
        .when(risk.is_not_null())
        .then(pl.lit("exclude")),
    )


# ---------------------------------------------------------------- Claude


def claude_options() -> ClaudeAgentOptions:
    """Claude Code, run through the Agent SDK with the Claude subscription it is logged into."""
    return ClaudeAgentOptions(
        model=REVIEW_MODEL,
        effort=REVIEW_EFFORT,
        # Appended to Claude Code's own system prompt rather than replacing it: requests with a
        # replaced prompt may be billed as Extra Usage instead of counting against the plan.
        system_prompt={"type": "preset", "preset": "claude_code", "append": INSTRUCTIONS},
        tools=[],  # everything Claude needs is in the prompt: no file, shell or web access
        setting_sources=[],  # no CLAUDE.md, skills, hooks or settings from this machine
        max_turns=5,
        output_format={"type": "json_schema", "schema": VERDICT_SCHEMA},
    )


async def ask_claude(brief: str) -> tuple[dict, float]:
    """Schema-validated assessment, and its cost at API prices as reported by Claude Code (with
    a subscription it counts against the plan's usage limits rather than being billed)."""
    result = None
    async for message in query(prompt=brief, options=claude_options()):
        if isinstance(message, ResultMessage):
            result = message
    if result is None or result.subtype != "success" or result.structured_output is None:
        detail = (result.errors or result.subtype) if result is not None else "no result"
        raise ReviewError(f"pas de verdict ({detail})")
    return result.structured_output, result.total_cost_usd or 0.0


async def ask_all(
    briefs: list[str], concurrency: int = 3
) -> list[tuple[dict | None, float, str | None]]:
    """(assessment, cost, error) for each brief, a few Claude Code processes at a time."""
    gate = asyncio.Semaphore(concurrency)

    async def ask(brief: str) -> tuple[dict | None, float, str | None]:
        async with gate:
            try:
                assessment, usd = await ask_claude(brief)
            except (ClaudeSDKError, ReviewError) as error:
                return None, 0.0, str(error)
            return assessment, usd, None

    return await asyncio.gather(*(ask(brief) for brief in briefs))


# ---------------------------------------------------------------- persistence


def reusable(previous: dict | None, fingerprint: str, as_of: date) -> bool:
    return (
        previous is not None
        and previous.get("trap_risk") is not None
        and set(json.loads(previous["criteria"])) == set(CRITERIA)
        and previous["fingerprint"] == fingerprint
        and (as_of - previous["analysed_on"]).days <= REVIEW_MAX_AGE_DAYS
    )


def latest_review(before: date | None = None) -> pl.DataFrame | None:
    files = sorted(REVIEW_DIR.glob("*.parquet"))
    if before is not None:
        files = [f for f in files if date.fromisoformat(f.stem) < before]
    return pl.read_parquet(files[-1]) if files else None


def with_decisions(review: pl.DataFrame, decisions: pl.DataFrame | None) -> pl.DataFrame:
    """The user's latest decision per ticker, or the suggestion where there is none."""
    if decisions is None or decisions.is_empty():
        return review.with_columns(decision=pl.col("suggestion"))
    latest = decisions.sort("decided_at").group_by("ticker").last().select("ticker", "decision")
    return review.join(latest, on="ticker", how="left").with_columns(
        decision=pl.coalesce("decision", "suggestion")
    )


def read_decisions() -> pl.DataFrame | None:
    return pl.read_parquet(DECISIONS_FILE) if DECISIONS_FILE.exists() else None


def load_insider_cache() -> dict[str, list[dict]]:
    """Transactions already read, by Form 4 accession number (filings never change)."""
    if not INSIDER_CACHE.exists():
        return {}
    cache: dict[str, list[dict]] = {}
    for row in pl.read_parquet(INSIDER_CACHE).iter_rows(named=True):
        transactions = cache.setdefault(row.pop("accn"), [])
        if row["code"] is not None:
            transactions.append(row)
    return cache


def save_insider_cache(cache: dict[str, list[dict]]) -> None:
    empty = {
        "date": None,
        "insider": None,
        "title": None,
        "code": None,
        "shares": None,
        "value": None,
        "planned": None,
    }
    rows = [{"accn": accn, **t} for accn, items in cache.items() for t in items or [empty]]
    pl.DataFrame(rows, infer_schema_length=None).write_parquet(INSIDER_CACHE)


def insider_transactions(
    sec: Sec, filings: pl.DataFrame, as_of: date, cache: dict[str, list[dict]]
) -> list[dict]:
    forms = filings.filter(
        (pl.col("form") == "4")
        & pl.col("filed").is_between(as_of - timedelta(days=evidence.INSIDER_DAYS), as_of)
    ).head(evidence.MAX_FORM4)
    for form in forms.iter_rows(named=True):
        if form["accn"] not in cache:
            cache[form["accn"]] = sec.insider_transactions(form["url"])
    return [t for accn in forms["accn"] for t in cache[accn]]


# ---------------------------------------------------------------- daily run


def use_subscription() -> None:
    # As in pi-claude-bridge: any of these would point Claude Code at an API key or a gateway
    # instead of the Claude subscription it is logged into.
    for variable in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        os.environ.pop(variable, None)


def main() -> None:
    started = time.monotonic()
    snapshot = pl.read_parquet(sorted(SNAPSHOT_DIR.glob("*.parquet"))[-1])
    as_of = snapshot["date"][0]
    path = REVIEW_DIR / f"{as_of.isoformat()}.parquet"
    if path.exists() and "--force" not in sys.argv[1:]:
        print(f"{as_of}: review already written, nothing to do (--force to redo it)")
        return
    use_subscription()

    stocks = shortlist(snapshot)
    tickers = stocks["ticker"].to_list()
    prices = eodhd.price_history([*tickers, "SPY"], as_of - timedelta(days=400), as_of)
    signals = evidence.market_signals(prices)
    spy_12m = signals.filter(pl.col("ticker") == "SPY")["ret_12m"].first()
    for extra in (
        evidence.sentiment_signals(
            eodhd.sentiments(tickers, as_of - timedelta(days=90), as_of), as_of
        ),
        evidence.short_signals(finra.short_interest(as_of), stocks),
    ):
        signals = signals.join(extra, on="ticker", how="full", coalesce=True)
    signals_by_ticker = {row["ticker"]: {**row, "spy_12m": spy_12m} for row in signals.to_dicts()}

    sec = Sec()
    tags = [*evidence.REVENUE_TAGS, "OperatingIncomeLoss"]
    facts = pl.concat([sec.frame(tag, p) for tag in tags for p in evidence.quarter_periods(as_of)])
    shortlisted = pl.col("cik").is_in(stocks["cik"].to_list())
    quarters = evidence.quarterly_results(facts.filter(shortlisted))
    quarters_by_cik = quarters.partition_by("cik", as_dict=True)
    annual = pl.concat([sec.frame(tag, p) for tag in tags for p in evidence.annual_periods(as_of)])
    history = evidence.annual_history(annual.filter(shortlisted))
    history_by_cik = history.partition_by("cik", as_dict=True)

    previous = latest_review(before=as_of)
    previous_by_ticker = (
        {row["ticker"]: row for row in previous.to_dicts()} if previous is not None else {}
    )
    insider_cache = load_insider_cache()
    rows, to_analyse, briefs = [], [], []
    for stock in stocks.to_dicts():
        ticker, cik = stock["ticker"], stock["cik"]
        filings = sec.filings(cik)
        results_filing = evidence.latest_results_filing(filings, as_of)
        release = None
        if results_filing and (
            found := sec.earnings_release(cik, results_filing["accn"], results_filing["url"])
        ):
            release = {**results_filing, "text": found[0], "url": found[1]}
        stock_quarters = quarters_by_cik.get((cik,))
        quarter_rows = stock_quarters.to_dicts() if stock_quarters is not None else []
        stock_history = history_by_cik.get((cik,))
        history_rows = stock_history.to_dicts() if stock_history is not None else []
        insiders = evidence.insider_summary(
            insider_transactions(sec, filings, as_of, insider_cache)
        )
        stock_signals = signals_by_ticker.get(ticker, {"spy_12m": spy_12m})
        articles = evidence.relevant_news(
            eodhd.news(ticker, as_of - timedelta(days=evidence.NEWS_DAYS), as_of),
            ticker,
            stock["name"],
            as_of,
        )
        events = evidence.material_events(filings, as_of)
        brief = evidence.build_evidence(
            stock, stock_signals, articles, events, quarter_rows, history_rows, release, insiders
        )
        latest_quarter = quarter_rows[0] if quarter_rows else {}
        row = {
            "date": as_of,
            **{k: stock[k] for k in ("rank", "ticker", "name", "sector", "value_score")},
            **{
                k: stock_signals.get(k)
                for k in (
                    "ret_1m",
                    "ret_3m",
                    "ret_12m",
                    "drawdown",
                    "spy_12m",
                    "sentiment_30d",
                    "news_30d",
                    "short_pct",
                    "short_change",
                    "days_to_cover",
                )
            },
            "revenue_yoy": latest_quarter.get("revenue_yoy"),
            "operating_income_yoy": latest_quarter.get("operating_income_yoy"),
            "insider_net": insiders["buy_value"] - insiders["sell_value"],
            "news_count": len(articles),
            "sec_red_flags": sum(e["red_flag"] for e in events),
            "sources": json.dumps(brief.sources, ensure_ascii=False),
            "fingerprint": brief.fingerprint,
        }
        prior = previous_by_ticker.get(ticker)
        if reusable(prior, brief.fingerprint, as_of):
            keep = (
                "bear_case",
                "criteria",
                "red_flags",
                "news_tone",
                "confidence",
                "summary",
                "trap_risk",
                "critical",
                "sources",
                "analysed_on",
                "model",
            )
            row.update({k: prior[k] for k in keep}, cost_usd=0.0, error=None)
        else:
            to_analyse.append((len(rows), brief.text))
        briefs.append({"ticker": ticker, "brief": brief.text})
        rows.append(row)
    save_insider_cache(insider_cache)

    answers = asyncio.run(ask_all([brief for _, brief in to_analyse]))
    for (index, _), (assessment, usd, error) in zip(to_analyse, answers, strict=True):
        if assessment is None:
            rows[index].update(trap_risk=None, critical=False, cost_usd=0.0, error=error)
            continue
        criteria = assessment["criteria"]
        rows[index].update(
            bear_case=assessment["bear_case"],
            criteria=json.dumps(criteria, ensure_ascii=False),
            red_flags=json.dumps(assessment["red_flags"], ensure_ascii=False),
            news_tone=assessment["news_tone"],
            confidence=assessment["confidence"],
            summary=assessment["summary"],
            trap_risk=trap_risk(criteria),
            critical=any(c["score"] == 5 for c in criteria.values()),
            analysed_on=as_of,
            model=REVIEW_MODEL,
            cost_usd=usd,
            error=None,
        )

    review = suggest(pl.DataFrame(rows, infer_schema_length=None))
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    review.write_parquet(path)
    # Kept locally so that the same evidence can be analysed again (ridash.stability).
    BRIEF_DIR.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(briefs).write_parquet(BRIEF_DIR / path.name)

    counts = review.group_by("verdict").len().sort("verdict").rows()
    kept = review.filter(pl.col("suggestion") == "keep").height
    print(
        f"{as_of}: {len(to_analyse)} analysed, {len(rows) - len(to_analyse)} reused -> {path.name}"
    )
    print("verdicts:", ", ".join(f"{verdict}: {n}" for verdict, n in counts), f"| kept: {kept}")
    print(
        f"API-price equivalent ${review['cost_usd'].sum():.2f}, "
        f"done in {time.monotonic() - started:.0f}s"
    )
    for row in review.filter(pl.col("error").is_not_null()).iter_rows(named=True):
        print(f"error {row['ticker']}: {row['error']}")


if __name__ == "__main__":
    main()
