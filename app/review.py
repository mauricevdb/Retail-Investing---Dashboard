import json
from datetime import UTC, datetime

import polars as pl
import streamlit as st

from app.common import latest_snapshot, pct, ratio
from ridash.config import DECISIONS_FILE, REVIEW_MODEL
from ridash.review import VERDICT_LABELS, latest_review, read_decisions, with_decisions

CONFIDENCE = {"low": "Faible", "medium": "Moyenne", "high": "Élevée"}
TONE = {"negative": "Négatif", "mixed": "Mitigé", "neutral": "Neutre", "positive": "Positif"}
NATURE = {"structural": "durable", "temporary": "temporaire", "uncertain": "incertain"}
DECISION = {"keep": "Garder", "exclude": "Écarter"}

reviewed = latest_review()
st.title("Revue qualitative de la shortlist")
if reviewed is None:
    st.info(
        "Aucune revue disponible. Ajouter `ANTHROPIC_API_KEY` dans `.env`, puis lancer "
        "`uv run --env-file .env python -m ridash.review`."
    )
    st.stop()

as_of = reviewed["date"][0]
screen_date = latest_snapshot()["date"][0]
st.caption(
    f"Les {reviewed.height} premières actions du screen au {as_of:%d/%m/%Y}. {REVIEW_MODEL} lit "
    "leurs news récentes (EODHD), leurs dépôts SEC des 12 derniers mois et l'évolution du cours, "
    "puis juge si la décote est expliquée. Ses verdicts sont des suggestions : la décision te "
    f"revient. Coût de cette revue : {reviewed['cost_usd'].sum():.2f} $."
)
if screen_date != as_of:
    st.warning(f"Le screen date du {screen_date:%d/%m/%Y} : la revue n'est pas à jour.")

reviewed = with_decisions(reviewed, read_decisions())
failed = reviewed.filter(pl.col("verdict").is_null())
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
table = reviewed.select(
    "rank",
    "ticker",
    "name",
    "sector",
    "value_score",
    pl.col("verdict").replace_strict(VERDICT_LABELS, default=None).alias("verdict"),
    pl.col("confidence").replace_strict(CONFIDENCE, default=None).alias("confidence"),
    pl.col("news_tone").replace_strict(TONE, default=None).alias("news_tone"),
    (pl.col("ret_12m") * 100).alias("ret_12m"),
    (pl.col("drawdown") * 100).alias("drawdown"),
    "sec_red_flags",
    pl.col("suggestion").replace_strict(DECISION, default=None).alias("suggestion"),
    pl.col("decision").replace_strict(DECISION, default=None).alias("decision"),
)
edited = st.data_editor(
    table,
    hide_index=True,
    width="stretch",
    disabled=[c for c in table.columns if c != "decision"],
    column_config={
        "rank": st.column_config.NumberColumn("#", format="%d"),
        "ticker": "Ticker",
        "name": "Société",
        "sector": "Secteur",
        "value_score": st.column_config.NumberColumn("Score value", format="%.0f"),
        "verdict": "Verdict",
        "confidence": "Confiance",
        "news_tone": "Ton des news",
        "ret_12m": st.column_config.NumberColumn("Cours 12 mois", format="%+.0f %%"),
        "drawdown": st.column_config.NumberColumn("Écart au plus haut", format="%.0f %%"),
        "sec_red_flags": st.column_config.NumberColumn("Alertes SEC", format="%d"),
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
    f"{changed.height} modification(s) non enregistrée(s). Les décisions sont écrites dans "
    "`data/decisions.parquet` : commite ce fichier pour les retrouver dans l'app en ligne."
)

# ---------------------------------------------------------------- detail
st.subheader("Détail d'une analyse")
ticker = st.selectbox(
    "Action",
    reviewed["ticker"].to_list(),
    format_func=lambda t: f"{t} · {reviewed.filter(pl.col('ticker') == t)['name'][0]}",
)
r = reviewed.filter(pl.col("ticker") == ticker).row(0, named=True)
sources = {s["id"]: s for s in json.loads(r["sources"])}


def cite(ids: list[str]) -> str:
    links = [f"[{i}]({sources[i]['url']})" for i in ids if i in sources]
    return " ".join(links)


if r["verdict"] is None:
    st.error(f"Pas de verdict : {r['error']}")
else:
    st.markdown(
        f"**{VERDICT_LABELS[r['verdict']]}** · confiance {CONFIDENCE[r['confidence']].lower()} · "
        f"suggestion : {DECISION[r['suggestion']].lower()} · analysé le {r['analysed_on']:%d/%m/%Y}"
    )
    st.write(r["summary"])
    left, right = st.columns([3, 2])
    with left:
        st.markdown("**Facteurs identifiés**")
        factors = json.loads(r["factors"])
        for factor in factors:
            nature = NATURE[factor["nature"]]
            st.markdown(f"- {factor['description']} *({nature})* {cite(factor['sources'])}")
        if not factors:
            st.markdown("Aucun facteur négatif identifié dans les sources.")
        red_flags = json.loads(r["red_flags"])
        if red_flags:
            st.markdown("**Signaux d'alerte**")
            for flag in red_flags:
                st.markdown(f"- {flag}")
    with right:
        st.markdown("**Comportement du marché**")
        st.markdown(
            f"Cours sur 1 mois {pct(r['ret_1m'])}, 3 mois {pct(r['ret_3m'])}, "
            f"12 mois {pct(r['ret_12m'])} (S&P 500 : {pct(r['spy_12m'])})  \n"
            f"Écart au plus haut sur un an : {pct(r['drawdown'])}  \n"
            f"Sentiment des news sur 30 jours (EODHD, −1 à 1) : "
            f"{ratio(r['sentiment_30d'], '{:.2f}')} ({r['news_30d'] or 0} articles)"
        )

with st.expander(f"Sources lues ({len(sources)})"):
    for source in sources.values():
        st.markdown(
            f"- **{source['id']}** · {source['date']} · {source['kind']} · "
            f"[{source['title']}]({source['url']})"
        )
