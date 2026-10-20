# RI Dashboard

A personal retail-investing dashboard, in three steps:

- **Value screen** — ranks US listed companies by how cheap they look on their latest annual
  financial statements, and shows how every number was computed, down to the SEC filing it
  comes from.
- **Qualitative review** — for the 50 best-ranked stocks, Claude reads quarterly results, the
  latest earnings release, insider transactions, short interest, SEC filings and news, scores
  the risk that each discount is a value trap, and suggests the 20 safest; the user keeps or
  excludes each stock.
- **Efficient portfolio** — builds mean-variance portfolios from the stocks kept: correlations,
  efficient frontier, minimum-variance, maximum-Sharpe and target-volatility portfolios.

## Value screen

```
EODHD bulk quotes ──┐   (1 request: price, market cap, security type for every US ticker)
                    ├──► universe ──► metrics ──► value score ──► data/snapshots/<date>.parquet ──► Streamlit
SEC XBRL frames ────┘   (~200 requests: one accounting concept for every filer per period)
```

- **Universe** — US common stocks listed on NYSE, NASDAQ or NYSE American, in USD, market cap
  of at least $2bn. Financials, insurance and real estate (SIC 6000-6799) are excluded: EBIT and
  debt do not mean the same thing there.
- **Fundamentals** — the latest fiscal year reported in a 10-K, read from the SEC
  [XBRL frames API](https://www.sec.gov/edgar/sec-api-documentation). Income and cash-flow items
  cover the fiscal year; balance-sheet items are taken at its closing date. Each concept falls
  back through a short list of us-gaap tags; EBIT is operating income or, for companies that do
  not present that subtotal, pre-tax income plus interest expense.
- **Metrics**

  | Metric | Formula | Better when |
  |---|---|---|
  | EV / EBIT | (market cap + debt − cash + minority interest) / operating income | lower |
  | FCF yield | (operating cash flow − capex) / market cap | higher |
  | ROCE | EBIT / (equity + net debt) | higher |
  | Net debt / EBITDA | (debt − cash) / (EBIT + D&A) | lower |

- **Value score** — the average of the four metric percentiles across scored companies (0-100).
  Only companies with positive EBIT and EV are scored.

Missing data stays missing: a ratio that cannot be computed is left empty and the company is not
scored, rather than filled with a default. The one deliberate inference is for debt: a company that
reports no debt at all is presumed debt-free only if its interest expense is below 2% of EBIT, and
the screen flags every such case.

## Qualitative review

A low multiple is an opportunity only if the market is not pricing in a problem the historical
figures cannot show: the screen looks at the last fiscal year, the market at the next ones. Every
day, for each of the 50 best-ranked stocks, `ridash.evidence` assembles a brief from free primary
sources:

- **quarterly results**: revenue and operating income of the last quarters with their
  year-on-year change (SEC XBRL frames);
- **the latest earnings release** (exhibit 99.1 of the results 8-K), including its outlook or
  guidance section;
- **insider transactions** of the last six months (Form 4): open-market purchases and sales,
  with sales under pre-arranged 10b5-1 plans told apart;
- **short interest** as a share of shares outstanding, its change and days to cover (FINRA,
  twice a month);
- **material events** of the last 12 months (8-K items such as impairments, change of auditor
  or restatements, and late-filing notices), the most serious flagged as red flags;
- **news** of the last 90 days (EODHD), the most relevant first, and **price behaviour**
  against the S&P 500.

Claude (Sonnet 5.5) first writes the bear case, the strongest argument that the market is right,
then scores six criteria from 0 (no concern) to 5 (critical), each justified in one sentence with
the ids of the sources it rests on:

| Criterion | Weight | Question |
|---|---|---|
| Earnings trajectory | 30% | Are revenue or operating income falling or expected to fall? |
| One-off items | 15% | Did one-offs inflate the year the screen is based on? |
| Balance sheet | 15% | Refinancing, liquidity, going-concern or dilution risk? |
| Accounting | 15% | Restatement, change of auditor, late filing, aggressive accounting? |
| Governance and country | 10% | Controlling shareholder, related parties, VIE or country risk? |
| Market signals | 15% | Heavy insider selling, high or rising short interest, unexplained collapse? |

The weighted scores give a **trap risk** from 0 to 100. The 20 lowest risks are suggested for the
portfolio, never a stock whose discount is explained (risk of 55 or more) or that scores 5 on any
criterion. The score is computed in code from the criteria, so it is reproducible and the weights
can be changed in `ridash/config.py`; a stock's assessment is reused while the evidence it rests
on is unchanged (up to a week), and Form 4 filings are cached since they never change.

Claude is reached without an API key, the way
[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) does it: the review drives
Claude Code through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
using the Claude subscription Claude Code is logged into on the machine, so it counts against
the plan's usage limits. The instructions are appended to Claude Code's own system prompt
rather than replacing it, no tool is granted, no local setting is loaded, and any
`ANTHROPIC_*` variable that would redirect Claude Code to an API key is ignored. This is meant
for running the review on your own machine with your own subscription; the hosted app only
reads its results.

In the app, the review tab lists verdicts and lets the user overrule each suggestion; decisions
are saved in `data/decisions.parquet` and the portfolio tab starts from the stocks kept.

## Efficient portfolio

Pick up to 50 stocks among the scored universe (by default those kept by the review); the tab
downloads their adjusted daily closes (splits and dividends) and works on weekly returns over one
to five years.

- **Risk** — annualised covariance, by default shrunk towards a scaled identity
  ([Ledoit & Wolf, 2004](https://doi.org/10.1016/S0047-259X(03)00096-4)) with an intensity
  estimated from the data, which keeps the matrix well conditioned when there are few weeks per
  stock.
- **Expected returns** — annualised historical means. They are the weakest input: the
  minimum-variance portfolio does not depend on them.
- **Optimisation** — long-only, fully invested, with a cap per stock. Every efficient portfolio
  minimises ½·w'Σw − λ·μ'w for a risk tolerance λ; each of these small quadratic programs is
  solved by accelerated projected gradient (FISTA) with an exact projection onto the capped
  simplex, in plain NumPy. The maximum-Sharpe portfolio is found by golden-section search
  along the frontier, a target volatility by bisection.
- **Views** — frontier with the capital market line and each stock on its own, weights and
  sector exposure of the chosen portfolio, correlation heatmap and most correlated pairs.

Results are in-sample: they describe how these portfolios behaved, not how they will.

## Running it

Requires [uv](https://docs.astral.sh/uv/), an [EODHD](https://eodhd.com) API key (EOD plan) and,
for the qualitative review, a Claude subscription with Claude Code logged in (run `claude` once).

```bash
uv sync
cp .env.example .env          # then fill in SEC_USER_AGENT and EODHD_API_KEY
uv run --env-file .env python -m ridash.refresh
uv run --env-file .env python -m ridash.review
uv run --env-file .env streamlit run streamlit_app.py
```

The screen only reads the snapshots; the portfolio tab also needs `EODHD_API_KEY` to download
price histories (on Streamlit Community Cloud, set it as a secret).

The refresh takes about a minute once the SIC classification cache is built (first run: a few
minutes). Running it once a day, after the US close, is enough: fundamentals only change with new
filings, prices once per session.

```bash
uv run pytest
uv run ruff check .
```

## Layout

```
ridash/
  sources/          SEC EDGAR, EODHD and FINRA clients
  fundamentals.py   latest annual fundamentals from XBRL frames
  value.py          universe, metrics, value score
  portfolio.py      weekly returns, Ledoit-Wolf covariance, efficient portfolios
  refresh.py        daily pipeline, writes data/snapshots/<date>.parquet
  evidence.py       brief on each shortlisted stock (results, insiders, short interest, news)
  review.py         trap-risk scoring with Claude, writes data/reviews/<date>.parquet
app/
  screen.py         value screen and per-company breakdown
  review.py         verdicts, sources and keep/exclude decisions
  portfolio.py      efficient portfolio construction
streamlit_app.py    navigation between the tabs
tests/
```

## Limitations

- Annual figures lag by up to a year; a trailing-twelve-month view would be more reactive.
- XBRL tagging varies across filers: some companies are left unscored because a concept is
  reported under a tag outside the fallback lists, and a few of those presumed debt-free actually
  report their debt under company-specific tags.
- Foreign private issuers filing under IFRS (20-F) have no us-gaap data and are not scored.
- Percentiles are computed across the whole universe, not within sectors.
- Mean-variance weights are sensitive to expected returns estimated from a few years of history.
- Review verdicts are only as good as the news coverage; foreign issuers file no 8-K, so their
  review rests on news and price behaviour alone.

## Roadmap

- Portfolio tracking (positions, performance, exposure).
- Out-of-sample evaluation of portfolio rules, and strategy backtesting on accumulated snapshots.

This dashboard shows measurements, not investment advice.
