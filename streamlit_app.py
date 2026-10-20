import streamlit as st

st.set_page_config(page_title="RI Dashboard", layout="wide")

pages = [
    st.Page("app/screen.py", title="Screen value", icon=":material/search:", default=True),
    st.Page("app/review.py", title="Revue qualitative", icon=":material/fact_check:"),
    st.Page("app/portfolio.py", title="Portefeuille efficient", icon=":material/donut_large:"),
]
st.navigation(pages, position="top").run()
