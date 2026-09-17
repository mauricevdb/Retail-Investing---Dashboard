from datetime import UTC, date, datetime

from dashboard.pipeline.production_schedule import derive_end, derive_frame_period, derive_t

_QUARTER_END_MONTH_DAY = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}
_QUARTER_ORDER = [(3, 31), (6, 30), (9, 30), (12, 31)]


def _quarter_end(frame_period: str) -> date:
    year = int(frame_period[2:6])
    quarter = int(frame_period[7])
    month, day = _QUARTER_END_MONTH_DAY[quarter]
    return date(year, month, day)


def _next_quarter_end(end: date) -> date:
    index = _QUARTER_ORDER.index((end.month, end.day))
    if index == 3:
        return date(end.year + 1, 3, 31)
    month, day = _QUARTER_ORDER[index + 1]
    return date(end.year, month, day)


def test_derive_end_is_last_full_calendar_year() -> None:
    # Hypothèse d'exercice calendaire, déjà assumée par ingest_run.py (T89) :
    # `end` doit être le dernier 31 décembre strictement antérieur à `t`,
    # jamais celui de l'année en cours, quel que soit le mois de `t`.
    for t in (date(2026, 1, 5), date(2026, 6, 15), date(2026, 12, 31)):
        assert derive_end(t) == date(t.year - 1, 12, 31)


def test_derive_frame_period_respects_120_day_lag() -> None:
    # ADR 0005 : la période de frames retenue doit être le dernier trimestre
    # calendaire dont la fin précède `t` d'au moins 120 jours -- jamais un
    # trimestre plus récent (qui violerait le seuil), jamais un trimestre
    # plus ancien que nécessaire (qui appauvrirait le classement sans raison).
    for t in (date(2026, 9, 15), date(2026, 1, 10), date(2026, 5, 1), date(2026, 12, 31)):
        frame_period = derive_frame_period(t)
        end = _quarter_end(frame_period)

        assert end < t
        assert (t - end).days >= 120

        # Le trimestre suivant, plus récent, doit violer le seuil -- sinon
        # `derive_frame_period` n'a pas renvoyé le dernier trimestre valide.
        next_end = _next_quarter_end(end)
        assert (t - next_end).days < 120


def test_derive_t_never_targets_the_current_day() -> None:
    # Trouvé en tentant le premier lancement réel de T94 (T95) : un jour
    # ouvré ne garantit pas que sa séance ait déjà fermé, ni qu'EODHD ait
    # déjà publié ses données de fin de journée -- même juste après minuit
    # UTC, bien avant l'ouverture de Wall Street. `derive_t` ne doit donc
    # jamais viser le jour même, quelle que soit l'heure de l'instant.
    for instant in (
        datetime(2026, 9, 17, 0, 5, tzinfo=UTC),  # jeudi, juste après minuit
        datetime(2026, 9, 17, 8, 57, tzinfo=UTC),  # jeudi, avant l'ouverture US
        datetime(2026, 9, 17, 23, 55, tzinfo=UTC),  # jeudi, tard le soir
    ):
        assert derive_t(instant) != instant.date()
        assert derive_t(instant) < instant.date()


def test_derive_t_skips_weekend() -> None:
    # Un lundi matin doit renvoyer le vendredi précédent -- jamais une
    # séance de week-end, cohérent avec market_calendar.last_session.
    monday_morning = datetime(2026, 9, 21, 6, 0, tzinfo=UTC)
    assert derive_t(monday_morning) == date(2026, 9, 18)
