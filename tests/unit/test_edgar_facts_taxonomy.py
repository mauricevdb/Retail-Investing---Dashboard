import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _load(cik10: str) -> dict:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        return json.load(f)


def test_ifrs_taxonomy_excluded() -> None:
    beta_df = parse_company_facts(_load("0000000002"))
    assert beta_df.height == 0

    alpha_df = parse_company_facts(_load("0000000001"))
    assert alpha_df.height > 0
    assert set(alpha_df["taxonomy"]) == {"us-gaap", "dei"}
    assert set(alpha_df.columns) == {
        "cik",
        "concept",
        "taxonomy",
        "unit",
        "end",
        "start",
        "filed",
        "accn",
        "value",
        "fiscal_period",
        "fiscal_year",
    }

    operating_income = alpha_df.filter(alpha_df["concept"] == "OperatingIncomeLoss").row(
        0, named=True
    )
    assert operating_income["cik"] == "0000000001"
    assert operating_income["unit"] == "USD"
    assert operating_income["value"] == 500000000
    assert operating_income["end"] == date(2023, 12, 31)
    assert operating_income["start"] == date(2023, 1, 1)
    assert operating_income["filed"] == date(2024, 2, 15)
    assert operating_income["accn"] == "0000000001-24-000010"
    assert operating_income["fiscal_period"] == "FY"
    assert operating_income["fiscal_year"] == 2023

    shares_outstanding = alpha_df.filter(
        alpha_df["concept"] == "EntityCommonStockSharesOutstanding"
    ).row(0, named=True)
    assert shares_outstanding["taxonomy"] == "dei"
    assert shares_outstanding["unit"] == "shares"
    assert shares_outstanding["value"] == 100000000
    assert shares_outstanding["start"] is None
