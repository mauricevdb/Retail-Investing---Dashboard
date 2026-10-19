import json
import time
import urllib.error
import urllib.request


def get_json(url: str, headers: dict[str, str] | None = None, retries: int = 5):
    """GET a JSON document. Returns None on 404; retries rate limits and transient errors."""
    request = urllib.request.Request(url, headers=headers or {})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            retryable = error.code == 429 or error.code >= 500
            if not retryable or attempt == retries - 1:
                raise
        except urllib.error.URLError:
            if attempt == retries - 1:
                raise
        time.sleep(2**attempt)
