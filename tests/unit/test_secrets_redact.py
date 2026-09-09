from dashboard.ingestion.secrets import redact


def test_redact_masks_configured_secret() -> None:
    secret = "sk-fake-test-key-12345"
    text = f"GET https://eodhd.com/api/eod?api_token={secret}&fmt=json failed"

    result = redact(text, secrets=[secret])

    assert secret not in result
    assert "[REDACTED]" in result

    unrelated = "GET https://data.sec.gov/api/xbrl/companyfacts/CIK1.json failed"
    assert redact(unrelated, secrets=[secret]) == unrelated
