from collections.abc import Callable

from dashboard.ingestion.secrets import redact


class EodhdClientError(Exception):
    pass


class EodhdClient:
    def __init__(
        self,
        api_key: str,
        transport: Callable[[str, dict], dict | list],
    ) -> None:
        self._api_key = api_key
        self._transport = transport

    def get_json(self, url: str) -> dict | list:
        try:
            return self._transport(url, {"api_token": self._api_key, "fmt": "json"})
        except Exception as exc:
            message = redact(str(exc), [self._api_key])
            raise EodhdClientError(message) from None
