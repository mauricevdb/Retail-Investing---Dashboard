import os
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

import streamlit as st

from ridash.config import DATA_DIR, REVIEW_DIR, SNAPSHOT_DIR
from ridash.stability import STABILITY_DIR

ROOT = DATA_DIR.parent
LOG_DIR = DATA_DIR / "logs"
QUOTA = "Consomme le quota de l'abonnement Claude."


@st.cache_resource
def current_job() -> dict:
    """The command launched from the app, shared by every browser tab while the server runs:
    it keeps running when the page is closed."""
    return {}


def running() -> bool:
    job = current_job()
    return bool(job) and job["process"].poll() is None


def start(label: str, module: str, *args: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = LOG_DIR / f"{datetime.now():%Y-%m-%d_%H%M%S}_{module.split('.')[-1]}.log"
    # Unbuffered UTF-8 output, so that the log follows the command as it runs.
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
    with log.open("w", encoding="utf-8") as out:
        process = subprocess.Popen(
            [sys.executable, "-m", module, *args],
            cwd=ROOT,
            env=env,
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    current_job().update(label=label, process=process, log=log, started=datetime.now())


def latest_date(folder: Path) -> date | None:
    files = sorted(folder.glob("*.parquet"))
    return date.fromisoformat(files[-1].stem) if files else None


def tail(path: Path, lines: int = 40) -> str:
    return "".join(path.read_text(encoding="utf-8", errors="replace").splitlines(True)[-lines:])


st.title("Mise à jour des données")
st.caption(
    "Lance depuis l'app les commandes du terminal. Elles tournent en arrière-plan : la page peut "
    "être fermée. Une seule commande à la fois ; la tâche planifiée du matin n'apparaît pas ici."
)

snapshot, review, stability = (latest_date(d) for d in (SNAPSHOT_DIR, REVIEW_DIR, STABILITY_DIR))
status = st.columns(3)
status[0].metric("Dernier snapshot", f"{snapshot:%d/%m/%Y}" if snapshot else "—")
status[1].metric(
    "Dernière revue",
    f"{review:%d/%m/%Y}" if review else "—",
    "à jour" if review and review == snapshot else "en retard",
    delta_color="normal" if review == snapshot else "inverse",
    delta_arrow="off",
)
status[2].metric(
    "Dernier test de reproductibilité",
    f"{stability:%d/%m/%Y}" if stability else "—",
    "à jour" if stability and stability == review else "à faire",
    delta_color="normal" if stability == review else "inverse",
    delta_arrow="off",
)

busy = running()
everything, screen, reviewing, testing = st.columns(4)
with everything:
    st.markdown("**Tout mettre à jour**")
    st.caption(f"Snapshot, puis revue, puis test s'il n'a pas été fait pour cette revue. {QUOTA}")
    if st.button("Lancer", key="update", disabled=busy, type="primary"):
        start("Mise à jour complète", "ridash.update")
with screen:
    st.markdown("**Screen**")
    st.caption("Snapshot de la dernière séance. Ne fait rien s'il existe déjà.")
    if st.button("Lancer", key="refresh", disabled=busy):
        start("Rafraîchissement du screen", "ridash.refresh")
with reviewing:
    st.markdown("**Revue qualitative**")
    st.caption(f"Revue du dernier snapshot, environ une demi-heure. {QUOTA}")
    force = st.checkbox("La refaire si elle existe déjà", disabled=busy)
    if st.button("Lancer", key="review", disabled=busy):
        start("Revue qualitative", "ridash.review", *(["--force"] if force else []))
with testing:
    st.markdown("**Test de reproductibilité**")
    st.caption(f"Analyse à nouveau des actions de la dernière revue. {QUOTA}")
    stocks = st.number_input("Actions", 2, 50, 10, disabled=busy)
    runs = st.number_input("Analyses par action", 1, 5, 2, disabled=busy)
    if st.button("Lancer", key="stability", disabled=busy):
        start(
            "Test de reproductibilité",
            "ridash.stability",
            "--stocks",
            str(stocks),
            "--runs",
            str(runs),
        )
if not busy and running():  # a button was just clicked: show the buttons disabled
    st.rerun()


@st.fragment(run_every=2)
def progress() -> None:
    job = current_job()
    if not job:
        st.caption("Aucune commande lancée depuis le démarrage de l'app.")
        return
    code = job["process"].poll()
    started = f"{job['label']}, lancée à {job['started']:%H:%M:%S}"
    if code is None:
        elapsed = datetime.now() - job["started"]
        st.info(f"{started} : en cours depuis {elapsed.seconds // 60} min {elapsed.seconds % 60} s")
    elif code == 0:
        st.success(f"{started} : terminée.")
    else:
        st.error(f"{started} : échec (code {code}).")
    st.code(tail(job["log"]) or "…", language=None)
    st.caption(f"Journal complet : `{job['log'].relative_to(ROOT)}`")
    # Once the command ends, reload the whole page: dates and buttons change.
    if code is not None and st.session_state.get("ended") != job["started"]:
        st.session_state["ended"] = job["started"]
        st.rerun(scope="app")


st.subheader("Dernière commande")
progress()
