import time
from collections.abc import Callable

from dashboard.ingestion.secrets import redact


class EodhdClientError(Exception):
    pass


class EodhdClient:
    def __init__(
        self,
        api_key: str,
        transport: Callable[[str, dict], dict | list],
        sleep: Callable[[float], None] = time.sleep,
        retries: int = 2,
        retry_delay: float = 1.0,
    ) -> None:
        self._api_key = api_key
        self._transport = transport
        self._sleep = sleep
        self._retries = retries
        self._retry_delay = retry_delay

    def get_json(self, url: str) -> dict | list:
        # Un incident réseau isolé ne doit jamais annuler à lui seul un
        # lancement de longue haleine (T87) -- un nombre borné de
        # tentatives, jamais indéfini, avant de remonter l'échec comme
        # avant.
        last_error: Exception | None = None
        for attempt in range(self._retries + 1):
            try:
                return self._transport(url, {"api_token": self._api_key, "fmt": "json"})
            except Exception as exc:
                last_error = exc
                if attempt < self._retries:
                    self._sleep(self._retry_delay)

        message = redact(str(last_error), [self._api_key])
        raise EodhdClientError(message) from None
