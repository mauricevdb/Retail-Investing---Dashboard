from pathlib import Path

import polars as pl
import streamlit as st

from ridash.config import SNAPSHOT_DIR

CURRENT_COLUMNS = {"period_end", "country", "quality_pass", "stock_compensation"}


@st.cache_data
def _read(path: Path) -> pl.DataFrame:
    return pl.read_parquet(path)


def latest_snapshot() -> pl.DataFrame:
    """The latest snapshot in the current format: older ones stay in the folder as a record of
    what was known at the time, but lack columns the pages use."""
    current = [
        path
        for path in sorted(SNAPSHOT_DIR.glob("*.parquet"))
        if set(pl.read_parquet_schema(path)) >= CURRENT_COLUMNS
    ]
    if not current:
        st.error("Aucun snapshot au format actuel. Lancer `python -m ridash.refresh`.")
        st.stop()
    return _read(current[-1])


def usd(value: float | None) -> str:
    """Amount for markdown ($ is escaped: Streamlit renders $...$ as LaTeX)."""
    if value is None:
        return "—"
    for size, unit in ((1e12, "T"), (1e9, "Md"), (1e6, "M")):
        if abs(value) >= size:
            return f"{value / size:,.1f} {unit}\\$"
    return f"{value:,.0f} \\$"


def ratio(value: float | None, pattern: str = "{:.1f}") -> str:
    return "—" if value is None else pattern.format(value)


def pct(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f} %"
