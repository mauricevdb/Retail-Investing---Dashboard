"""Qualitative review of the value shortlist: is each stock's discount explained?

A low multiple is an opportunity only if the market is not pricing in a problem that the
historical figures cannot show: falling earnings, a one-off gain, litigation, an accounting
issue... For each of the best-ranked stocks, this module gathers recent news (EODHD), the
material events filed with the SEC (8-K, late-filing notices) and the stock's price
behaviour, then asks Claude for a verdict with its reasons and sources. The verdict is a
suggestion: the decision to keep or exclude a stock stays with the user.

Claude is reached through Claude Code (Claude Agent SDK) and the Claude subscription it is
logged into on this machine, the way pi-claude-bridge does it: no API key is needed, and the
review counts against the plan's usage limits. Log in once with `claude` beforehand.

    uv run --env-file .env python -m ridash.review
"""

import asyncio
import hashlib
import html
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import date, timedelta

import polars as pl
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKError, ResultMessage, query

from ridash.config import (
    DECISIONS_FILE,
    REVIEW_DIR,
    REVIEW_EFFORT,
    REVIEW_MAX_AGE_DAYS,
    REVIEW_MODEL,
    SHORTLIST_SIZE,
    SNAPSHOT_DIR,
)
from ridash.sources import eodhd
from ridash.sources.sec import Sec

NEWS_DAYS = 90
FILING_DAYS = 365
MAX_ARTICLES = 12
EXCERPT_CHARS = 1500

# Form 8-K items worth reporting, and those that often explain a discount on their own.
ITEM_NAMES = {
    "1.01": "Material agreement",
    "1.02": "Termination of a material agreement",
    "1.03": "Bankruptcy or receivership",
    "1.05": "Cybersecurity incident",
    "2.01": "Acquisition or disposal of assets",
    "2.02": "Results of operations",
    "2.03": "New financial obligation",
    "2.04": "Event accelerating a financial obligation",
    "2.05": "Exit or restructuring costs",
    "2.06": "Material impairment",
    "3.01": "Delisting notice or listing-rule failure",
    "3.02": "Unregistered sale of equity",
    "4.01": "Change of auditor",
    "4.02": "Prior financial statements no longer reliable",
    "5.01": "Change in control",
    "5.02": "Departure or appointment of directors or officers",
    "8.01": "Other event",
}
RED_FLAG_ITEMS = {"1.03", "1.05", "2.04", "2.06", "3.01", "4.01", "4.02"}
LATE_FILING_FORMS = {"NT 10-K", "NT 10-Q", "NT 20-F"}

VERDICT_LABELS = {
    "explained": "Décote expliquée",
    "partially_explained": "Partiellement expliquée",
    "not_explained": "Non expliquée",
}

VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": list(VERDICT_LABELS)},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "news_tone": {"type": "string", "enum": ["negative", "mixed", "neutral", "positive"]},
        "suggestion": {"type": "string", "enum": ["keep", "exclude"]},
        "summary": {"type": "string"},
        "factors": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "nature": {"type": "string", "enum": ["structural", "temporary", "uncertain"]},
                    "sources": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["description", "nature", "sources"],
                "additionalProperties": False,
            },
        },
        "red_flags": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "verdict",
        "confidence",
        "news_tone",
        "suggestion",
        "summary",
        "factors",
        "red_flags",
    ],
    "additionalProperties": False,
}

INSTRUCTIONS = """\
You review stocks that a quantitative value screen ranks as cheap. The screen only sees the \
latest annual financial statements: EV/EBIT, free-cash-flow yield, return on capital employed \
and leverage. Judge whether the low valuation is explained by information the market knows \
and these figures do not show, using only the evidence provided.

Typical explanations: earnings expected to fall (lost contract or customer, patent expiry, \
new competition, guidance cut, end of a cyclical peak); a one-off gain inflating the last \
fiscal year; litigation, regulatory or political risk; accounting problems (restatement, \
change of auditor, late filing); going-concern, refinancing or dilution risk; governance or a \
controlling shareholder; risks specific to foreign issuers, such as Chinese VIE structures. \
A discount shared by the whole sector is at most a partial explanation.

Verdict:
- explained: identified problems plausibly justify most of the discount; the stock may be a \
value trap.
- partially_explained: real concerns exist but look temporary, uncertain or smaller than the \
discount.
- not_explained: the evidence shows no material problem; the discount may be an opportunity.

Suggest "exclude" when the discount is explained, or when a red flag (accounting, going \
concern, late filing) makes the reported figures themselves unreliable; otherwise "keep".

Rules:
- Ground every factor in the evidence and cite its ids, such as N3 or F1. Do not add facts \
that are not in the evidence. When the evidence is thin, say so and lower your confidence.
- Ignore articles that mention the company only in passing (market roundups, lists of stocks).
- Price behaviour is a clue, not an explanation: a falling price shows that the market \
worries, the news and filings show why.
- Write the summary, the factors and the red flags in French. The summary is at most three \
sentences; each factor is one sentence.
"""


class ReviewError(Exception):
    pass


@dataclass(frozen=True)
class Evidence:
    text: str
    sources: list[dict]
    fingerprint: str


def shortlist(snapshot: pl.DataFrame) -> pl.DataFrame:
    return snapshot.filter(pl.col("rank").is_not_null()).sort("rank").head(SHORTLIST_SIZE)


def market_signals(prices: pl.DataFrame) -> pl.DataFrame:
    """Price change over 1, 3 and 12 months (21, 63, 252 sessions) and distance from the
    52-week high, from adjusted closes. Left empty when the history is too short."""

    def change(sessions: int) -> pl.Expr:
        close = pl.col("adj_close")
        return pl.when(pl.len() > sessions).then(
            close.last() / close.tail(sessions + 1).first() - 1
        )

    return (
        prices.sort("date")
        .group_by("ticker")
        .agg(
            ret_1m=change(21),
            ret_3m=change(63),
            ret_12m=change(252),
            drawdown=pl.col("adj_close").last() / pl.col("adj_close").tail(252).max() - 1,
        )
    )


def sentiment_signals(sentiment: pl.DataFrame, as_of: date) -> pl.DataFrame:
    """News sentiment over the last 30 days and the 60 days before, weighted by article count."""
    recent = pl.col("date") > as_of - timedelta(days=30)

    def weighted(window: pl.Expr) -> pl.Expr:
        count = pl.col("count").filter(window)
        mean = (pl.col("sentiment").filter(window) * count).sum() / count.sum()
        return pl.when(count.sum() > 0).then(mean)

    return sentiment.group_by("ticker").agg(
        sentiment_30d=weighted(recent),
        news_30d=pl.col("count").filter(recent).sum(),
        sentiment_prev=weighted(~recent),
    )


def material_events(filings: pl.DataFrame, as_of: date) -> list[dict]:
    window = filings.filter(
        pl.col("filed").is_between(as_of - timedelta(days=FILING_DAYS), as_of)
        & (pl.col("form").str.starts_with("8-K") | pl.col("form").is_in(LATE_FILING_FORMS))
    )
    events = []
    for filing in window.iter_rows(named=True):
        items = [item.strip() for item in (filing["items"] or "").split(",")]
        names = [ITEM_NAMES[item] for item in items if item in ITEM_NAMES]
        late = filing["form"] in LATE_FILING_FORMS
        if late:
            names = ["Late filing notice"]
        if names:
            events.append(
                {
                    **filing,
                    "description": "; ".join(names),
                    "red_flag": late or bool(RED_FLAG_ITEMS & set(items)),
                }
            )
    return events


def relevant_news(articles: list[dict], ticker: str, name: str, as_of: date) -> list[dict]:
    """Most relevant recent articles: about the company in the title, then focused on few
    companies, then most recent."""
    keyword = re.split(r"[^A-Za-z0-9&]+", name.strip())[0].lower()

    def relevance(article: dict) -> tuple:
        title = html.unescape(article["title"]).lower()
        named = re.search(rf"\b{re.escape(ticker.lower())}\b", title) or keyword in title
        return (bool(named), len(article.get("symbols") or []) <= 3, article["date"])

    dated = [a for a in articles if date.fromisoformat(a["date"][:10]) <= as_of]
    return sorted(dated, key=relevance, reverse=True)[:MAX_ARTICLES]


def build_evidence(
    stock: dict, articles: list[dict], events: list[dict], signals: dict
) -> Evidence:
    def number(value, pattern: str) -> str:
        return "n/a" if value is None else pattern.format(value)

    lines = [
        f"Company: {stock['ticker']} - {stock['name']} ({stock['industry'] or 'industry unknown'}; "
        f"sector {stock['sector'] or 'unknown'})",
        f"Review date: {stock['date']}",
        "",
        f"Valuation from the latest annual report (fiscal year ended {stock['fiscal_end']}):",
        f"- Value score {number(stock['value_score'], '{:.0f}')}/100, rank {stock['rank']} "
        "of the screened universe",
        f"- EV/EBIT {number(stock['ev_ebit'], '{:.1f}')} | FCF yield "
        f"{number(stock['fcf_yield'], '{:.1%}')} | ROCE {number(stock['roce'], '{:.1%}')} | "
        f"net debt/EBITDA {number(stock['net_debt_ebitda'], '{:.1f}')}",
        f"- Market cap ${stock['market_cap'] / 1e9:.1f}bn | EBIT "
        f"{number(stock['ebit'] and stock['ebit'] / 1e6, '${:,.0f}m')} ({stock['ebit_source']})",
        "",
        "Price behaviour:",
        f"- Total return: 1 month {number(signals.get('ret_1m'), '{:+.1%}')}, 3 months "
        f"{number(signals.get('ret_3m'), '{:+.1%}')}, 12 months "
        f"{number(signals.get('ret_12m'), '{:+.1%}')} (S&P 500 ETF over 12 months: "
        f"{number(signals.get('spy_12m'), '{:+.1%}')})",
        f"- Distance from the 52-week high: {number(signals.get('drawdown'), '{:+.1%}')}",
        "- News sentiment (EODHD lexical score, -1 to 1): "
        f"{number(signals.get('sentiment_30d'), '{:.2f}')} over the last 30 days "
        f"({signals.get('news_30d') or 0} articles), "
        f"{number(signals.get('sentiment_prev'), '{:.2f}')} over the 60 days before",
        "",
        "SEC filings over the last 12 months (8-K events and late-filing notices):",
    ]
    sources = []
    for i, event in enumerate(events, start=1):
        flag = " [RED FLAG]" if event["red_flag"] else ""
        lines.append(f"[F{i}] {event['filed']} {event['form']}: {event['description']}{flag}")
        sources.append(
            {
                "id": f"F{i}",
                "kind": "SEC",
                "date": str(event["filed"]),
                "title": f"{event['form']} - {event['description']}",
                "url": event["url"],
            }
        )
    if not events:
        lines.append("(none)")

    lines += ["", f"News over the last {NEWS_DAYS} days, most relevant first:"]
    for i, article in enumerate(articles, start=1):
        title = html.unescape(article["title"])
        excerpt = " ".join(html.unescape(article.get("content") or "").split())[:EXCERPT_CHARS]
        lines += [f'[N{i}] {article["date"][:10]} "{title}"', excerpt, ""]
        sources.append(
            {
                "id": f"N{i}",
                "kind": "News",
                "date": article["date"][:10],
                "title": title,
                "url": article["link"],
            }
        )
    if not articles:
        lines.append("(none)")

    identity = (
        [a["link"] for a in articles] + [e["accn"] for e in events] + [str(stock["fiscal_end"])]
    )
    fingerprint = hashlib.sha256("\n".join(sorted(identity)).encode()).hexdigest()[:16]
    return Evidence("\n".join(lines), sources, fingerprint)


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


async def ask_claude(evidence: str) -> tuple[dict, float]:
    """Schema-validated verdict, and its cost at API prices as reported by Claude Code (with a
    subscription it counts against the plan's usage limits rather than being billed)."""
    result = None
    async for message in query(prompt=evidence, options=claude_options()):
        if isinstance(message, ResultMessage):
            result = message
    if result is None or result.subtype != "success" or result.structured_output is None:
        detail = (result.errors or result.subtype) if result is not None else "no result"
        raise ReviewError(f"pas de verdict ({detail})")
    return result.structured_output, result.total_cost_usd or 0.0


async def ask_all(
    evidences: list[str], concurrency: int = 3
) -> list[tuple[dict | None, float, str | None]]:
    """(verdict, cost, error) for each evidence, a few Claude Code processes at a time."""
    gate = asyncio.Semaphore(concurrency)

    async def ask(evidence: str) -> tuple[dict | None, float, str | None]:
        async with gate:
            try:
                verdict, usd = await ask_claude(evidence)
            except (ClaudeSDKError, ReviewError) as error:
                return None, 0.0, str(error)
            return verdict, usd, None

    return await asyncio.gather(*(ask(evidence) for evidence in evidences))


def reusable(previous: dict | None, fingerprint: str, as_of: date) -> bool:
    return (
        previous is not None
        and previous["verdict"] is not None
        and previous["fingerprint"] == fingerprint
        and (as_of - previous["analysed_on"]).days <= REVIEW_MAX_AGE_DAYS
    )


def latest_review(before: date | None = None) -> pl.DataFrame | None:
    files = sorted(REVIEW_DIR.glob("*.parquet"))
    if before is not None:
        files = [f for f in files if date.fromisoformat(f.stem) < before]
    return pl.read_parquet(files[-1]) if files else None


def with_decisions(review: pl.DataFrame, decisions: pl.DataFrame | None) -> pl.DataFrame:
    """The user's latest decision per ticker, or Claude's suggestion where there is none."""
    if decisions is None or decisions.is_empty():
        return review.with_columns(decision=pl.col("suggestion"))
    latest = decisions.sort("decided_at").group_by("ticker").last().select("ticker", "decision")
    return review.join(latest, on="ticker", how="left").with_columns(
        decision=pl.coalesce("decision", "suggestion")
    )


def read_decisions() -> pl.DataFrame | None:
    return pl.read_parquet(DECISIONS_FILE) if DECISIONS_FILE.exists() else None


def main() -> None:
    started = time.monotonic()
    snapshot = pl.read_parquet(sorted(SNAPSHOT_DIR.glob("*.parquet"))[-1])
    as_of = snapshot["date"][0]
    path = REVIEW_DIR / f"{as_of.isoformat()}.parquet"
    if path.exists():
        print(f"{as_of}: review already written, nothing to do")
        return
    # As in pi-claude-bridge: any of these would point Claude Code at an API key or a gateway
    # instead of the Claude subscription it is logged into.
    for variable in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        os.environ.pop(variable, None)

    stocks = shortlist(snapshot)
    tickers = stocks["ticker"].to_list()
    prices = eodhd.price_history([*tickers, "SPY"], as_of - timedelta(days=400), as_of)
    signals = market_signals(prices)
    spy_12m = signals.filter(pl.col("ticker") == "SPY")["ret_12m"].first()
    signals = signals.join(
        sentiment_signals(eodhd.sentiments(tickers, as_of - timedelta(days=90), as_of), as_of),
        on="ticker",
        how="full",
        coalesce=True,
    )
    signals_by_ticker = {row["ticker"]: {**row, "spy_12m": spy_12m} for row in signals.to_dicts()}
    previous = latest_review(before=as_of)
    previous_by_ticker = (
        {row["ticker"]: row for row in previous.to_dicts()} if previous is not None else {}
    )

    sec = Sec()
    rows, to_analyse = [], []
    for stock in stocks.to_dicts():
        ticker = stock["ticker"]
        articles = relevant_news(
            eodhd.news(ticker, as_of - timedelta(days=NEWS_DAYS), as_of),
            ticker,
            stock["name"],
            as_of,
        )
        events = material_events(sec.filings(stock["cik"]), as_of)
        stock_signals = signals_by_ticker.get(ticker, {"spy_12m": spy_12m})
        evidence = build_evidence(stock, articles, events, stock_signals)
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
                )
            },
            "news_count": len(articles),
            "sec_red_flags": sum(e["red_flag"] for e in events),
            "sources": json.dumps(evidence.sources, ensure_ascii=False),
            "fingerprint": evidence.fingerprint,
        }
        prior = previous_by_ticker.get(ticker)
        if reusable(prior, evidence.fingerprint, as_of):
            keep = (
                "verdict",
                "confidence",
                "news_tone",
                "suggestion",
                "summary",
                "factors",
                "red_flags",
                "sources",
                "analysed_on",
                "model",
            )
            row.update({k: prior[k] for k in keep}, cost_usd=0.0, error=None)
        else:
            to_analyse.append((len(rows), evidence.text))
        rows.append(row)

    answers = asyncio.run(ask_all([text for _, text in to_analyse]))
    for (index, _), (verdict, usd, error) in zip(to_analyse, answers, strict=True):
        if verdict is None:
            rows[index].update(verdict=None, cost_usd=0.0, error=error)
            continue
        verdict["factors"] = json.dumps(verdict["factors"], ensure_ascii=False)
        verdict["red_flags"] = json.dumps(verdict["red_flags"], ensure_ascii=False)
        rows[index].update(verdict, analysed_on=as_of, model=REVIEW_MODEL, cost_usd=usd, error=None)

    review = pl.DataFrame(rows, infer_schema_length=None)
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    review.write_parquet(path)

    counts = review.group_by("verdict").len().sort("verdict").rows()
    errors = review.filter(pl.col("error").is_not_null())
    print(
        f"{as_of}: {len(to_analyse)} analysed, {len(rows) - len(to_analyse)} reused -> {path.name}"
    )
    print("verdicts:", ", ".join(f"{verdict}: {n}" for verdict, n in counts))
    print(f"cost ${review['cost_usd'].sum():.2f}, done in {time.monotonic() - started:.0f}s")
    for row in errors.iter_rows(named=True):
        print(f"error {row['ticker']}: {row['error']}")


if __name__ == "__main__":
    main()
