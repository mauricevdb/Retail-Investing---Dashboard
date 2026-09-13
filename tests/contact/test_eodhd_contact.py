import json
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

from dashboard.ingestion.eodhd_client import EodhdClient

_ENV_PATH = Path(__file__).parent.parent.parent / ".env"


def _read_env(key: str) -> str | None:
    if not _ENV_PATH.exists():
        return None
    for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        if name.strip() == key:
            return value.strip()
    return None


def _real_transport(url: str, params: dict) -> dict | list:
    # La clé voyage en paramètre de requête (contrat d'EodhdClient), jamais
    # en en-tête : elle ne doit jamais apparaître ailleurs que dans cette
    # URL construite ici, jamais affichée ni journalisée par ce test.
    full_url = f"{url}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(full_url)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


@pytest.mark.contact
def test_eodhd_contact_bulk_endpoint_reachable() -> None:
    api_key = _read_env("EODHD_API_KEY")
    assert api_key, "EODHD_API_KEY absente ou vide dans .env"

    client = EodhdClient(api_key=api_key, transport=_real_transport)

    raw = client.get_json("https://eodhd.com/api/eod-bulk-last-day/US")

    # Accessibilité et forme de la réponse seulement (invariant 9 amendé) --
    # jamais une valeur de cours réelle.
    assert isinstance(raw, list)
    assert len(raw) > 0

    first_entry = raw[0]
    assert "code" in first_entry
    assert "date" in first_entry
    assert "close" in first_entry
