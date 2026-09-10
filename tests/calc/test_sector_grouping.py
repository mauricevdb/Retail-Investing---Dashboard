import json
from pathlib import Path

from dashboard.calc.sector_grouping import classify

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _sic(cik10: str) -> str:
    with open(GOLDEN / f"edgar_submissions_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return raw["sic"]


def test_sector_grouping_classifies_by_sic_division() -> None:
    # Alpha (SIC 3674, semi-conducteurs) -> division D (industrie
    # manufacturière).
    assert classify(_sic("0000000001")) == "D"

    # Epsilon (SIC 5040, commerce de gros -- émetteur déjà présent depuis
    # T34, pas de nouvel émetteur nécessaire) -> division F.
    assert classify(_sic("0000000005")) == "F"

    # Hors plage (1850, entre les divisions C et D, non couvert par le
    # standard) -> non calculable, jamais rattaché par défaut à une
    # division voisine.
    assert classify(_sic("0000000006")) is None
