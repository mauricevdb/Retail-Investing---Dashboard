import json
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

from dashboard.ingestion.edgar_client import EdgarClient
from dashboard.ingestion.eodhd_client import EodhdClient
from dashboard.pipeline.ingest import run_from_network


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


def eodhd_transport(url, params):
    separator = "&" if "?" in url else "?"
    full_url = f"{url}{separator}{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(full_url)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


edgar_client = EdgarClient(user_agent=read_env("SEC_USER_AGENT"), transport=edgar_transport)
eodhd_client = EodhdClient(api_key=read_env("EODHD_API_KEY"), transport=eodhd_transport)

output_dir = Path("ingestion_output")
output_dir.mkdir(exist_ok=True)

view_text = run_from_network(
    edgar_client=edgar_client,
    eodhd_client=eodhd_client,
    t=date(2026, 9, 15),  # aujourd'hui -- premier essai à l'échelle de production
    end=date(2025, 12, 31),  # exercice calendaire -- la majorité des grandes capis US
    universe_history_path=output_dir / "universe_membership.parquet",
    hier_membership=set(),
    frame_period="CY2025Q4I",  # vérifié en direct : 2638 entrées réelles
    thresholds={},  # aucun seuil : tout titre calculable est retenu
    screen_history_path=output_dir / "screen_results.parquet",
    fundamentals_history_path=output_dir / "fundamentals_raw.parquet",
    n=900,
    buffer=100,  # marge de l'univers final -- hystérésis, inchangée (T89)
    discovery_buffer=800,  # marge de découverte élargie -- ~1700 candidats
    # réels ingérés, pour compenser l'attrition SIC réelle (~38 % mesurée)
    plausible_range=(700, 1100),  # plage par défaut de production, non réduite
)

print(view_text)
