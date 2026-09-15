from datetime import date

import polars as pl

from dashboard.calc.cash_bridge import trace as trace_cash
from dashboard.calc.debt_bridge import trace as trace_debt
from dashboard.calc.dna_bridge import trace as trace_dna
from dashboard.calc.ebit_bridge import trace as trace_ebit
from dashboard.calc.equity_bridge import trace as trace_equity
from dashboard.calc.fcf_bridge import trace as trace_fcf
from dashboard.calc.nopat import trace_tax_rate

# Chaque indicateur délègue sa trace aux bridges qui le composent réellement
# (T25-T33) : la chaîne de repli et le rang qui en résulte viennent de ces
# bridges, jamais d'une liste de tags supposée a priori (cf. T64).
_INDICATOR_TRACERS: dict[str, tuple] = {
    "ev_ebit": (trace_ebit, trace_debt, trace_cash),
    "fcf_yield": (trace_fcf, trace_debt, trace_cash),
    "roic": (trace_ebit, trace_tax_rate, trace_debt, trace_equity, trace_cash),
    "net_debt_ebitda": (trace_ebit, trace_dna, trace_debt, trace_cash),
}


def trace_indicator(
    facts: pl.DataFrame, cik: str, end: date, t: date, indicator: str, value: float | None
) -> dict:
    components = [
        component
        for tracer in _INDICATOR_TRACERS[indicator]
        for component in tracer(facts, cik, end, t)
    ]

    # Un composant de paramètre de modélisation (ex. le repli du taux
    # d'imposition par défaut, T69) doit toujours être divulgué quand il
    # influence le chiffre (invariant 7), mais lui seul ne prouve jamais
    # qu'un indicateur est traçable jusqu'à un fait déposé (invariant 8) :
    # calc.nopat.trace_tax_rate renvoie toujours au moins un élément, même
    # sans aucune donnée fiscale, ce qui rendait roic "ok" alors qu'EBIT,
    # dette, capitaux propres et trésorerie pouvaient être tous introuvables
    # (trouvé par /spec-verify, cinquième passage, T79).
    fact_components = [component for component in components if "concept" in component]

    if value is None:
        # Donnée réellement absente (invariant 7, critères 6/11) : signalée
        # comme non calculable, jamais masquée ni comblée par défaut.
        status = "non_calculable"
    elif not fact_components:
        # Un chiffre est affiché mais aucune composante issue d'un fait
        # déposé n'a pu être remontée (invariant 8, critères 9/27) : ce
        # n'est jamais une absence de donnée, c'est une limite de l'outil,
        # et elle doit être signalée comme telle -- même si un paramètre de
        # modélisation, lui, a bien été divulgué.
        status = "non_traceable"
    else:
        status = "ok"

    return {"status": status, "components": components}


def trace_price(prices_adj: pl.DataFrame, ticker: str, date_today: date) -> dict | None:
    rows = (
        prices_adj.filter((pl.col("ticker") == ticker) & (pl.col("date") <= date_today))
        .sort("date", descending=True)
        .head(1)
    )
    if rows.height == 0:
        return None

    row = rows.row(0, named=True)
    # Toujours la série ajustée (invariant 4) : jamais un prix brut, même
    # au voisinage d'un fractionnement.
    return {"quotation_date": row["date"], "series": "close_adj", "value": row["close_adj"]}


def trace_percentile(kind: str, **kwargs: object) -> dict:
    if kind == "own_history":
        return {
            "formula": "percentile de la valeur courante parmi l'historique propre du titre",
            "inputs": kwargs["historical_values"],
            "window": f"{kwargs['since_year']}-{kwargs['t_year']}",
        }
    if kind == "sector":
        sector_values = kwargs["sector_values"]
        return {
            "formula": "percentile de la valeur courante parmi le groupe sectoriel du jour",
            "inputs": sector_values,
            "population": f"{len(sector_values)} titres",
        }
    raise ValueError(f"type de percentile inconnu : {kind!r}")
