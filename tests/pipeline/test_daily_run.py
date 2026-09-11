import json
from datetime import UTC, date, datetime
from pathlib import Path

from dashboard.ingestion.edgar_facts import parse_company_facts
from dashboard.ingestion.eodhd_prices import parse_bulk_prices
from dashboard.pipeline.daily_run import run

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def test_daily_run_uses_close_and_known_filings() -> None:
    with open(GOLDEN / "edgar_companyfacts_0000000001.json", encoding="utf-8") as f:
        facts = parse_company_facts(json.load(f))
    with open(GOLDEN / "eodhd_bulk_prices_2024-02-15.json", encoding="utf-8") as f:
        _, prices_adjusted = parse_bulk_prices(json.load(f))

    instant = datetime(2024, 2, 15, 22, 0, tzinfo=UTC)

    result = run(
        facts=facts,
        prices_adj=prices_adjusted,
        cik="0000000001",
        ticker="AAAA",
        concept="NetIncomeLoss",
        end=date(2023, 12, 31),
        instant=instant,
    )

    assert result["date"] == date(2024, 2, 15)

    # Seul le dépôt initial (300M, filed 2024-02-15) est connu à cette
    # date -- le retraitement (280M, filed 2024-03-20) n'apparaît pas.
    assert result["fundamental"] == 300000000
    assert result["close"] == 76.5
