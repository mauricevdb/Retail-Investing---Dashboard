import polars as pl
import streamlit as st

from app.common import latest_snapshot, pct, ratio, usd
from ridash.config import MAX_NET_DEBT_EBITDA, MIN_ROCE
from ridash.fundamentals import NO_DEBT_REPORTED


def filing_url(cik: int, accn: str) -> str:
    return f"https://www.sec.gov/Archives/edgar/data/{cik}/{accn.replace('-', '')}/"


snapshot = latest_snapshot()
as_of = snapshot["date"][0]
scored = snapshot.filter(pl.col("value_score").is_not_null())
ranked = scored.filter(pl.col("rank").is_not_null())

st.title("Actions américaines en décote")
st.caption(
    f"Données au {as_of:%d/%m/%Y} · {scored.height} sociétés valorisées sur {snapshot.height}, "
    f"dont {ranked.height} classées (filtres de qualité) · Fondamentaux : SEC EDGAR, 12 mois "
    "glissants · Cours : EODHD"
)

with st.sidebar:
    st.header("Filtres")
    sectors = sorted(s for s in scored["sector"].unique().to_list() if s)
    chosen_sectors = st.multiselect("Secteurs", sectors, placeholder="Tous")
    min_cap = st.number_input("Capitalisation min. (Md$)", min_value=2.0, value=2.0, step=1.0)
    max_ev_ebit = st.number_input("EV/EBIT max. (0 = sans limite)", min_value=0.0, value=0.0)
    positive_fcf = st.checkbox("Free cash flow positif uniquement")
    with_failed_quality = st.checkbox(
        "Inclure les sociétés écartées par les filtres de qualité",
        help=f"ROCE ≤ {MIN_ROCE:.0%} ou dette nette > {MAX_NET_DEBT_EBITDA:g} × EBITDA. "
        "Elles sont valorisées mais pas classées.",
    )
    with_inferred_debt = st.checkbox(
        "Inclure les dettes présumées nulles",
        value=True,
        help="Sociétés qui ne déclarent aucune dette et des charges d'intérêts inférieures "
        "à 2 % de leur EBIT. "
        "Quelques-unes déclarent leur dette sous des tags propres "
        "et paraissent alors moins chères.",
    )
    top_n = st.slider("Nombre de lignes", 10, 300, 50, 10)

scored = scored.with_columns(debt_inferred=pl.col("debt_source") == NO_DEBT_REPORTED)
view = scored.filter(pl.col("market_cap") >= min_cap * 1e9)
if not with_failed_quality:
    view = view.filter(pl.col("quality_pass"))
if not with_inferred_debt:
    view = view.filter(~pl.col("debt_inferred"))
if chosen_sectors:
    view = view.filter(pl.col("sector").is_in(chosen_sectors))
if max_ev_ebit:
    view = view.filter(pl.col("ev_ebit") <= max_ev_ebit)
if positive_fcf:
    view = view.filter(pl.col("fcf_yield") > 0)
view = view.head(top_n)

table = view.select(
    "rank",
    "ticker",
    "name",
    "sector",
    (pl.col("market_cap") / 1e9).alias("market_cap_bn"),
    "ev_ebit",
    (pl.col("fcf_yield") * 100).alias("fcf_yield_pct"),
    (pl.col("roce") * 100).alias("roce_pct"),
    "net_debt_ebitda",
    "debt_inferred",
    "quality_unchecked",
    "value_score",
    "period_end",
)
event = st.dataframe(
    table,
    hide_index=True,
    width="stretch",
    on_select="rerun",
    selection_mode="single-row",
    column_config={
        "rank": st.column_config.NumberColumn("#", format="%d"),
        "ticker": "Ticker",
        "name": "Société",
        "sector": "Secteur",
        "market_cap_bn": st.column_config.NumberColumn("Capi. (Md$)", format="%.1f"),
        "ev_ebit": st.column_config.NumberColumn("EV/EBIT", format="%.1f"),
        "fcf_yield_pct": st.column_config.NumberColumn("Rdt FCF", format="%.1f %%"),
        "roce_pct": st.column_config.NumberColumn("ROCE", format="%.1f %%"),
        "net_debt_ebitda": st.column_config.NumberColumn("Dette nette/EBITDA", format="%.1f"),
        "debt_inferred": st.column_config.CheckboxColumn("Dette présumée nulle"),
        "quality_unchecked": st.column_config.CheckboxColumn(
            "Qualité non vérifiable",
            help="ROCE ou dette nette / EBITDA incalculable (capitaux employés négatifs, "
            "amortissements non déclarés) : la société n'est pas écartée par les filtres.",
        ),
        "value_score": st.column_config.ProgressColumn(
            "Score", min_value=0, max_value=100, format="%.0f"
        ),
        "period_end": st.column_config.DateColumn("12 mois au", format="MM/YYYY"),
    },
)
st.caption("Sélectionner une ligne pour afficher le détail du calcul.")

if event.selection.rows:
    c = view.row(event.selection.rows[0], named=True)
    st.subheader(f"{c['ticker']} · {c['name']}")
    st.markdown(
        f"{c['industry'] or 'Secteur inconnu'} · {c['country'] or 'pays inconnu'} · 12 mois "
        f"au {c['period_end']:%d/%m/%Y} · [dernier rapport ({c['form']}) déposé à la SEC]"
        f"({filing_url(c['cik'], c['accn'])})"
    )
    valuation, cash_flow, quality = st.columns(3)
    with valuation:
        st.markdown("**Valeur d'entreprise**")
        st.markdown(
            f"Capitalisation {usd(c['market_cap'])}  \n"
            f"+ Dette {usd(c['debt'])} *({c['debt_source']})*  \n"
            f"− Trésorerie {usd(c['cash'])}  \n"
            f"+ Intérêts minoritaires {usd(c['minority_interest'])}  \n"
            f"= **EV {usd(c['ev'])}**  \n"
            f"EBIT {usd(c['ebit'])} *({c['ebit_source']})*  \n"
            f"→ **EV/EBIT {ratio(c['ev_ebit'])}**"
        )
    with cash_flow:
        sbc = c["stock_compensation"]
        fcf = (
            None
            if c["operating_cash_flow"] is None or c["capex"] is None
            else c["operating_cash_flow"] - c["capex"] - (sbc or 0)
        )
        st.markdown("**Free cash flow**")
        st.markdown(
            f"Flux opérationnel {usd(c['operating_cash_flow'])}  \n"
            f"− Investissements {usd(c['capex'])}  \n"
            f"− Rémunération en actions "
            f"{usd(sbc) if sbc is not None else '*non déclarée, comptée 0*'}  \n"
            f"= **FCF {usd(fcf)}**  \n"
            f"FCF / capitalisation → **{pct(c['fcf_yield'])}**"
        )
    with quality:
        if not c["quality_pass"]:
            verdict = "écartée"
        elif c["quality_unchecked"]:
            verdict = "non vérifiable"
        else:
            verdict = "passés"
        st.markdown(f"**Filtres de qualité : {verdict}**")
        st.markdown(
            f"Capitaux propres {usd(c['equity'])}  \n"
            f"ROCE = EBIT / (capitaux propres + dette nette) → "
            f"**{pct(c['roce'])}** (seuil {MIN_ROCE:.0%})  \n"
            f"Amortissements {usd(c['depreciation'])}  \n"
            f"Dette nette / EBITDA → **{ratio(c['net_debt_ebitda'])}** "
            f"(plafond {MAX_NET_DEBT_EBITDA:g})"
        )
    st.caption(
        "Percentiles dans l'univers valorisé (100 = le moins cher) : "
        f"EV/EBIT {ratio(c['pct_ev_ebit'], '{:.0f}')} · "
        f"FCF {ratio(c['pct_fcf_yield'], '{:.0f}')}"
    )

with st.expander("Méthodologie"):
    st.markdown(
        """
- **Univers** : actions ordinaires cotées au NYSE, NASDAQ ou NYSE American, en dollars,
  capitalisation ≥ 2 Md$. Finance, assurance et immobilier (SIC 6000-6799) sont exclus :
  l'EBIT et la dette n'y ont pas le même sens.
- **Secteurs** : proches des secteurs GICS, déduits du code SIC déclaré à la SEC (qui décrit
  des produits plutôt qu'un modèle économique : quelques sociétés tombent dans un secteur
  inattendu).
- **Fondamentaux** : 12 mois glissants jusqu'à la fin de la dernière période publiée (10-Q ou
  10-K), d'après les données XBRL de la SEC : dernier exercice + cumul de l'exercice en cours
  − même cumul un an plus tôt. Bilan à la fin de la période. Seuls les dépôts antérieurs à la
  date du snapshot sont pris en compte. L'EBIT est le résultat opérationnel, ou à défaut le
  résultat avant impôt augmenté des charges d'intérêts.
- **Dette** : dette financière à long terme (partie courante incluse), emprunts à court terme
  et billets de trésorerie. Une société qui ne déclare aucune dette est présumée sans dette si
  elle déclare des charges d'intérêts inférieures à 2 % de son EBIT (colonne dédiée) ; sinon
  elle n'est pas notée.
- **Free cash flow** : flux opérationnel − investissements − rémunération en actions (un coût
  réel que le flux opérationnel réintègre ; comptée 0 quand elle n'est pas déclarée).
- **Score** : moyenne des percentiles de deux mesures du prix (EV/EBIT bas, rendement FCF
  élevé), parmi les sociétés à EBIT et EV positifs. Une société dont l'une des deux mesures est
  incalculable n'est pas notée, plutôt que notée sur l'autre seule.
- **Filtres de qualité** : seules les sociétés au ROCE supérieur à 10 % et à la dette nette
  inférieure à 3 × l'EBITDA sont classées : la rentabilité ne compense donc pas un prix plus
  élevé. Un ratio incalculable n'écarte pas la société, qui est signalée.
- Les chiffres sont des mesures, pas des recommandations d'investissement.
"""
    )

unscored = snapshot.filter(pl.col("value_score").is_null())
with st.expander(f"Sociétés non notées ({unscored.height})"):
    st.dataframe(
        unscored.select("ticker", "name", "sector", "ebit", "debt", "cash", "period_end"),
        hide_index=True,
        width="stretch",
    )
