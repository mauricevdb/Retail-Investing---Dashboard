import math
import os
from datetime import date, timedelta

import altair as alt
import numpy as np
import polars as pl
import streamlit as st

from app.common import latest_snapshot, pct
from ridash import portfolio
from ridash.review import latest_review, read_decisions, with_decisions
from ridash.sources import eodhd

MAX_ASSETS = 50


@st.cache_data(ttl="12h", show_spinner="Téléchargement des cours…")
def weekly(tickers: tuple[str, ...], start: date, end: date) -> tuple[pl.DataFrame, list[str]]:
    return portfolio.weekly_returns(eodhd.price_history(list(tickers), start, end))


def group_caps(
    tickers: list[str], labels: dict[str, tuple[str | None, str | None]], caps: tuple[float, float]
) -> tuple[portfolio.GroupCap, ...]:
    """A cap on every sector and on every country but the United States (a cap of 100% is
    no cap)."""
    sector_cap, country_cap = caps
    groups = []
    for position, cap in ((0, sector_cap), (1, country_cap)):
        values = np.array([labels[t][position] for t in tickers], dtype=object)
        names = {v for v in values if v is not None and v != "United States"}
        if cap < 1:
            groups += [portfolio.GroupCap(name, values == name, cap) for name in sorted(names)]
    return tuple(groups)


@st.cache_data(show_spinner="Optimisation…")
def analyse(
    tickers, start, end, shrink: bool, max_weight: float, risk_free: float, labels, caps
) -> dict:
    returns, _ = weekly(tickers, start, end)
    matrix = returns.drop("week").to_numpy()
    groups = group_caps(returns.columns[1:], dict(labels), caps)
    efficient = portfolio.EfficientSet(portfolio.estimate(matrix, shrink), max_weight, groups)
    return {
        "efficient": efficient,
        "equal_weight": efficient.equal_weight(),
        "frontier": efficient.frontier(),
        "min_variance": efficient.min_variance(),
        "max_sharpe": efficient.max_sharpe(risk_free),
        "correlation": np.corrcoef(matrix, rowvar=False),
    }


@st.cache_data(show_spinner=False)
def at_volatility(tickers, start, end, shrink, max_weight, risk_free, labels, caps, volatility):
    efficient = analyse(tickers, start, end, shrink, max_weight, risk_free, labels, caps)
    return efficient["efficient"].target_volatility(volatility)


snapshot = latest_snapshot()
as_of = snapshot["date"][0]
pool = snapshot.filter(pl.col("rank").is_not_null()).sort("rank")

st.title("Construction d'un portefeuille efficient")
st.caption(
    f"Univers : les {pool.height} sociétés classées par le screen au {as_of:%d/%m/%Y} · "
    "Sans vente à découvert, investi à 100 %, plafonds par action, par secteur et par pays"
)

if not os.environ.get("EODHD_API_KEY"):
    st.info(
        "Cette page télécharge l'historique des cours depuis EODHD. En local, lancer "
        "`uv run --env-file .env streamlit run streamlit_app.py` ; en ligne, définir le "
        "secret `EODHD_API_KEY`."
    )
    st.stop()

names = dict(zip(pool["ticker"], pool["name"], strict=True))
reviewed = latest_review()
if reviewed is not None:
    kept = set(
        with_decisions(reviewed, read_decisions()).filter(pl.col("decision") == "keep")["ticker"]
    )
    default = [t for t in pool["ticker"] if t in kept][:MAX_ASSETS]
    origin = "Par défaut, les actions gardées à l'issue de la revue qualitative."
else:
    default = pool["ticker"].head(20).to_list()
    origin = "Par défaut, les 20 premières du screen value (aucune revue qualitative disponible)."
with st.sidebar:
    st.header("Paramètres")
    chosen = st.multiselect(
        "Actions",
        pool["ticker"].to_list(),
        default=default,
        format_func=lambda ticker: f"{ticker} · {names[ticker]}",
        max_selections=MAX_ASSETS,
        help=origin,
    )
    years = st.slider("Historique (années)", 1, 5, 3)
    max_weight = st.slider("Poids maximum par action (%)", 5, 100, 20, 5) / 100
    sector_cap = st.slider("Poids maximum par secteur (%)", 10, 100, 30, 5) / 100
    country_cap = (
        st.slider(
            "Poids maximum par pays hors États-Unis (%)",
            5,
            100,
            20,
            5,
            help="Pays de l'adresse du siège déclarée à la SEC, là où la société est dirigée.",
        )
        / 100
    )
    risk_free = st.number_input("Taux sans risque (%/an)", 0.0, 10.0, 4.0, 0.25) / 100
    shrink = st.toggle(
        "Covariance de Ledoit-Wolf",
        value=True,
        help="Rapproche la covariance estimée d'une structure simple, dans une proportion "
        "estimée sur les données. Réduit le bruit d'estimation et stabilise les poids.",
    )

tickers = tuple(t for t in pool["ticker"] if t in chosen)
start = as_of - timedelta(weeks=52 * years)
returns, excluded = weekly(tickers, start, as_of)
kept = returns.columns[1:]
if excluded:
    st.warning(
        f"Historique insuffisant sur {years} an(s), écartées : {', '.join(excluded)}. "
        "Réduire la durée d'historique pour les inclure."
    )
if len(kept) < 2:
    st.error("Choisir au moins deux actions disposant d'un historique suffisant.")
    st.stop()
if max_weight * len(kept) < 1:
    minimum = math.ceil(100 / len(kept))
    st.error(f"Avec {len(kept)} actions, le poids maximum doit être d'au moins {minimum} %.")
    st.stop()

labels = tuple(
    (row["ticker"], (row["sector"], row["country"]))
    for row in pool.filter(pl.col("ticker").is_in(kept)).iter_rows(named=True)
)
caps = (sector_cap, country_cap)
params = (tickers, start, as_of, shrink, max_weight, risk_free, labels, caps)
try:
    result = analyse(*params)
except ValueError:
    st.error(
        "Les plafonds par secteur et par pays ne permettent pas d'investir 100 % dans ces "
        "actions : relever un plafond ou ajouter des actions d'autres secteurs ou pays."
    )
    st.stop()
efficient: portfolio.EfficientSet = result["efficient"]
estimates = efficient.estimates
n = len(kept)
correlation = result["correlation"]
off_diagonal = correlation[~np.eye(n, dtype=bool)]

cols = st.columns(4)
cols[0].metric("Actions retenues", n)
cols[1].metric("Semaines d'historique", returns.height)
cols[2].metric("Corrélation moyenne", f"{off_diagonal.mean():.2f}")
cols[3].metric(
    "Shrinkage Ledoit-Wolf",
    "—" if estimates.shrinkage is None else f"{estimates.shrinkage:.0%}",
)

# ---------------------------------------------------------------- portfolio choice
st.subheader("Portefeuille")
references = {
    "Équipondéré": result["equal_weight"],
    "Variance minimale": result["min_variance"],
}
if result["max_sharpe"] is not None:
    references["Sharpe maximal"] = result["max_sharpe"]

options = [*references, "Volatilité cible"]
default = "Équipondéré"
choice = st.segmented_control(
    "Portefeuille", options, default=default, label_visibility="collapsed"
)
choice = choice or default
if choice == "Volatilité cible":
    low = result["frontier"][0].volatility
    high = result["frontier"][-1].volatility
    target = st.slider(
        "Volatilité cible (%/an)",
        float(np.ceil(low * 1000) / 10),
        float(np.floor(high * 1000) / 10),
        float(round((low + high) * 50, 1)),
        0.5,
    )
    selected = at_volatility(*params, target / 100)
else:
    selected = references[choice]
if result["max_sharpe"] is None:
    st.caption("Aucune action n'a un rendement historique supérieur au taux sans risque.")

weights = (
    pl.DataFrame({"ticker": kept, "weight": selected.weights})
    .filter(pl.col("weight") > 5e-4)
    .join(
        pool.select("ticker", "name", "sector", "country", "value_score"), on="ticker", how="left"
    )
    .sort("weight", descending=True)
)
cols = st.columns(5)
cols[0].metric("Rendement espéré", pct(selected.expected_return))
cols[1].metric("Volatilité", pct(selected.volatility))
cols[2].metric("Sharpe", f"{selected.sharpe(risk_free):.2f}")
cols[3].metric("Lignes", weights.height)
cols[4].metric(
    "Nombre effectif de lignes",
    f"{1 / (selected.weights**2).sum():.1f}",
    help="1 / Σ poids² : vaut N pour N lignes équipondérées, moins si le portefeuille est "
    "concentré.",
)

left, right = st.columns([3, 2])
with left:
    bars = (
        alt.Chart(weights)
        .mark_bar()
        .encode(
            x=alt.X("weight:Q", title="Poids", axis=alt.Axis(format="%")),
            y=alt.Y("ticker:N", sort="-x", title=None, axis=alt.Axis(labelOverlap=False)),
            color=alt.Color("sector:N", title="Secteur"),
            tooltip=["ticker", "name", "sector", alt.Tooltip("weight:Q", format=".1%")],
        )
        .properties(height=max(160, 28 * weights.height))
    )
    st.altair_chart(bars, width="stretch")
with right:
    st.dataframe(
        weights.with_columns(pl.col("weight") * 100),
        hide_index=True,
        width="stretch",
        column_config={
            "ticker": "Ticker",
            "name": "Société",
            "sector": "Secteur",
            "weight": st.column_config.NumberColumn("Poids", format="%.1f %%"),
            "value_score": st.column_config.NumberColumn("Score value", format="%.0f"),
        },
    )
    for column, title in (("sector", "Exposition sectorielle"), ("country", "Exposition par pays")):
        exposure = (
            weights.group_by(column)
            .agg(pl.col("weight").sum() * 100)
            .sort("weight", descending=True)
        )
        st.dataframe(
            exposure,
            hide_index=True,
            width="stretch",
            column_config={
                column: title,
                "weight": st.column_config.NumberColumn("Poids", format="%.1f %%"),
            },
        )

# ---------------------------------------------------------------- efficient frontier
st.subheader("Frontière efficiente")
x = alt.X("volatility:Q", title="Volatilité annualisée", axis=alt.Axis(format="%"))
y = alt.Y("expected_return:Q", title="Rendement espéré annualisé", axis=alt.Axis(format="%"))
tooltip = [
    alt.Tooltip("volatility:Q", format=".1%"),
    alt.Tooltip("expected_return:Q", format=".1%"),
]

frontier = pl.DataFrame(
    {
        "volatility": [p.volatility for p in result["frontier"]],
        "expected_return": [p.expected_return for p in result["frontier"]],
    }
)
assets = pl.DataFrame(
    {
        "ticker": kept,
        "volatility": np.sqrt(np.diag(estimates.cov)),
        "expected_return": estimates.mean,
    }
)
markers = pl.DataFrame(
    {
        "portfolio": [*references, "Sélection"],
        "volatility": [p.volatility for p in [*references.values(), selected]],
        "expected_return": [p.expected_return for p in [*references.values(), selected]],
    }
)
layers = [
    alt.Chart(frontier).mark_line(strokeWidth=3).encode(x, y),
    alt.Chart(assets)
    .mark_circle(size=45, opacity=0.5, color="gray")
    .encode(x, y, tooltip=["ticker", *tooltip]),
    alt.Chart(assets)
    .mark_text(align="left", dx=6, fontSize=10, color="gray")
    .encode(x, y, text="ticker"),
    alt.Chart(markers)
    .mark_point(size=180, filled=True)
    .encode(
        x,
        y,
        color=alt.Color("portfolio:N", title=None),
        shape=alt.Shape("portfolio:N", title=None),
        tooltip=["portfolio", *tooltip],
    ),
]
if result["max_sharpe"] is not None:
    tangency = result["max_sharpe"]
    slope = tangency.sharpe(risk_free)
    end = float(assets["volatility"].max())
    capital_market_line = pl.DataFrame(
        {"volatility": [0.0, end], "expected_return": [risk_free, risk_free + slope * end]}
    )
    layers.insert(0, alt.Chart(capital_market_line).mark_line(strokeDash=[4, 4]).encode(x, y))
st.altair_chart(alt.layer(*layers).properties(height=460), width="stretch")
st.caption(
    "Points gris : chaque action seule. Ligne pleine : portefeuilles efficients (variance "
    "minimale pour chaque niveau de rendement, avec le poids maximum choisi). Pointillés : "
    "droite de marché des capitaux, du taux sans risque au portefeuille de Sharpe maximal."
)

# ---------------------------------------------------------------- correlations
st.subheader("Corrélations des rendements hebdomadaires")
pairs = pl.DataFrame(
    {
        "a": np.repeat(kept, n),
        "b": np.tile(kept, n),
        "correlation": correlation.ravel(),
    }
)
axis = alt.Axis(labelOverlap=False)
base = alt.Chart(pairs).encode(
    x=alt.X("a:N", sort=kept, title=None, axis=axis),
    y=alt.Y("b:N", sort=kept, title=None, axis=axis),
)
heatmap = base.mark_rect().encode(
    color=alt.Color(
        "correlation:Q",
        title="Corrélation",
        scale=alt.Scale(scheme="redblue", domain=[-1, 1], reverse=True),
    ),
    tooltip=["a", "b", alt.Tooltip("correlation:Q", format=".2f")],
)
if n <= 20:
    heatmap += base.mark_text(fontSize=9).encode(
        text=alt.Text("correlation:Q", format=".1f"),
        color=alt.when("abs(datum.correlation) > 0.6")
        .then(alt.value("white"))
        .otherwise(alt.value("black")),
    )
st.altair_chart(heatmap.properties(height=max(300, 26 * n)), width="stretch")

upper = np.triu_indices(n, k=1)
closest = np.argsort(correlation[upper])[::-1][:5]
st.caption(
    "Paires les plus corrélées : "
    + " · ".join(
        f"{kept[upper[0][i]]}/{kept[upper[1][i]]} {correlation[upper][i]:.2f}" for i in closest
    )
)

with st.expander("Méthodologie et limites"):
    st.markdown(
        f"""
- **Données** : cours de clôture ajustés des splits et dividendes (EODHD), ramenés à un cours
  par semaine sur {years} an(s) jusqu'au {as_of:%d/%m/%Y}. Seules les semaines communes à toutes
  les actions sont gardées ; une action cotée sur moins de 90 % de la période est écartée.
- **Rendement espéré** : moyenne historique des rendements hebdomadaires, annualisée (× 52).
  C'est l'estimation la plus fragile : quelques années de rendements passés prédisent mal les
  rendements futurs. Le portefeuille de **variance minimale** n'en dépend pas.
- **Risque** : matrice de covariance annualisée, par défaut réduite selon Ledoit et Wolf (2004)
  vers une matrice où toutes les actions ont la même variance et aucune corrélation.
- **Portefeuille par défaut : équipondéré**, le même poids sur chaque action ou, si un plafond
  l'interdit, le portefeuille le plus proche qui le respecte. Il ne dépend d'aucune estimation :
  le Sharpe maximal, lui, surpondère les actions qui ont le plus monté, donc les moins décotées
  aujourd'hui, à rebours de la stratégie value.
- **Plafonds** : par action, par secteur et par pays hors États-Unis (pays du siège déclaré à
  la SEC), appliqués à tous les portefeuilles.
- **Optimisation** : sans vente à découvert, investie à 100 %. Chaque portefeuille efficient
  minimise ½·w'Σw − λ·μ'w pour une tolérance au risque λ, par la méthode ADMM ;
  Sharpe = (rendement − taux sans risque) / volatilité.
- Les résultats décrivent le passé (*in-sample*) ; ce sont des mesures, pas des recommandations.
"""
    )
