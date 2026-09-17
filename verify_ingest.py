import json
import urllib.request
from datetime import date
from pathlib import Path

import polars as pl

from dashboard.app.detail_view import trace_indicator
from dashboard.ingestion.edgar_client import EdgarClient
from dashboard.ingestion.edgar_facts import fetch_company_facts


def read_env(key: str) -> str:
    for line in Path(".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            name, _, value = line.partition("=")
            if name.strip() == key:
                return value.strip()
    raise SystemExit(f"{key} absente de .env")


def edgar_transport(url, headers):
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


edgar_client = EdgarClient(user_agent=read_env("SEC_USER_AGENT"), transport=edgar_transport)

CIK = "0001604028"  # Advanced Drainage Systems (WMS)
END = date(2016, 3, 31)  # même valeur que dans ingest_run.py
T = date(2017, 2, 1)  # même valeur que dans ingest_run.py

screen = pl.read_parquet("ingestion_output/screen_results.parquet")
row = screen.filter(pl.col("cik") == CIK).row(0, named=True)

facts = fetch_company_facts(edgar_client, CIK)

for indicator in ("ev_ebit", "fcf_yield", "roic", "net_debt_ebitda"):
    result = trace_indicator(facts, CIK, END, T, indicator, row[indicator])
    print(f"\n{indicator} = {row[indicator]}  (statut : {result['status']})")
    for component in result["components"]:
        print(" ", component)
