import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.nopat import resolve, resolve_tax_rate
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw"


def _facts(cik10: str) -> pl.DataFrame:
    with open(GOLDEN / f"edgar_companyfacts_{cik10}.json", encoding="utf-8") as f:
        raw = json.load(f)
    return parse_company_facts(raw)


def test_nopat_tax_rate_capping_and_fallback() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Dans la bande : Alpha, résultat avant impôt 400M (tag primaire),
    # impôt 100M -> taux calculé 25 %.
    alpha_rate, alpha_source = resolve_tax_rate(
        _facts("0000000001"), cik="0000000001", end=end, t=t
    )
    assert alpha_rate == 0.25
    assert alpha_source == (
        "us-gaap:IncomeTaxExpenseBenefit / résultat avant impôt, plafonné [0%, 50%]"
    )

    # Hors bande, plafonné : Delta, résultat avant impôt reconstruit
    # (5M + 9M = 14M), impôt 9M -> taux brut 64,3 %, plafonné à 50 %.
    delta_rate, delta_source = resolve_tax_rate(
        _facts("0000000004"), cik="0000000004", end=end, t=t
    )
    assert delta_rate == 0.5
    assert delta_source == (
        "us-gaap:IncomeTaxExpenseBenefit / résultat avant impôt, plafonné [0%, 50%]"
    )

    # Négatif ou nul (ici non calculable) : Beta est IFRS, zéro fait --
    # repli au taux par défaut configuré, jamais codé en dur silencieusement.
    beta_rate, beta_source = resolve_tax_rate(
        _facts("0000000002"), cik="0000000002", end=end, t=t, default_tax_rate=0.21
    )
    assert beta_rate == 0.21
    assert beta_source == "repli configuré : taux par défaut (21%)"

    # NOPAT complet : Alpha, EBIT 500M (T26) x (1 - 25%) = 375M, et le taux
    # utilisé reste exposé à côté du résultat.
    alpha_nopat, alpha_nopat_rate, alpha_nopat_source = resolve(
        _facts("0000000001"), cik="0000000001", end=end, t=t
    )
    assert alpha_nopat == 375000000
    assert alpha_nopat_rate == 0.25
    assert alpha_nopat_source == alpha_source
