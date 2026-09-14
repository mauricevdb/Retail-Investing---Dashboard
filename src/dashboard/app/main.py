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

# `end` (fin d'exercice) n'est porté par aucun fichier persisté -- c'est un
# paramètre du run (pipeline.ingest.run_from_network), pas une donnée par
# titre (cf. T77, point tranché avant implémentation). Paramètre de
# modélisation au sens de l'invariant 7 amendé : jamais codé en dur,
# toujours affiché là où il influence un chiffre.
default_end = date(t.year, 12, 31)
end: date = st.sidebar.date_input("Exercice de référence (end)", value=default_end)
st.caption(f"Exercice de référence utilisé pour la trace détaillée : {end}")

st.text(render_screen_text(retained_count=screen.height))
st.dataframe(screen)

tickers = screen["ticker"].to_list()
if tickers:
    selected = st.selectbox("Titre à détailler", tickers)
    selected_row = screen.filter(pl.col("ticker") == selected).row(0, named=True)
    facts = read_facts_for_cik(fundamentals_path, selected_row["cik"])

    for indicator in _INDICATORS:
        result = trace_indicator(
            facts, selected_row["cik"], end, t, indicator, selected_row.get(indicator)
        )
        st.subheader(indicator)
        st.code(str(result))
