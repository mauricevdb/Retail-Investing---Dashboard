from datetime import date
from pathlib import Path

import polars as pl
import pytest

from dashboard.pipeline.daily_run import run_daily
from dashboard.storage.universe_history import UniverseHistoryAlreadyWrittenError


def test_daily_run_repeated_calls_write_distinct_dates(tmp_path: Path) -> None:
    # Bug réel trouvé en ingestion réelle (T75) : run_daily ne portait
    # jamais de colonne "date" sur membership avant de l'ajouter à
    # storage.universe_history -- invisible tant qu'un seul appel écrivait
    # dans un fichier neuf (aucun test existant n'appelait run_daily deux
    # fois sur le même chemin). Un second appel plantait
    # (ColumnNotFoundError: "date", requise par le garde anti-doublon de
    # T68) au lieu d'ajouter simplement une deuxième ligne, comme l'exige
    # le critère 22.
    ticker, cik = "ZZZQ", "0000000201"
    shares_pit = pl.DataFrame([{"ticker": ticker, "cik": cik, "shares_outstanding": 1_000_000.0}])
    sic_codes = pl.DataFrame(
        [{"ticker": ticker, "sic": "7372", "entity_type": "operating", "as_of": date(2024, 1, 1)}]
    )
    universe_history_path = tmp_path / "universe_membership.parquet"

    for t in (date(2024, 3, 1), date(2024, 3, 4)):
        prices_adj = pl.DataFrame([{"ticker": ticker, "date": t, "close_adj": 10.0}])
        run_daily(
            shares_pit=shares_pit,
            prices_adj=prices_adj,
            sic_codes=sic_codes,
            hier_membership=set(),
            t=t,
            universe_history_path=universe_history_path,
            plausible_range=(1, 1),
        )

    membership = pl.read_parquet(universe_history_path)
    assert set(membership["date"].to_list()) == {date(2024, 3, 1), date(2024, 3, 4)}
    assert membership.height == 2


def test_daily_run_repeated_call_same_date_rejected(tmp_path: Path) -> None:
    # Le garde anti-doublon (date, cik) de storage.universe_history (T68)
    # n'avait jamais été exercé via daily_run lui-même, seulement au niveau
    # du stockage isolé -- vérifié ici sur le chemin réel.
    ticker, cik = "ZZZQ", "0000000201"
    shares_pit = pl.DataFrame([{"ticker": ticker, "cik": cik, "shares_outstanding": 1_000_000.0}])
    sic_codes = pl.DataFrame(
        [{"ticker": ticker, "sic": "7372", "entity_type": "operating", "as_of": date(2024, 1, 1)}]
    )
    t = date(2024, 3, 1)
    prices_adj = pl.DataFrame([{"ticker": ticker, "date": t, "close_adj": 10.0}])
    universe_history_path = tmp_path / "universe_membership.parquet"

    run_daily(
        shares_pit=shares_pit,
        prices_adj=prices_adj,
        sic_codes=sic_codes,
        hier_membership=set(),
        t=t,
        universe_history_path=universe_history_path,
        plausible_range=(1, 1),
    )

    with pytest.raises(UniverseHistoryAlreadyWrittenError):
        run_daily(
            shares_pit=shares_pit,
            prices_adj=prices_adj,
            sic_codes=sic_codes,
            hier_membership=set(),
            t=t,
            universe_history_path=universe_history_path,
            plausible_range=(1, 1),
        )
