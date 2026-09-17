from datetime import date

import polars as pl

from dashboard.calc.interest_bridge import resolve as resolve_interest
from dashboard.calc.interest_bridge import trace as trace_interest
from dashboard.calc.point_in_time import resolve as resolve_pit
from dashboard.calc.point_in_time import resolve_detail
from dashboard.calc.ttm import trace_ttm as trace_ttm_concept
from dashboard.calc.ttm import ttm


def resolve(facts: pl.DataFrame, cik: str, end: date, t: date) -> tuple[float | None, str | None]:
    primary = resolve_pit(facts, cik, "OperatingIncomeLoss", end, t)
    if primary is not None:
        return primary, "us-gaap:OperatingIncomeLoss"

    net_income = resolve_pit(facts, cik, "NetIncomeLoss", end, t)
    tax = resolve_pit(facts, cik, "IncomeTaxExpenseBenefit", end, t)
    interest = resolve_interest(facts, cik, end, t)
    if net_income is not None and tax is not None and interest is not None:
        return (
            net_income + tax + interest,
            "us-gaap:NetIncomeLoss + us-gaap:IncomeTaxExpenseBenefit + interest_bridge",
        )

    return None, None


def trace(facts: pl.DataFrame, cik: str, end: date, t: date) -> list[dict]:
    primary = resolve_detail(facts, "OperatingIncomeLoss", cik, end, t)
    if primary is not None:
        return [{**primary, "rank": 1}]

    net_income = resolve_detail(facts, "NetIncomeLoss", cik, end, t)
    tax = resolve_detail(facts, "IncomeTaxExpenseBenefit", cik, end, t)
    interest = trace_interest(facts, cik, end, t)
    if net_income is not None and tax is not None and interest is not None:
        return [{**net_income, "rank": 2}, {**tax, "rank": 2}, {**interest, "rank": 2}]

    return []


def resolve_ttm(
    facts: pl.DataFrame, cik: str, end: date, t: date
) -> tuple[float | None, str | None]:
    # Additif (T91) : sert uniquement EV/EBIT (critère 12), jamais ROIC ni
    # dette nette/EBITDA -- resolve()/trace() ci-dessus restent inchangés
    # pour ces deux indicateurs (décidé avec l'utilisateur, cohérent avec
    # ADR 0004). Seulement le tag primaire pour la somme des quatre
    # trimestres : la reconstruction de repli (résultat net + impôts +
    # intérêts) resterait à sommer trimestre par trimestre elle aussi, une
    # extension distincte. Quand moins de quatre trimestres sont connus
    # (ex. Alpha, qui ne porte qu'un fait annuel), repli explicite sur la
    # chaîne point-in-time existante -- jamais un non-calculable qui
    # jetterait une donnée annuelle par ailleurs parfaitement exploitable.
    value = ttm(facts, cik, "OperatingIncomeLoss", t)
    if value is not None:
        return value, "us-gaap:OperatingIncomeLoss (TTM)"

    return resolve(facts, cik, end, t)


def trace_ttm(facts: pl.DataFrame, cik: str, end: date, t: date) -> list[dict]:
    components = trace_ttm_concept(facts, cik, "OperatingIncomeLoss", t)
    if components:
        return components

    return trace(facts, cik, end, t)
