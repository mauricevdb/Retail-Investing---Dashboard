import logging
import traceback

import pytest

from dashboard.ingestion.edgar_client import EdgarClient, EdgarClientError
from dashboard.ingestion.eodhd_client import EodhdClient, EodhdClientError


class FailingTransport:
    def __init__(self, message: str) -> None:
        self.message = message

    def __call__(self, *args, **kwargs):
        raise ConnectionError(self.message)


def test_no_api_key_in_logs_or_errors(caplog) -> None:
    secret = "sk-fake-test-key-98765"
    url_with_secret = f"https://eodhd.com/api/eod-bulk-last-day/US?api_token={secret}"
    raw_failure = f"HTTPError: GET {url_with_secret} timed out"

    caplog.set_level(logging.DEBUG)

    edgar_client = EdgarClient(
        user_agent="RI Dashboard test@example.com",
        transport=FailingTransport(raw_failure),
        now=lambda: 0.0,
        sleep=lambda seconds: None,
        secrets=[secret],
    )
    with pytest.raises(EdgarClientError) as edgar_exc_info:
        edgar_client.get_json(url_with_secret)

    eodhd_client = EodhdClient(api_key=secret, transport=FailingTransport(raw_failure))
    with pytest.raises(EodhdClientError) as eodhd_exc_info:
        eodhd_client.get_json(url_with_secret)

    for exc_info in (edgar_exc_info, eodhd_exc_info):
        assert secret not in str(exc_info.value)
        formatted = "".join(traceback.format_exception(exc_info.type, exc_info.value, exc_info.tb))
        assert secret not in formatted

    assert secret not in caplog.text
