import gzip
import http.client
import json
import time
import urllib.error
import urllib.request


def get(
    url: str,
    headers: dict[str, str] | None = None,
    retries: int = 5,
    missing: tuple[int, ...] = (404,),
) -> bytes | None:
    """GET a document. Returns None for the `missing` status codes; retries rate limits and
    transient errors."""
    request = urllib.request.Request(url, headers=headers or {})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body
        except urllib.error.HTTPError as error:
            if error.code in missing:
                return None
            retryable = error.code == 429 or error.code >= 500
            if not retryable or attempt == retries - 1:
                raise
        except (OSError, http.client.HTTPException):  # network errors, dropped connections
            if attempt == retries - 1:
                raise
        time.sleep(2**attempt)


def get_json(url: str, headers: dict[str, str] | None = None, retries: int = 5):
    body = get(url, headers, retries)
    return None if body is None else json.loads(body)
