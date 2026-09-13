import json
import urllib.request
from pathlib import Path

import pytest

from dashboard.ingestion.edgar_client import EdgarClient

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


def _real_transport(url: str, headers: dict) -> dict | list:
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


@pytest.mark.contact
def test_edgar_contact_company_tickers_reachable() -> None:
    user_agent = _read_env("SEC_USER_AGENT")
    assert user_agent, "SEC_USER_AGENT absent ou vide dans .env"

    client = EdgarClient(user_agent=user_agent, transport=_real_transport)

    raw = client.get_json("https://www.sec.gov/files/company_tickers.json")

    # Accessibilité et forme de la réponse seulement (invariant 9 amendé) --
    # jamais une valeur de cotation ou de dépôt précise.
    assert isinstance(raw, dict)
    assert len(raw) > 0

    first_entry = next(iter(raw.values()))
    assert "cik_str" in first_entry
    assert "ticker" in first_entry
    assert "title" in first_entry
