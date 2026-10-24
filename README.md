# RI Dashboard

A personal retail-investing dashboard, in three steps:

- **Value screen** — ranks US listed companies by how cheap they are against their sector, on
  their last twelve months of results and on their normal earnings over ten fiscal years, among
  those that clear a quality gate, and shows how every number was computed, down to the SEC
  filing it comes from.
- **Qualitative review** — for the 50 best-ranked stocks, Claude reads quarterly results, the
  latest earnings release, insider transactions, short interest, SEC filings and news, scores
  the risk that each discount is a value trap, and suggests the 20 safest; the user keeps or
  excludes each stock.
- **Efficient portfolio** — builds portfolios from the stocks kept, capped per stock, sector
  and country: equal weight by default, plus correlations, efficient frontier, minimum-variance,
  maximum-Sharpe and target-volatility portfolios.

## Value screen

```
EODHD bulk quotes ──┐   (1 request: price, market cap, security type for every US ticker)
                    ├──► universe ──► metrics ──► quality gate ──► value score ──► data/snapshots/<date>.parquet
SEC company facts ──┘   (one download per company, again only after it files a new report)
```

- **Universe** — US common stocks listed on NYSE, NASDAQ or NYSE American, in USD, market cap
  of at least $2bn. Financials, insurance and real estate (SIC 6000-6799) are excluded: EBIT and
  debt do not mean the same thing there. Sectors are close to the GICS ones, derived from the
  SIC code each company declares; the country is that of the head office.
- **Fundamentals** — the twelve months to the end of the latest period each company reported
  (quarter or fiscal year), from the SEC
  [XBRL company facts](https://www.sec.gov/edgar/sec-api-documentation). Quarterly reports give
  income and cash flows from the start of the fiscal year, so the twelve months are rebuilt as
  *last fiscal year + year to date − same period a year earlier*; balance-sheet items are taken
  at the end of the period. Only filings published by the snapshot date are used, so a snapshot
  never sees later information or later restatements. Each concept falls back through a short
  list of us-gaap tags; EBIT is operating income or, for companies that do not present that
  subtotal, pre-tax income plus interest expense. Facts are cached locally and a company is
  downloaded again only when the frames API shows a new report from it (or after a month).
- **Normal earnings** — the twelve months' revenue at the median operating margin (EBIT /
  revenue) of the last ten fiscal years, computed from five years of history at least, with the
  same point-in-time rule. A margin at a cyclical peak (memory chips, commodities) or trough does
  not set the price on its own; a business whose margin has genuinely improved looks dearer on
  this measure than on the last twelve months, which is why it is one of three.
- **Metrics**

  | Metric | Formula | Better when |
  |---|---|---|
  | EV / EBIT | (market cap + debt − cash + minority interest) / operating income | lower |
  | EV / normal EBIT | EV / (revenue × median operating margin over ten years) | lower |
  | FCF yield | (operating cash flow − capex − stock-based compensation) / market cap | higher |
  | ROCE | EBIT / (equity + net debt) | higher |
  | Net debt / EBITDA | (debt − cash) / (EBIT + D&A) | lower |

- **Quality gate** — only companies with a ROCE above 10% and net debt below 3 times EBITDA
  are ranked. Return on capital and leverage are a gate rather than part of the score, so that a
  high return on capital cannot make up for a higher price. A ratio that cannot be computed
  (negative capital employed, no depreciation reported) does not fail the gate, but the company
  is flagged.
- **Value score** — the average of the EV/EBIT, EV/normal EBIT and FCF-yield percentiles
  (0-100), each computed **within the company's sector**: a software company is compared with
  software and hardware companies, not with retailers that the market always values lower, so the
  ranking measures a discount rather than the sector mix. A company where one of the three
  cannot be computed (a loss, less than five years of history, no sector) gets no score, rather
  than a score on the others alone. The ranking keeps those that clear the quality gate.

Missing data stays missing: a ratio that cannot be computed is left empty and the company is not
scored, rather than filled with a default. The one deliberate inference is for debt: a company that
reports no debt at all is presumed debt-free only if it reports an interest expense below 2% of
EBIT, and the screen flags every such case. Two components count as zero when they are not
reported, since only some companies have them: minority interest and stock-based compensation
(deducted from free cash flow because operating cash flow adds it back, though it is a real cost).

## Qualitative review

A low multiple is an opportunity only if the market is not pricing in a problem the historical
figures cannot show: the screen looks at the last twelve months, the market at the next years. Every
day, for each of the 50 best-ranked stocks, `ridash.evidence` assembles a brief from free primary
sources:

- **annual history**: revenue, operating income and operating margin over the last ten fiscal
  years, with the latest margin against its median and range (SEC XBRL frames), to tell a
  cyclical peak from a durable level of earnings;
- **quarterly results**: revenue and operating income of the last quarters with their
  year-on-year change;
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
then scores eight criteria from 0 (no concern) to 5 (critical), each justified in one sentence with
the ids of the sources it rests on:

| Criterion | Weight | Question |
|---|---|---|
| Earnings trajectory | 20% | Are revenue or operating income falling or expected to fall? |
| Point in the cycle | 15% | Are margins near a cyclical peak compared with the last ten years? |
| Structural decline | 15% | Secular decline or disruption threatening earnings beyond a few years? |
| One-off items | 10% | Did one-offs inflate the year the screen is based on? |
| Balance sheet | 10% | Refinancing, liquidity, going-concern or dilution risk? |
| Accounting | 5% | Restatement, change of auditor, late filing, aggressive accounting? |
| Governance and country | 15% | Controlling shareholder, related parties, VIE, capital controls, country risk? |
| Market signals | 10% | Heavy insider selling, high or rising short interest, unexplained collapse? |

Accounting weighs little because its serious cases (restatement, change of auditor) score 5,
which excludes the stock on its own. A VIE structure or a business run mainly from a
jurisdiction with capital controls scores at least 3 on governance. For the structural criterion
only, Claude may draw on established knowledge of the industry, and says so; every other
rationale rests on the evidence.

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

**Reproducibility.** Claude does not answer twice in exactly the same way, so a trap risk is
only meaningful if its variation is small compared with the gap between the last stock kept and
the first one excluded. `python -m ridash.stability` asks Claude again on exactly the briefs of
the latest review (saved locally in `data/briefs/`), for a sample of stocks spread over the
range of risks, and reports how far the trap risks move, the share of criteria scored
identically, and how many stocks would cross the keep/exclude cut-off.

## Efficient portfolio

Pick up to 50 stocks among the ranked universe (by default those kept by the review); the tab
downloads their adjusted daily closes (splits and dividends) and works on weekly returns over one
to five years.

- **Equal weight by default** — the same weight in every stock or, when a cap forbids it, the
  closest portfolio that respects the caps. It depends on no estimate, whereas the maximum-Sharpe
  portfolio leans towards the stocks that rose most, the least cheap ones today: the opposite
  of a value strategy.
- **Caps** — per stock, per sector and per country other than the United States, applied to
  every portfolio.

- **Risk** — annualised covariance, by default shrunk towards a scaled identity
  ([Ledoit & Wolf, 2004](https://doi.org/10.1016/S0047-259X(03)00096-4)) with an intensity
  estimated from the data, which keeps the matrix well conditioned when there are few weeks per
  stock.
- **Expected returns** — annualised historical means. They are the weakest input: the
  minimum-variance portfolio does not depend on them.
- **Optimisation** — long-only and fully invested. Every efficient portfolio minimises
  ½·w'Σw − λ·μ'w for a risk tolerance λ under the caps; each of these small quadratic programs
  is solved by ADMM as in [OSQP](https://osqp.org) (one linear system inverted once, then
  clipping to the bounds, with warm starts along the frontier), in plain NumPy. The
  maximum-Sharpe portfolio is found by golden-section search along the frontier, a target
  volatility by bisection.
- **Views** — frontier with the capital market line and each stock on its own, weights, sector
  and country exposure of the chosen portfolio, correlation heatmap and most correlated pairs.

Results are in-sample: they describe how these portfolios behaved, not how they will.

## Running it

Requires [uv](https://docs.astral.sh/uv/), an [EODHD](https://eodhd.com) API key (EOD plan) and,
for the qualitative review, a Claude subscription with Claude Code logged in (run `claude` once).

```bash
uv sync
cp .env.example .env          # then fill in SEC_USER_AGENT and EODHD_API_KEY
uv run --env-file .env python -m ridash.refresh
uv run --env-file .env python -m ridash.review
uv run --env-file .env python -m ridash.stability   # optional: --stocks 10 --runs 2
uv run --env-file .env python -m ridash.update      # the three above, each only when needed
uv run --env-file .env streamlit run streamlit_app.py
```

Where the `.env` file exists, the app has a fourth tab, **Mise à jour**, that runs these
commands in the background and follows their log. The hosted app has no `.env` and no such tab:
it shows the data but cannot start a download or spend the Claude plan's quota.

The screen only reads the snapshots; the portfolio tab also needs `EODHD_API_KEY` to download
price histories (on Streamlit Community Cloud, set it as a secret).

The refresh takes a minute or two once the company caches are built (first run: about a
quarter of an hour, to download the facts of every company). Running it once a day, after the US
close, is enough: fundamentals only change with new filings, prices once per session.

```bash
uv run pytest
uv run ruff check .
```

## Layout

```
ridash/
  sources/          SEC EDGAR, EODHD and FINRA clients
  fundamentals.py   trailing-twelve-month fundamentals from XBRL company facts
  value.py          universe, sectors, metrics, quality gate, value score
  portfolio.py      weekly returns, Ledoit-Wolf covariance, efficient portfolios
  refresh.py        daily pipeline, writes data/snapshots/<date>.parquet
  evidence.py       brief on each shortlisted stock (results, insiders, short interest, news)
  review.py         trap-risk scoring with Claude, writes data/reviews/<date>.parquet
  stability.py      reproducibility of the review on the same evidence
  update.py         refresh, review and stability test in a row
app/
  screen.py         value screen and per-company breakdown
  review.py         verdicts, sources and keep/exclude decisions
  portfolio.py      efficient portfolio construction
  commands.py       runs the commands from the app (local only)
streamlit_app.py    navigation between the tabs
tests/
```

## Limitations

- A company that reports a cash-flow item only once a year (no year-to-date figure in its 10-Q)
  has no twelve-month value for it, and the ratio built on it stays empty.
- Sectors come from SIC codes, which describe products rather than business models: a few
  companies land in an unexpected sector (PayPal in Industrials). The country is that of the
  head office declared to the SEC: PDD Holdings, run from China, declares Dublin.
- XBRL tagging varies across filers: some companies are left unscored because a concept is
  reported under a tag outside the fallback lists, and a few of those presumed debt-free actually
  report their debt under company-specific tags.
- Foreign private issuers filing under IFRS (20-F) have no us-gaap data and are not scored.
- Percentiles are computed within nine broad sectors: a sector that is expensive as a whole
  still supplies its cheapest companies, and industries inside a sector (pipelines and drillers,
  retailers and carmakers) are still mixed.
- A company is not compared with its own past valuation multiples: that needs years of share
  counts and prices, and the daily snapshots will provide them, point in time, as they build up.
  Normal earnings compare today's price with the company's own past profitability instead.
- Mean-variance weights are sensitive to expected returns estimated from a few years of history.
- Review verdicts are only as good as the news coverage; foreign issuers file no 8-K, so their
  review rests on news and price behaviour alone.

## Roadmap

- Portfolio tracking (positions, performance, exposure).
- Out-of-sample evaluation of portfolio rules, and strategy backtesting on accumulated snapshots.

This dashboard shows measurements, not investment advice.
