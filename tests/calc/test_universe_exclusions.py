import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.universe import apply_exclusions
from dashboard.ingestion.edgar_submissions import parse_sic_and_entity_type

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _sic(cik10: str, as_of: date) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_submissions_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_sic_and_entity_type(raw, as_of=as_of)


def test_universe_exclusions() -> None:
    as_of = date(2024, 2, 20)
    sic_codes = pl.concat(
        [
            _sic("0000000001", as_of),  # Alpha : SIC 3674, opérationnelle.
            _sic("0000000003", as_of),  # Gamma : SIC 6022 (banque).
            _sic("0000000004", as_of),  # Delta : SIC 6726 (investment office).
            _sic("0000000005", as_of),  # Epsilon : fonds/ETF, SIC 5040 (hors plage).
        ]
    )

    eligible = apply_exclusions(sic_codes)

    assert set(eligible["cik"]) == {"0000000001"}


def test_universe_exclusions_missing_sic_treated_as_non_operating() -> None:
    # Découvert en ingestion réelle (T75) : un fonds réglementé (BDC) a
    # entityType "operating" comme une vraie société -- seul son SIC est
    # vide, jamais un code numérique. entity_type seul ne suffit donc pas
    # à l'exclure ; l'absence de SIC doit être traitée comme un signal
    # d'exclusion, jamais silencieusement ignorée (invariant 7).
    sic_codes = pl.DataFrame(
        [
            {"ticker": "AAAA", "sic": "3571", "entity_type": "operating"},
            {"ticker": "BDCX", "sic": "", "entity_type": "operating"},
        ]
    )

    eligible = apply_exclusions(sic_codes)

    assert set(eligible["ticker"]) == {"AAAA"}
