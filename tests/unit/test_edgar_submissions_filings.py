import json
from datetime import date
from pathlib import Path

from dashboard.ingestion.edgar_submissions import parse_filings

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_submissions_0000000001.json"


def test_edgar_submissions_parses_filing_history() -> None:
    with open(GOLDEN, encoding="utf-8") as f:
        raw = json.load(f)

    df = parse_filings(raw)

    assert df.height == 2
    assert set(df.columns) == {"cik", "accn", "form", "filed", "period_of_report"}
    assert set(df["cik"]) == {"0000000001"}

    ten_k = df.filter(df["form"] == "10-K").row(0, named=True)
    assert ten_k["accn"] == "0000000001-24-000010"
    assert ten_k["filed"] == date(2024, 2, 15)
    assert ten_k["period_of_report"] == date(2023, 12, 31)

    amendment = df.filter(df["form"] == "10-K/A").row(0, named=True)
    assert amendment["accn"] == "0000000001-24-000003"
    assert amendment["filed"] == date(2024, 3, 20)


def test_edgar_submissions_filing_without_report_date_is_none() -> None:
    # Découvert en ingestion réelle (T75) : un 8-K, un formulaire de proxy
    # ou une déclaration d'initié n'a pas de période de rapport -- l'API
    # SEC renvoie une chaîne vide, jamais un champ absent. period_of_report
    # doit rester explicitement absent pour ce dépôt, jamais une date
    # devinée (invariant 7), sans empêcher les autres dépôts d'être parsés.
    raw = {
        "cik": "0000000001",
        "filings": {
            "recent": {
                "accessionNumber": ["0000000001-24-000010", "0000000001-24-000011"],
                "form": ["10-K", "8-K"],
                "filingDate": ["2024-02-15", "2024-02-20"],
                "reportDate": ["2023-12-31", ""],
            }
        },
    }

    df = parse_filings(raw)

    assert df.height == 2

    ten_k = df.filter(df["form"] == "10-K").row(0, named=True)
    assert ten_k["period_of_report"] == date(2023, 12, 31)

    eight_k = df.filter(df["form"] == "8-K").row(0, named=True)
    assert eight_k["accn"] == "0000000001-24-000011"
    assert eight_k["filed"] == date(2024, 2, 20)
    assert eight_k["period_of_report"] is None


def test_edgar_submissions_filings_beyond_schema_inference_sample() -> None:
    # Découvert en ingestion réelle (T75, JPMorgan) : un émetteur qui dépose
    # beaucoup (8-K, Form 4...) a souvent plus de 100 dépôts sans période de
    # rapport avant le premier dépôt périodique dans l'historique "recent".
    # pl.DataFrame(rows) n'infère le type d'une colonne que sur un
    # échantillon limité de lignes (100 par défaut) : si cet échantillon ne
    # contient que des None, Polars échoue en rencontrant la première vraie
    # date plus loin ("could not append value ... to the builder").
    accession_numbers = [f"0000000001-24-{i:06d}" for i in range(150)]
    forms = ["8-K"] * 148 + ["10-K", "10-K/A"]
    filing_dates = ["2024-01-01"] * 148 + ["2024-02-15", "2024-03-20"]
    report_dates = [""] * 148 + ["2023-12-31", "2023-12-31"]

    raw = {
        "cik": "0000000001",
        "filings": {
            "recent": {
                "accessionNumber": accession_numbers,
                "form": forms,
                "filingDate": filing_dates,
                "reportDate": report_dates,
            }
        },
    }

    df = parse_filings(raw)

    assert df.height == 150
    ten_k = df.filter(df["form"] == "10-K").row(0, named=True)
    assert ten_k["period_of_report"] == date(2023, 12, 31)
    assert df.filter(df["form"] == "8-K")["period_of_report"].is_null().all()
