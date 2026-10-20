import json
from datetime import UTC, datetime

import polars as pl
import streamlit as st

from app.common import latest_snapshot, pct, ratio, usd
from ridash.config import (
    DECISIONS_FILE,
    EXPLAINED_RISK,
    KEEP_COUNT,
    PARTIAL_RISK,
    REVIEW_MODEL,
    TRAP_WEIGHTS,
)
from ridash.review import CRITERIA, VERDICT_LABELS, latest_review, read_decisions, with_decisions

CONFIDENCE = {"low": "faible", "medium": "moyenne", "high": "élevée"}
TONE = {"negative": "Négatif", "mixed": "Mitigé", "neutral": "Neutre", "positive": "Positif"}
DECISION = {"keep": "Garder", "exclude": "Écarter"}

reviewed = latest_review()
st.title("Revue qualitative de la shortlist")
if reviewed is None or "trap_risk" not in reviewed.columns:
    st.info(
        "Aucune revue au format actuel. Se connecter une fois à Claude Code (`claude`), puis "
        "lancer `uv run --env-file .env python -m ridash.review --force`."
    )
    st.stop()

as_of = reviewed["date"][0]
screen_date = latest_snapshot()["date"][0]
st.caption(
    f"Les {reviewed.height} premières actions du screen au {as_of:%d/%m/%Y}. {REVIEW_MODEL} lit "
    "pour chacune ses résultats trimestriels, son dernier communiqué de résultats, les "
    "transactions de ses dirigeants, les positions vendeuses à découvert, ses dépôts SEC et ses "
    "news, puis note six critères de 0 à 5. Leur somme pondérée donne le **risque de piège** "
    f"(0 à 100) : les {KEEP_COUNT} risques les plus faibles sont suggérés, hors décote "
    f"expliquée (risque ≥ {EXPLAINED_RISK}) ou critère critique. Analyse via Claude Code et "
    f"l'abonnement Claude : équivalent de {reviewed['cost_usd'].sum():.2f} $ au tarif de l'API, "
    "décompté du quota."
)
if screen_date != as_of:
    st.warning(f"Le screen date du {screen_date:%d/%m/%Y} : la revue n'est pas à jour.")

reviewed = with_decisions(reviewed, read_decisions())
failed = reviewed.filter(pl.col("trap_risk").is_null())
if failed.height:
    st.error(
        "Analyse impossible pour : "
        + ", ".join(f"{r['ticker']} ({r['error']})" for r in failed.iter_rows(named=True))
    )

cols = st.columns(4)
for col, (verdict, label) in zip(cols, VERDICT_LABELS.items(), strict=False):
    col.metric(label, reviewed.filter(pl.col("verdict") == verdict).height)
cols[3].metric("Gardées pour le portefeuille", reviewed.filter(pl.col("decision") == "keep").height)

# ---------------------------------------------------------------- decisions
table = reviewed.sort("trap_risk", nulls_last=True).select(
    "rank",
    "ticker",
    "name",
    "sector",
    "value_score",
    "trap_risk",
    pl.col("verdict").replace_strict(VERDICT_LABELS, default=None).alias("verdict"),
    (pl.col("revenue_yoy") * 100).alias("revenue_yoy"),
    (pl.col("operating_income_yoy") * 100).alias("operating_income_yoy"),
    (pl.col("short_pct") * 100).alias("short_pct"),
    (pl.col("insider_net") / 1e6).alias("insider_net"),
    (pl.col("ret_12m") * 100).alias("ret_12m"),
    pl.col("suggestion").replace_strict(DECISION, default=None).alias("suggestion"),
    pl.col("decision").replace_strict(DECISION, default=None).alias("decision"),
)
edited = st.data_editor(
    table,
    hide_index=True,
    width="stretch",
    disabled=[c for c in table.columns if c != "decision"],
    column_config={
        "rank": st.column_config.NumberColumn("# screen", format="%d"),
        "ticker": "Ticker",
        "name": "Société",
        "sector": "Secteur",
        "value_score": st.column_config.NumberColumn("Score value", format="%.0f"),
        "trap_risk": st.column_config.ProgressColumn(
            "Risque de piège", min_value=0, max_value=100, format="%.0f"
        ),
        "verdict": "Décote",
        "revenue_yoy": st.column_config.NumberColumn("CA dernier trim.", format="%+.0f %%"),
        "operating_income_yoy": st.column_config.NumberColumn(
            "Résultat op. dernier trim.", format="%+.0f %%"
        ),
        "short_pct": st.column_config.NumberColumn("Vente à découvert", format="%.1f %%"),
        "insider_net": st.column_config.NumberColumn("Dirigeants net (M$)", format="%+.1f"),
        "ret_12m": st.column_config.NumberColumn("Cours 12 mois", format="%+.0f %%"),
        "suggestion": "Suggestion",
        "decision": st.column_config.SelectboxColumn(
            "Décision", options=list(DECISION.values()), required=True
        ),
    },
)

changed = (
    pl.DataFrame(edited)
    .join(table.select("ticker", pl.col("decision").alias("before")), on="ticker")
    .filter(pl.col("decision") != pl.col("before"))
)
save, note = st.columns([1, 4])
if save.button("Enregistrer les décisions", disabled=changed.is_empty(), type="primary"):
    labels = {label: key for key, label in DECISION.items()}
    new = changed.select(
        "ticker",
        pl.col("decision").replace_strict(labels),
        pl.lit(datetime.now(UTC)).alias("decided_at"),
    )
    previous = read_decisions()
    (pl.concat([previous, new]) if previous is not None else new).write_parquet(DECISIONS_FILE)
    st.rerun()
note.caption(
    f"{changed.height} modification(s) non enregistrée(s). CA et résultat opérationnel : "
    "variation sur un an du dernier trimestre publié. Dirigeants : achats moins ventes sur six "
    "mois. Les décisions sont écrites dans `data/decisions.parquet` : commite ce fichier pour "
    "les retrouver dans l'app en ligne."
)

# ---------------------------------------------------------------- detail
st.subheader("Détail d'une analyse")
ticker = st.selectbox(
    "Action",
    table["ticker"].to_list(),
    format_func=lambda t: f"{t} · {reviewed.filter(pl.col('ticker') == t)['name'][0]}",
)
r = reviewed.filter(pl.col("ticker") == ticker).row(0, named=True)
sources = {s["id"]: s for s in json.loads(r["sources"])}


def cite(ids: list[str]) -> str:
    return " ".join(f"[{i}]({sources[i]['url']})" for i in ids if i in sources)


if r["trap_risk"] is None:
    st.error(f"Pas d'analyse : {r['error']}")
else:
    st.markdown(
        f"**Risque de piège {r['trap_risk']:.0f}/100** · {VERDICT_LABELS[r['verdict']].lower()} · "
        f"suggestion : {DECISION[r['suggestion']].lower()} · confiance "
        f"{CONFIDENCE[r['confidence']]} · analysé le {r['analysed_on']:%d/%m/%Y}"
    )
    st.write(r["summary"])
    st.markdown(f"**Le meilleur argument du marché** : {r['bear_case']}")

    criteria = json.loads(r["criteria"])
    grid = pl.DataFrame(
        [
            {
                "critère": CRITERIA[name][0],
                "poids": TRAP_WEIGHTS[name] * 100,
                "note": criteria[name]["score"],
                "justification": criteria[name]["rationale"],
                "sources": ", ".join(criteria[name]["sources"]),
            }
            for name in CRITERIA
        ]
    )
    st.dataframe(
        grid,
        hide_index=True,
        width="stretch",
        column_config={
            "critère": "Critère",
            "poids": st.column_config.NumberColumn("Poids", format="%.0f %%"),
            "note": st.column_config.ProgressColumn(
                "Note /5", min_value=0, max_value=5, format="%d"
            ),
            "justification": st.column_config.TextColumn("Justification", width="large"),
            "sources": "Sources",
        },
    )
    links = sorted({i for name in CRITERIA for i in criteria[name]["sources"]})
    st.caption(f"Sources citées : {cite(links) or 'aucune'}")

    left, right = st.columns(2)
    with left:
        red_flags = json.loads(r["red_flags"])
        st.markdown("**Signaux d'alerte**")
        for flag in red_flags:
            st.markdown(f"- {flag}")
        if not red_flags:
            st.markdown("Aucun.")
    with right:
        st.markdown("**Marché**")
        st.markdown(
            f"Cours sur 1 mois {pct(r['ret_1m'])}, 3 mois {pct(r['ret_3m'])}, 12 mois "
            f"{pct(r['ret_12m'])} (S&P 500 : {pct(r['spy_12m'])})  \n"
            f"Écart au plus haut sur un an : {pct(r['drawdown'])}  \n"
            f"Vente à découvert : {pct(r['short_pct'])} des actions "
            f"({pct(r['short_change'])} sur deux semaines), "
            f"{ratio(r['days_to_cover'])} jours de couverture  \n"
            f"Dirigeants, achats moins ventes sur six mois : {usd(r['insider_net'])}  \n"
            f"Ton des news : {TONE[r['news_tone']].lower()}"
        )

with st.expander(f"Sources lues ({len(sources)})"):
    for source in sources.values():
        st.markdown(
            f"- **{source['id']}** · {source['date']} · {source['kind']} · "
            f"[{source['title']}]({source['url']})"
        )
st.caption(
    f"Barème : critère noté de 0 (rien dans les sources) à 5 (critique, exclut l'action à lui "
    f"seul). Risque ≥ {PARTIAL_RISK} : décote partiellement expliquée ; ≥ {EXPLAINED_RISK} : "
    "expliquée."
)
