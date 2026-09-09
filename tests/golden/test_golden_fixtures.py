import json
from pathlib import Path

RAW = Path(__file__).parent / "raw"


def _load(name: str) -> dict | list:
    with open(RAW / name, encoding="utf-8") as f:
        return json.load(f)


def test_golden_fixtures_load() -> None:
    # Correspondance ticker -> CIK, base pour tous les autres cas.
    tickers = _load("edgar_company_tickers.json")
    ciks = {str(row["cik_str"]) for row in tickers.values()}
    assert {"1", "2", "3", "4"} <= ciks

    # Cas 1 : émetteur normal (Alpha, CIK 1) avec un OperatingIncomeLoss exploitable.
    alpha_facts = _load("edgar_companyfacts_0000000001.json")
    operating_income = alpha_facts["facts"]["us-gaap"]["OperatingIncomeLoss"]["units"]["USD"]
    assert len(operating_income) >= 1
    assert operating_income[0]["val"] > 0

    # Cas 2 : retraitement -- deux dépôts pour le même concept et le même
    # exercice (`end`), avec des `filed`/`accn`/`val` différents.
    net_income = alpha_facts["facts"]["us-gaap"]["NetIncomeLoss"]["units"]["USD"]
    same_end = [row for row in net_income if row["end"] == "2023-12-31"]
    assert len(same_end) == 2
    assert len({row["accn"] for row in same_end}) == 2
    assert len({row["filed"] for row in same_end}) == 2
    assert len({row["val"] for row in same_end}) == 2

    # Cas 3 : émetteur IFRS (Beta, CIK 2) -- aucun fait `us-gaap`.
    beta_facts = _load("edgar_companyfacts_0000000002.json")
    assert "us-gaap" not in beta_facts["facts"]
    assert "ifrs-full" in beta_facts["facts"]

    # Cas 4 : émetteur SIC 6000-6799 (Gamma, CIK 3).
    gamma_submissions = _load("edgar_submissions_0000000003.json")
    assert 6000 <= int(gamma_submissions["sic"]) <= 6799

    # Cas 5 : émetteur fonds/ETF (Delta, CIK 4) -- nature non opérationnelle.
    delta_submissions = _load("edgar_submissions_0000000004.json")
    assert delta_submissions["entityType"] != "operating company"

    # Cas 6 : fractionnement -- l'action Alpha (AAAA) a un split enregistré,
    # et le cours ajusté reste continu autour de la date d'effet alors que
    # le cours brut, lui, ne l'est pas.
    actions = _load("eodhd_bulk_actions_2024-02-15.json")
    splits = [row for row in actions if row["code"] == "AAAA" and "split" in row]
    assert len(splits) == 1

    prices = _load("eodhd_bulk_prices_2024-02-15.json")
    aaaa_prices = sorted(
        (row for row in prices if row["code"] == "AAAA"), key=lambda row: row["date"]
    )
    assert len(aaaa_prices) == 2
    before, after = aaaa_prices
    assert before["close"] != after["close"]
    assert before["adjusted_close"] != before["close"]
    assert after["adjusted_close"] == after["close"]
