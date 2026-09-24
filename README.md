# RI Dashboard

A personal retail-investing dashboard. The first module is a **value screen of US equities**:
it ranks listed companies by how cheap they look on their latest annual financial statements,
and shows how every number was computed, down to the SEC filing it comes from.

## How it works

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

## Running it

Requires [uv](https://docs.astral.sh/uv/) and an [EODHD](https://eodhd.com) API key (EOD plan).

```bash
uv sync
cp .env.example .env          # then fill in SEC_USER_AGENT and EODHD_API_KEY
uv run --env-file .env python -m ridash.refresh
uv run streamlit run streamlit_app.py
```

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
  sources/      SEC EDGAR and EODHD clients
  fundamentals.py   latest annual fundamentals from XBRL frames
  value.py          universe, metrics, value score
  refresh.py        daily pipeline, writes data/snapshots/<date>.parquet
streamlit_app.py    screen and per-company breakdown
tests/
```

## Limitations

- Annual figures lag by up to a year; a trailing-twelve-month view would be more reactive.
- XBRL tagging varies across filers: some companies are left unscored because a concept is
  reported under a tag outside the fallback lists, and a few of those presumed debt-free actually
  report their debt under company-specific tags.
- Foreign private issuers filing under IFRS (20-F) have no us-gaap data and are not scored.
- Percentiles are computed across the whole universe, not within sectors.

## Roadmap

- Portfolio tracking (positions, performance, exposure).
- Strategy design and backtesting on accumulated snapshots.

This dashboard shows measurements, not investment advice.
