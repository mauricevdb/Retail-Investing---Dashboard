import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.app.detail_view import trace_indicator, trace_percentile, trace_price
from dashboard.calc.ratios import ev_to_ebit, fcf_yield, net_debt_to_ebitda
from dashboard.calc.roic import resolve as resolve_roic
from dashboard.ingestion.edgar_facts import parse_company_facts
from dashboard.ingestion.eodhd_prices import parse_bulk_prices

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_companyfacts_0000000001.json"
GOLDEN_GAMMA = (
    Path(__file__).parent.parent / "golden" / "raw" / "edgar_companyfacts_0000000003.json"
)
GOLDEN_PRICES = (
    Path(__file__).parent.parent / "golden" / "raw" / "eodhd_bulk_prices_2024-02-15.json"
)


def _facts() -> pl.DataFrame:
    with open(GOLDEN, encoding="utf-8") as f:
        return parse_company_facts(json.load(f))


def _facts_gamma() -> pl.DataFrame:
    with open(GOLDEN_GAMMA, encoding="utf-8") as f:
        return parse_company_facts(json.load(f))


def _values(market_cap: float, facts: pl.DataFrame, cik: str, end: date, t: date) -> dict:
    return {
        "ev_ebit": ev_to_ebit(market_cap, facts, cik, end, t),
        "fcf_yield": fcf_yield(market_cap, facts, cik, end, t),
        "roic": resolve_roic(facts, cik, end, t),
        "net_debt_ebitda": net_debt_to_ebitda(facts, cik, end, t),
    }


def test_every_displayed_number_traceable() -> None:
    facts = _facts()
    cik = "0000000001"
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)
    market_cap = 2_000_000_000.0

    values = _values(market_cap, facts, cik, end, t)

    # Alpha résout tous ses indicateurs au tag primaire : chaque composante
    # tracée doit porter le rang de repli 1, avec end/filed/accn connus, et
    # le statut est "ok" puisque le chiffre est à la fois calculable et
    # tracé.
    for indicator in ("ev_ebit", "fcf_yield", "roic", "net_debt_ebitda"):
        result = trace_indicator(facts, cik, end, t, indicator, values[indicator])
        assert result["status"] == "ok"
        assert len(result["components"]) > 0
        for component in result["components"]:
            assert component["end"] == end
            assert component["filed"] is not None
            assert component["accn"] is not None
            assert component["rank"] == 1

    # Les deux percentiles se tracent jusqu'à leur formule, pas un tag.
    own_history_trace = trace_percentile(
        "own_history", historical_values=[(2023, 5.3)], since_year=2011, t_year=2023
    )
    assert "formula" in own_history_trace
    assert "inputs" in own_history_trace
    assert "window" in own_history_trace

    sector_trace = trace_percentile("sector", sector_values=[1.0] * 10)
    assert "formula" in sector_trace
    assert "inputs" in sector_trace
    assert "population" in sector_trace

    # Gamma (CIK 3) n'a pas de tag primaire OperatingIncomeLoss : son EBIT
    # est reconstruit (résultat net + impôts + intérêts). La trace ne doit
    # pas revenir vide -- elle doit exposer ces trois composantes, avec un
    # rang de repli 2 calculé à partir du tag effectivement résolu, jamais
    # écrit en dur à 1. Gamma n'a en revanche aucune dette déposée : EV/EBIT
    # et dette nette/EBITDA sont réellement non calculables pour ce titre
    # (net_debt exige une dette), et le statut doit le dire explicitement --
    # jamais une trace vide indistincte d'un défaut de l'outil.
    facts_gamma = _facts_gamma()
    cik_gamma = "0000000003"
    values_gamma = _values(market_cap, facts_gamma, cik_gamma, end, t)

    for indicator in ("ev_ebit", "net_debt_ebitda"):
        assert values_gamma[indicator] is None

        result = trace_indicator(facts_gamma, cik_gamma, end, t, indicator, values_gamma[indicator])
        assert result["status"] == "non_calculable"

        by_concept = {component["concept"]: component for component in result["components"]}

        for concept in ("NetIncomeLoss", "IncomeTaxExpenseBenefit", "InterestExpense"):
            assert concept in by_concept, f"{concept} absent de la trace de {indicator}"
            component = by_concept[concept]
            assert component["rank"] == 2
            assert component["end"] == end
            assert component["filed"] is not None
            assert component["accn"] is not None

        # OperatingIncomeLoss n'existe pas chez Gamma : il ne doit jamais
        # apparaître dans la trace comme s'il avait été résolu.
        assert "OperatingIncomeLoss" not in by_concept


def test_non_calculable_and_non_traceable_are_distinct_statuses() -> None:
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)
    facts = _facts()

    # Non calculable : Gamma n'a pas de dette déposée, donc EV/EBIT n'est
    # réellement pas calculable pour ce titre (cf. test précédent). C'est
    # le cas normal d'une donnée manquante -- signalé, jamais masqué.
    facts_gamma = _facts_gamma()
    non_calculable = trace_indicator(facts_gamma, "0000000003", end, t, "ev_ebit", None)
    assert non_calculable["status"] == "non_calculable"

    # Non traçable : cas construit où un chiffre est affirmé calculable
    # (une valeur non nulle est fournie, comme le ferait l'appelant à partir
    # de calc.ratios) mais où aucune composante ne peut être remontée aux
    # faits déposés -- ici en interrogeant un CIK absent des faits fournis.
    # C'est la limite que l'outil doit signaler distinctement, jamais comme
    # une liste vide indiscernable du cas non calculable.
    non_traceable = trace_indicator(facts, "0000009999", end, t, "roic", 1.23)
    assert non_traceable["status"] == "non_traceable"
    assert non_traceable["components"] == []

    assert non_calculable["status"] != non_traceable["status"]


def test_price_traceable_to_quotation_date() -> None:
    with open(GOLDEN_PRICES, encoding="utf-8") as f:
        raw = json.load(f)
    _, prices_adj = parse_bulk_prices(raw)

    # AAAA a subi un fractionnement 2:1 le 2024-02-15 (cf.
    # test_no_raw_adjusted_mixing) : le prix doit se tracer jusqu'à sa date
    # de cotation, et la série utilisée doit être signalée explicitement
    # comme l'ajustée -- jamais la brute (invariant 4).
    trace = trace_price(prices_adj, "AAAA", date(2024, 2, 15))
    assert trace is not None
    assert trace["quotation_date"] == date(2024, 2, 15)
    assert trace["series"] == "close_adj"
    assert trace["value"] == 76.5

    # La veille du fractionnement, la série ajustée continue sans le saut
    # que présenterait la série brute (150.0) : 75.0, pas 150.0.
    trace_veille = trace_price(prices_adj, "AAAA", date(2024, 2, 14))
    assert trace_veille is not None
    assert trace_veille["quotation_date"] == date(2024, 2, 14)
    assert trace_veille["series"] == "close_adj"
    assert trace_veille["value"] == 75.0

    # Titre absent des prix fournis : pas de trace, jamais une date fictive.
    assert trace_price(prices_adj, "ZZZZ", date(2024, 2, 15)) is None
