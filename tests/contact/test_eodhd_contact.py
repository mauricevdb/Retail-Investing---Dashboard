import json
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

import pytest

from dashboard.ingestion.eodhd_actions import fetch_bulk_actions
from dashboard.ingestion.eodhd_client import EodhdClient
from dashboard.ingestion.eodhd_prices import fetch_bulk_prices

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
    # `url` porte déjà `?date=...` ou `?type=...&date=...` pour
    # fetch_bulk_prices/fetch_bulk_actions : ne jamais écraser cette
    # première requête en supposant `?` toujours disponible.
    separator = "&" if "?" in url else "?"
    full_url = f"{url}{separator}{urllib.parse.urlencode(params)}"
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


@pytest.mark.contact
def test_eodhd_bulk_prices_honors_requested_date() -> None:
    api_key = _read_env("EODHD_API_KEY")
    assert api_key, "EODHD_API_KEY absente ou vide dans .env"

    client = EodhdClient(api_key=api_key, transport=_real_transport)

    # Deux jours de bourse distincts, choisis sans autre propriété que
    # d'être différents : si `date=` était ignoré, les deux appels
    # renverraient la même date (celle du dernier jour de bourse connu).
    first_date = date(2024, 2, 14)
    second_date = date(2024, 2, 15)

    prices_raw_first, _ = fetch_bulk_prices(client, first_date)
    prices_raw_second, _ = fetch_bulk_prices(client, second_date)

    assert set(prices_raw_first["date"].to_list()) == {first_date}
    assert set(prices_raw_second["date"].to_list()) == {second_date}


@pytest.mark.contact
def test_eodhd_bulk_actions_type_splits_returns_known_split() -> None:
    api_key = _read_env("EODHD_API_KEY")
    assert api_key, "EODHD_API_KEY absente ou vide dans .env"

    client = EodhdClient(api_key=api_key, transport=_real_transport)

    # NVDA : fractionnement 10 pour 1, effectif le 2024-06-10 -- fait
    # public documenté, utilisé uniquement pour vérifier que le paramètre
    # type=splits renvoie bien des opérations sur titres reconnaissables
    # par parse_corporate_actions, pas une autre forme de donnée
    # (invariant 9 amendé : contrat de paramètre, pas logique métier).
    actions = fetch_bulk_actions(client, date(2024, 6, 10))

    nvda_rows = actions.filter(actions["ticker"] == "NVDA")
    assert nvda_rows.height == 1
    nvda = nvda_rows.row(0, named=True)
    assert nvda["action_type"] == "split"
    assert nvda["ratio_or_amount"] == 10.0
