from pathlib import Path

import streamlit as st

st.set_page_config(page_title="RI Dashboard", layout="wide")

pages = [
    st.Page("app/screen.py", title="Screen value", icon=":material/search:", default=True),
    st.Page("app/review.py", title="Revue qualitative", icon=":material/fact_check:"),
    st.Page("app/portfolio.py", title="Portefeuille efficient", icon=":material/donut_large:"),
]
# The commands need the secrets of the .env file, which exists only on the owner's machine: the
# hosted app shows the data but cannot run anything.
if (Path(__file__).parent / ".env").exists():
    pages.append(st.Page("app/commands.py", title="Mise à jour", icon=":material/sync:"))
st.navigation(pages, position="top").run()
