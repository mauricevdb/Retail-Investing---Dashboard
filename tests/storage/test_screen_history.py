from datetime import date
from pathlib import Path

import polars as pl
import pytest

from dashboard.storage.screen_history import ScreenHistoryAlreadyWrittenError, append


def test_screen_history_never_rewritten(tmp_path: Path) -> None:
    path = tmp_path / "screen_results.parquet"

    day1 = pl.DataFrame(
        {"date": [date(2024, 2, 15)], "cik": ["0000000001"], "ev_ebit": [5.0]}
    )
    append(path, day1)
    assert pl.read_parquet(path).height == 1

    # Second appel pour la même date et le même titre : refus explicite,
    # jamais un écrasement silencieux.
    with pytest.raises(ScreenHistoryAlreadyWrittenError):
        append(path, day1)

    # Le fichier reste inchangé après le refus.
    assert pl.read_parquet(path).height == 1
