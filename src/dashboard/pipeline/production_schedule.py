from datetime import date, datetime, timedelta

from dashboard.calc.market_calendar import last_session

# Marge conservatrice entre la fin de la période de frames et t (ADR 0005) :
# identique à celle déjà appliquée par calc.candidate_pool.rank_candidates.
_MIN_LAG_DAYS = 120

_QUARTER_END_MONTH_DAY = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}


def derive_end(t: date) -> date:
    # Hypothèse d'exercice calendaire (majorité des grandes capis US),
    # déjà assumée par le lancement manuel de T89 : le dernier 31 décembre
    # strictement antérieur à `t` est toujours celui de l'année précédente,
    # quel que soit le mois de `t`.
    return date(t.year - 1, 12, 31)


def derive_frame_period(t: date) -> str:
    quarter = (t.month - 1) // 3 + 1
    year = t.year
    while True:
        quarter -= 1
        if quarter == 0:
            quarter = 4
            year -= 1
        month, day = _QUARTER_END_MONTH_DAY[quarter]
        end = date(year, month, day)
        if (t - end).days >= _MIN_LAG_DAYS:
            return f"CY{year}Q{quarter}I"


def derive_t(instant: datetime) -> date:
    # Un jour ouvré ne garantit pas que sa séance ait déjà fermé, ni
    # qu'EODHD ait déjà publié ses données de fin de journée pour elle
    # (constaté en direct, T95 : lancé avant l'ouverture de Wall Street,
    # EODHD renvoie 0 ligne pour la séance du jour même). Décaler d'une
    # journée calendaire avant d'appeler last_session garantit toujours au
    # moins une journée complète d'écart, quelle que soit l'heure de
    # l'instant -- même esprit que la marge de l'ADR 0005 : une marge
    # large et documentée plutôt qu'une modélisation fine et fragile des
    # fuseaux horaires et heures de clôture réelles.
    return last_session(instant - timedelta(days=1))
