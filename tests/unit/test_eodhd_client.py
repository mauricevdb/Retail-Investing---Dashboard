import pytest

from dashboard.ingestion.eodhd_client import EodhdClient, EodhdClientError


class FakeTransport:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def __call__(self, url, params):
        self.calls.append({"url": url, "params": params})
        if self.error is not None:
            raise self.error
        return self.response


def test_eodhd_client_authenticates_and_raises_on_failure() -> None:
    transport = FakeTransport(response=[{"code": "AAAA"}])
    client = EodhdClient(api_key="fake-eodhd-key", transport=transport)

    result = client.get_json("https://eodhd.com/api/eod-bulk-last-day/US")

    assert result == [{"code": "AAAA"}]
    assert transport.calls[0]["params"]["api_token"] == "fake-eodhd-key"
    # L'endpoint bulk renvoie du CSV par défaut (découvert par le test de
    # contact, T20) : fmt=json doit être demandé explicitement à chaque
    # appel, pas seulement quand ça échoue en silence côté client.
    assert transport.calls[0]["params"]["fmt"] == "json"

    failing_transport = FakeTransport(error=ConnectionError("boom"))
    failing_client = EodhdClient(
        api_key="fake-eodhd-key", transport=failing_transport, sleep=lambda seconds: None
    )
    with pytest.raises(EodhdClientError):
        failing_client.get_json("https://eodhd.com/api/eod-bulk-last-day/US")


class FlakyTransport:
    def __init__(self, fail_times: int, response=None):
        self.fail_times = fail_times
        self.response = response
        self.calls = 0

    def __call__(self, url, params):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ConnectionError("panne transitoire")
        return self.response


def test_eodhd_client_retries_transient_failure_then_succeeds() -> None:
    transport = FlakyTransport(fail_times=2, response=[{"code": "AAAA"}])
    retry_sleeps = []

    client = EodhdClient(
        api_key="fake-eodhd-key",
        transport=transport,
        sleep=retry_sleeps.append,
        retries=2,
        retry_delay=1.0,
    )

    result = client.get_json("https://eodhd.com/api/eod-bulk-last-day/US")

    assert result == [{"code": "AAAA"}]
    assert transport.calls == 3  # 1 essai initial + 2 tentatives
    assert retry_sleeps == [pytest.approx(1.0), pytest.approx(1.0)]


def test_eodhd_client_stops_retrying_after_exhausting_attempts() -> None:
    transport = FlakyTransport(fail_times=10, response=[{"code": "AAAA"}])

    client = EodhdClient(
        api_key="fake-eodhd-key",
        transport=transport,
        sleep=lambda seconds: None,
        retries=2,
        retry_delay=1.0,
    )

    with pytest.raises(EodhdClientError):
        client.get_json("https://eodhd.com/api/eod-bulk-last-day/US")

    assert transport.calls == 3  # 1 essai initial + 2 tentatives, jamais plus
