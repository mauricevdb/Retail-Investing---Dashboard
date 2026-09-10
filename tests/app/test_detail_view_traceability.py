import json
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.app.detail_view import trace_indicator, trace_percentile
from dashboard.ingestion.edgar_facts import parse_company_facts

GOLDEN = Path(__file__).parent.parent / "golden" / "raw" / "edgar_companyfacts_0000000001.json"


def _facts() -> pl.DataFrame:
    with open(GOLDEN, encoding="utf-8") as f:
        return parse_company_facts(json.load(f))


def test_every_displayed_number_traceable() -> None:
    facts = _facts()
    cik = "0000000001"
    end = date(2023, 12, 31)
    t = date(2024, 3, 1)

    # Alpha résout tous ses indicateurs au tag primaire : chaque composante
    # tracée doit porter le rang de repli 1, avec end/filed/accn connus.
    for indicator in ("ev_ebit", "fcf_yield", "roic", "net_debt_ebitda"):
        trace = trace_indicator(facts, cik, end, t, indicator)
        assert len(trace) > 0
        for component in trace:
            assert component["end"] == end
            assert component["filed"] is not None
            assert component["accn"] is not None
            assert component["rank"] == 1

    # Les deux percentiles se tracent jusqu'à leur formule, pas un tag.
    own_history_trace = trace_percentile(
        "own_history", historical_values=[(2023, 5.3)], since_year=2011, t_year=2023
    )
    assert "formula" in own_history_trace
    assert "inputs" in own_history_trace
    assert "window" in own_history_trace

    sector_trace = trace_percentile("sector", sector_values=[1.0] * 10)
    assert "formula" in sector_trace
    assert "inputs" in sector_trace
    assert "population" in sector_trace
