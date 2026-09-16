import time
from collections.abc import Callable, Iterable

from dashboard.ingestion.secrets import redact


class EdgarClientError(Exception):
    pass


class EdgarClient:
    def __init__(
        self,
        user_agent: str,
        transport: Callable[[str, dict], dict | list],
        now: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        min_interval: float = 0.1,
        secrets: Iterable[str] = (),
        retries: int = 2,
        retry_delay: float = 1.0,
    ) -> None:
        self._user_agent = user_agent
        self._transport = transport
        self._now = now
        self._sleep = sleep
        self._min_interval = min_interval
        self._secrets = tuple(secrets)
        self._last_call: float | None = None
        self._retries = retries
        self._retry_delay = retry_delay

    def get_json(self, url: str) -> dict | list:
        current = self._now()
        if self._last_call is not None:
            wait = self._min_interval - (current - self._last_call)
            if wait > 0:
                self._sleep(wait)
        self._last_call = self._now()

        # Un incident réseau isolé (connexion fermée, DNS transitoire) ne
        # doit jamais annuler à lui seul un lancement de longue haleine
        # (~2000 appels à l'échelle de production) -- un nombre borné de
        # tentatives, jamais indéfini, avant de remonter l'échec comme
        # avant (T87).
        last_error: Exception | None = None
        for attempt in range(self._retries + 1):
            try:
                return self._transport(url, {"User-Agent": self._user_agent})
            except Exception as exc:
                last_error = exc
                if attempt < self._retries:
                    self._sleep(self._retry_delay)

        message = redact(str(last_error), self._secrets)
        raise EdgarClientError(message) from None
