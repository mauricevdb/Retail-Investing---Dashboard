import pytest

from dashboard.ingestion.edgar_client import EdgarClient, EdgarClientError


class FakeTransport:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append({"url": url, "headers": headers})
        if self.error is not None:
            raise self.error
        return self.response


class FakeClock:
    def __init__(self, start=0.0):
        self.time = start

    def now(self):
        return self.time


def test_edgar_client_user_agent_throttle_and_explicit_failure() -> None:
    transport = FakeTransport(response={"ok": True})
    clock = FakeClock()
    sleeps = []

    client = EdgarClient(
        user_agent="RI Dashboard test@example.com",
        transport=transport,
        now=clock.now,
        sleep=sleeps.append,
        min_interval=0.1,
    )

    result = client.get_json("https://data.sec.gov/x.json")
    assert result == {"ok": True}
    assert transport.calls[0]["headers"]["User-Agent"] == "RI Dashboard test@example.com"
    assert sleeps == []

    client.get_json("https://data.sec.gov/y.json")
    assert sleeps == [pytest.approx(0.1)]

    failing_transport = FakeTransport(error=ConnectionError("boom"))
    failing_client = EdgarClient(
        user_agent="RI Dashboard test@example.com",
        transport=failing_transport,
        now=clock.now,
        sleep=lambda seconds: None,
        min_interval=0.1,
    )
    with pytest.raises(EdgarClientError):
        failing_client.get_json("https://data.sec.gov/z.json")
