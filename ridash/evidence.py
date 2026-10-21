"""Evidence on a shortlisted stock: what the market knows that the annual figures do not show.

Everything comes from free primary sources (SEC filings, FINRA, EODHD news and prices) and is
written up as a plain-text brief in which every item carries an id (H1, Q1, E1, S1, F3, N2...)
that Claude cites and the app links back to.
"""

import hashlib
import html
import re
import statistics
from dataclasses import dataclass
from datetime import date, timedelta

import polars as pl

NEWS_DAYS = 90
FILING_DAYS = 365
INSIDER_DAYS = 180
RELEASE_DAYS = 120
MAX_ARTICLES = 12
MAX_FORM4 = 40
EXCERPT_CHARS = 1200
RELEASE_CHARS = 6000
OUTLOOK_CHARS = 3000
HISTORY_YEARS = 11  # ten full fiscal years plus the current one

REVENUE_TAGS = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
]

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


@dataclass(frozen=True)
class Evidence:
    text: str
    sources: list[dict]
    fingerprint: str


# ---------------------------------------------------------------- market behaviour


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


def short_signals(short: pl.DataFrame, stocks: pl.DataFrame) -> pl.DataFrame:
    """Short interest as a share of shares outstanding (market cap / price) and its change
    since the previous report."""
    return short.join(stocks.select("ticker", "market_cap", "close"), on="ticker").select(
        "ticker",
        "short_date",
        "days_to_cover",
        short_pct=pl.col("short_shares") / (pl.col("market_cap") / pl.col("close")),
        short_change=pl.col("short_shares") / pl.col("short_shares_prev") - 1,
    )


# ---------------------------------------------------------------- filings and results


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


def latest_results_filing(filings: pl.DataFrame, as_of: date) -> dict | None:
    """The most recent 8-K reporting results (item 2.02) filed in the last few months."""
    recent = filings.filter(
        pl.col("form").str.starts_with("8-K")
        & pl.col("items").str.contains("2.02", literal=True)
        & pl.col("filed").is_between(as_of - timedelta(days=RELEASE_DAYS), as_of)
    ).sort("filed", descending=True)
    return recent.row(0, named=True) if recent.height else None


def release_excerpt(text: str) -> str:
    """The opening of an earnings release, plus its outlook section when it comes later."""
    excerpt = text[:RELEASE_CHARS]
    match = re.search(r"\b(outlook|guidance)\b", text[RELEASE_CHARS:], re.IGNORECASE)
    if match:
        start = RELEASE_CHARS + match.start()
        excerpt += "\n[...]\n" + text[max(start - 200, RELEASE_CHARS) : start + OUTLOOK_CHARS]
    return excerpt


def quarter_periods(as_of: date, count: int = 9) -> list[str]:
    """XBRL frame names of the last `count` complete calendar quarters, newest first."""
    year, quarter = as_of.year, (as_of.month - 1) // 3
    periods = []
    for _ in range(count):
        if quarter == 0:
            year, quarter = year - 1, 4
        periods.append(f"CY{year}Q{quarter}")
        quarter -= 1
    return periods


def annual_periods(as_of: date, count: int = HISTORY_YEARS) -> list[str]:
    """XBRL frame names of the last `count` calendar years, the current one included (fiscal
    years ending in it are already reported)."""
    return [f"CY{year}" for year in range(as_of.year, as_of.year - count, -1)]


def _results(facts: pl.DataFrame) -> pl.DataFrame:
    """Revenue and operating income per company and period end, revenue taken from the most
    specific tag reported."""
    priority = {tag: rank for rank, tag in enumerate(REVENUE_TAGS)}
    revenue = (
        facts.filter(pl.col("tag").is_in(REVENUE_TAGS))
        .with_columns(priority=pl.col("tag").replace_strict(priority))
        .sort("priority")
        .group_by("cik", "end")
        .first()
        .select("cik", "end", revenue="value")
    )
    income = (
        facts.filter(pl.col("tag") == "OperatingIncomeLoss")
        .unique(["cik", "end"])
        .select("cik", "end", operating_income="value")
    )
    return revenue.join(income, on=["cik", "end"], how="full", coalesce=True)


def annual_history(facts: pl.DataFrame) -> pl.DataFrame:
    """Revenue, operating income and operating margin per company and fiscal year, newest
    first: the material to judge where the last year stands in the cycle."""
    return (
        _results(facts)
        .with_columns(
            margin=pl.when(pl.col("revenue") > 0).then(
                pl.col("operating_income") / pl.col("revenue")
            )
        )
        .sort("cik", "end", descending=[False, True])
    )


def history_summary(years: list[dict]) -> dict:
    """Latest operating margin against its range over the history, and revenue growth per
    year between the oldest and the latest fiscal year (years newest first)."""
    margins = [y["margin"] for y in years if y["margin"] is not None]
    revenues = [(y["end"], y["revenue"]) for y in years if y["revenue"]]
    span = (revenues[0][0] - revenues[-1][0]).days / 365.25 if len(revenues) > 1 else 0
    return {
        "margin": margins[0] if margins else None,
        "median_margin": statistics.median(margins) if margins else None,
        "low_margin": min(margins, default=None),
        "high_margin": max(margins, default=None),
        "margin_years": len(margins),
        "revenue_cagr": (revenues[0][1] / revenues[-1][1]) ** (1 / span) - 1
        if span >= 1 and revenues[-1][1] > 0
        else None,
        "revenue_years": round(span),
    }


def quarterly_results(facts: pl.DataFrame) -> pl.DataFrame:
    """Revenue and operating income per company and quarter, with year-on-year changes."""
    quarters = _results(facts)
    year_before = quarters.select(
        "cik",
        prior_end="end",
        prior_revenue="revenue",
        prior_income="operating_income",
    ).sort("prior_end")
    return (
        quarters.with_columns(target=pl.col("end") - timedelta(days=364))
        .sort("target")
        .join_asof(
            year_before,
            left_on="target",
            right_on="prior_end",
            by="cik",
            strategy="nearest",
            tolerance=timedelta(days=20),
            check_sortedness=False,  # both sides are sorted on the join key just above
        )
        .select(
            "cik",
            "end",
            "revenue",
            "operating_income",
            revenue_yoy=pl.col("revenue") / pl.col("prior_revenue") - 1,
            operating_income_yoy=(pl.col("operating_income") - pl.col("prior_income"))
            / pl.col("prior_income").abs(),
        )
        .sort("cik", "end", descending=[False, True])
    )


def insider_summary(transactions: list[dict]) -> dict:
    """Open-market purchases and sales by insiders, with the largest of each."""
    buys = [t for t in transactions if t["code"] == "P"]
    sells = [t for t in transactions if t["code"] == "S"]

    def total(items) -> float:
        return sum(t["value"] or 0 for t in items)

    def largest(items) -> list[dict]:
        return sorted(items, key=lambda t: t["value"] or 0, reverse=True)[:3]

    return {
        "buy_count": len(buys),
        "buyers": len({t["insider"] for t in buys}),
        "buy_value": total(buys),
        "sell_count": len(sells),
        "sell_value": total(sells),
        "planned_sell_value": total(t for t in sells if t["planned"]),
        "largest": largest(buys) + largest(sells),
    }


# ---------------------------------------------------------------- news


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


# ---------------------------------------------------------------- the brief


def _num(value, pattern: str) -> str:
    return "n/a" if value is None else pattern.format(value)


def _usd(value: float | None) -> str:
    if value is None:
        return "n/a"
    if abs(value) >= 1e9:
        return f"${value / 1e9:,.1f}bn"
    return f"${value / 1e6:,.1f}m"


def build_evidence(
    stock: dict,
    signals: dict,
    articles: list[dict],
    events: list[dict],
    quarters: list[dict],
    history: list[dict],
    release: dict | None,
    insiders: dict,
) -> Evidence:
    cik = stock["cik"]
    lines = [
        f"Company: {stock['ticker']} - {stock['name']} ({stock['industry'] or 'industry unknown'}; "
        f"sector {stock['sector'] or 'unknown'})",
        f"Review date: {stock['date']}",
        "",
        f"Valuation over the twelve months to {stock['period_end']} (latest report: "
        f"{stock['form']}):",
        f"- Value score {_num(stock['value_score'], '{:.0f}')}/100, rank {stock['rank']} "
        "of the screened universe",
        f"- EV/EBIT {_num(stock['ev_ebit'], '{:.1f}')} | FCF yield "
        f"{_num(stock['fcf_yield'], '{:.1%}')} | ROCE {_num(stock['roce'], '{:.1%}')} | "
        f"net debt/EBITDA {_num(stock['net_debt_ebitda'], '{:.1f}')}",
        f"- Market cap {_usd(stock['market_cap'])} | EBIT {_usd(stock['ebit'])} "
        f"({stock['ebit_source']})",
        "",
        "Annual results over the last fiscal years (SEC XBRL, newest first) [H1]:",
    ]
    for year in history:
        lines.append(
            f"- fiscal year ended {year['end']}: revenue {_usd(year['revenue'])}, operating "
            f"income {_usd(year['operating_income'])}, operating margin "
            f"{_num(year['margin'], '{:.1%}')}"
        )
    if history:
        summary = history_summary(history)
        lines.append(
            f"- Latest operating margin {_num(summary['margin'], '{:.1%}')} against a median of "
            f"{_num(summary['median_margin'], '{:.1%}')} over {summary['margin_years']} years "
            f"(range {_num(summary['low_margin'], '{:.1%}')} to "
            f"{_num(summary['high_margin'], '{:.1%}')}); revenue growth "
            f"{_num(summary['revenue_cagr'], '{:+.1%}')} a year over {summary['revenue_years']} "
            "years"
        )
    else:
        lines.append("(no annual history)")
    lines += ["", "Quarterly results (SEC XBRL, calendar quarters, newest first) [Q1]:"]
    sources = [
        {
            "id": "H1",
            "kind": "SEC",
            "date": str(history[0]["end"]) if history else "",
            "title": "Historique annuel (XBRL)",
            "url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=10-K",
        },
        {
            "id": "Q1",
            "kind": "SEC",
            "date": str(quarters[0]["end"]) if quarters else "",
            "title": "Résultats trimestriels (XBRL)",
            "url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=10-Q",
        },
    ]
    for quarter in quarters[:5]:
        lines.append(
            f"- quarter ended {quarter['end']}: revenue {_usd(quarter['revenue'])} "
            f"({_num(quarter['revenue_yoy'], '{:+.1%}')} y/y), operating income "
            f"{_usd(quarter['operating_income'])} "
            f"({_num(quarter['operating_income_yoy'], '{:+.1%}')} y/y)"
        )
    if not quarters:
        lines.append("(no quarterly data)")

    lines.append("")
    if release:
        lines += [
            f"Latest earnings release (8-K item 2.02 filed {release['filed']}) [E1]:",
            release_excerpt(release["text"]),
        ]
        sources.append(
            {
                "id": "E1",
                "kind": "SEC",
                "date": str(release["filed"]),
                "title": "Communiqué de résultats (8-K, annexe 99.1)",
                "url": release["url"],
            }
        )
    else:
        lines.append(f"Latest earnings release: none filed in the last {RELEASE_DAYS} days.")

    lines += [
        "",
        f"Insider transactions over the last {INSIDER_DAYS // 30} months "
        "(Form 4, open market) [I1]:",
        f"- Purchases: {insiders['buy_count']} by {insiders['buyers']} insider(s), "
        f"{_usd(insiders['buy_value'])} in total",
        f"- Sales: {insiders['sell_count']}, {_usd(insiders['sell_value'])} in total, of which "
        f"{_usd(insiders['planned_sell_value'])} under pre-arranged 10b5-1 plans",
    ]
    for t in insiders["largest"]:
        verb = "bought" if t["code"] == "P" else "sold"
        plan = ", 10b5-1 plan" if t["planned"] else ""
        lines.append(
            f"- {t['date']} {t['insider']} ({t['title']}) {verb} {t['shares']:,.0f} shares "
            f"({_usd(t['value'])}{plan})"
        )
    sources.append(
        {
            "id": "I1",
            "kind": "SEC",
            "date": "",
            "title": "Transactions des dirigeants (Form 4)",
            "url": f"https://www.sec.gov/cgi-bin/own-disp?action=getissuer&CIK={cik}",
        }
    )

    lines += ["", "Market behaviour:"]
    lines += [
        f"- Total return: 1 month {_num(signals.get('ret_1m'), '{:+.1%}')}, 3 months "
        f"{_num(signals.get('ret_3m'), '{:+.1%}')}, 12 months "
        f"{_num(signals.get('ret_12m'), '{:+.1%}')} (S&P 500 ETF over 12 months: "
        f"{_num(signals.get('spy_12m'), '{:+.1%}')})",
        f"- Distance from the 52-week high: {_num(signals.get('drawdown'), '{:+.1%}')}",
        "- News sentiment (EODHD lexical score, -1 to 1): "
        f"{_num(signals.get('sentiment_30d'), '{:.2f}')} over the last 30 days "
        f"({signals.get('news_30d') or 0} articles), "
        f"{_num(signals.get('sentiment_prev'), '{:.2f}')} over the 60 days before",
    ]
    if signals.get("short_date"):
        short_date = signals["short_date"]
        lines.append(
            f"- Short interest (FINRA, settlement {short_date}) [S1]: "
            f"{_num(signals.get('short_pct'), '{:.1%}')} of shares outstanding "
            f"({_num(signals.get('short_change'), '{:+.1%}')} since the previous report), "
            f"{_num(signals.get('days_to_cover'), '{:.1f}')} days to cover"
        )
        sources.append(
            {
                "id": "S1",
                "kind": "FINRA",
                "date": str(short_date),
                "title": "Positions vendeuses à découvert",
                "url": f"https://cdn.finra.org/equity/otcmarket/biweekly/shrt{short_date:%Y%m%d}.csv",
            }
        )
    else:
        lines.append("- Short interest: not reported")

    lines += ["", "SEC filings over the last 12 months (8-K events and late-filing notices):"]
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

    identity = [
        *(a["link"] for a in articles),
        *(e["accn"] for e in events),
        str(stock["period_end"]),
        str(quarters[0]["end"]) if quarters else "",
        release["accn"] if release else "",
        str(signals.get("short_date")),
        f"{insiders['buy_count']}/{insiders['sell_count']}",
    ]
    fingerprint = hashlib.sha256("\n".join(sorted(identity)).encode()).hexdigest()[:16]
    return Evidence("\n".join(lines), sources, fingerprint)
