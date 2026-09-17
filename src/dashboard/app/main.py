import os
from datetime import date
from pathlib import Path

import polars as pl
import streamlit as st

from dashboard.app.detail_view import trace_indicator
from dashboard.app.screen_view import render_screen_text
from dashboard.storage.duckdb_reader import (
    ScreenResultsUnavailableError,
    read_facts_for_cik,
    read_latest_screen,
)

# Point d'entrée Streamlit, en lecture seule via DuckDB (plan.md, section
# Présentation) : lit ce que pipeline.daily_run/pipeline.ingest ont déjà
# persisté, ne recalcule jamais rien lui-même (T57-T63, T75 restent seuls
# responsables du calcul).
_INDICATORS = ("ev_ebit", "fcf_yield", "roic", "net_debt_ebitda")

screen_results_path = Path(
    os.environ.get("DASHBOARD_SCREEN_RESULTS_PATH", "ingestion_output/screen_results.parquet")
)
fundamentals_path = Path(
    os.environ.get("DASHBOARD_FUNDAMENTALS_PATH", "ingestion_output/fundamentals_raw.parquet")
)

st.title("RI Dashboard — value investing, actions américaines")

try:
    screen = read_latest_screen(screen_results_path)
except ScreenResultsUnavailableError as error:
    st.error(f"Aucun résultat de screen disponible : {error}")
    st.stop()

t: date = screen["date"][0]

st.text(render_screen_text(retained_count=screen.height))
st.dataframe(screen)

tickers = screen["ticker"].to_list()
if tickers:
    selected = st.selectbox("Titre à détailler", tickers)
    selected_row = screen.filter(pl.col("ticker") == selected).row(0, named=True)
    facts = read_facts_for_cik(fundamentals_path, selected_row["cik"])

    # `end` (fin d'exercice) n'est porté par aucun fichier persisté -- c'est
    # un paramètre du run (pipeline.ingest.run_from_network), pas une donnée
    # par titre (cf. T77). Un sélecteur libre laissait interroger un
    # exercice sans aucun rapport avec les faits réels du titre choisi,
    # rendant la trace obtenue dénuée de sens sans le signaler (T80,
    # invariant 7) : les options proposées sont donc contraintes aux
    # exercices réellement présents dans les faits de ce titre, jamais une
    # date arbitraire.
    available_ends = sorted(facts["end"].unique().to_list(), reverse=True)
    if not available_ends:
        st.error(f"Aucun exercice connu pour {selected} dans les faits persistés.")
        st.stop()

    # Le plus récent, toutes natures de faits confondues, n'a aucun rapport
    # garanti avec l'exercice réellement utilisé pour calculer les valeurs
    # déjà affichées dans le tableau -- constaté en direct sur FISV (T92) :
    # un fait de couverture (actions en circulation, instantané) porte
    # aussi fiscal_period="FY" à une date proche du dépôt, pas la fin
    # d'exercice ; un autre concept, réel mais rare, porte fiscal_period="FY"
    # alors que sa vraie durée est trimestrielle. Jamais confiance dans
    # l'étiquette seule (même principe que T90) : la durée réelle
    # (`end - start`) doit être proche d'un an, ni un fait instantané
    # (`start` absent) ni un fait de durée plus courte mal étiqueté.
    annual_facts = facts.filter(
        pl.col("start").is_not_null()
        & ((pl.col("end") - pl.col("start")).dt.total_days() >= 350)
        & ((pl.col("end") - pl.col("start")).dt.total_days() <= 380)
    )
    annual_ends = sorted(annual_facts["end"].unique().to_list(), reverse=True)
    default_index = available_ends.index(annual_ends[0]) if annual_ends else 0

    end: date = st.sidebar.selectbox(
        "Exercice de référence (end)", available_ends, index=default_index
    )
    st.caption(f"Exercice de référence utilisé pour la trace détaillée : {end}")

    for indicator in _INDICATORS:
        result = trace_indicator(
            facts, selected_row["cik"], end, t, indicator, selected_row.get(indicator)
        )
        st.subheader(indicator)
        st.code(str(result))
