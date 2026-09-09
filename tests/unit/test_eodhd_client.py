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

    failing_transport = FakeTransport(error=ConnectionError("boom"))
    failing_client = EodhdClient(api_key="fake-eodhd-key", transport=failing_transport)
    with pytest.raises(EodhdClientError):
        failing_client.get_json("https://eodhd.com/api/eod-bulk-last-day/US")
