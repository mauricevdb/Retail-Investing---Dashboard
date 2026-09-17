import json
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from dashboard.ingestion.edgar_client import EdgarClient
from dashboard.ingestion.eodhd_client import EodhdClient
from dashboard.pipeline.ingest import run_from_network
from dashboard.pipeline.production_schedule import derive_end, derive_frame_period, derive_t


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

# t/end/frame_period dérivés automatiquement (T94, T95) -- plus aucune
# valeur codée en dur : ce script doit pouvoir tourner seul, à intervalles
# réguliers, sans intervention (invariant 5 : jamais date.today() nu), et
# ne jamais viser une séance pas encore fermée ni publiée (T95).
t = derive_t(datetime.now(UTC))
end = derive_end(t)
frame_period = derive_frame_period(t)

view_text = run_from_network(
    edgar_client=edgar_client,
    eodhd_client=eodhd_client,
    t=t,
    end=end,
    universe_history_path=output_dir / "universe_membership.parquet",
    hier_membership=set(),
    frame_period=frame_period,
    thresholds={},  # aucun seuil : tout titre calculable est retenu
    screen_history_path=output_dir / "screen_results.parquet",
    fundamentals_history_path=output_dir / "fundamentals_raw.parquet",
    n=900,
    buffer=100,  # marge de l'univers final -- hystérésis, inchangée (T89)
    discovery_buffer=800,  # marge de découverte élargie -- compense
    # l'attrition SIC réelle (~38 % mesurée, T88-T89)
    plausible_range=(700, 1100),  # plage par défaut de production, non réduite
)

print(view_text)
