from collections.abc import Callable


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
            return self._transport(url, {"api_token": self._api_key})
        except Exception as exc:
            raise EodhdClientError(str(exc)) from exc
