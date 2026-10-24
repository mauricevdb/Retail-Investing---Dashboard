"""Bring the data up to date: snapshot of the last session, its review, then a reproducibility
test of that review unless one was already made. Each step does nothing when its file exists.

    uv run --env-file .env python -m ridash.update

The review and the test count against the Claude plan's usage limits.
"""

import subprocess
import sys

from ridash.review import latest_review
from ridash.stability import STABILITY_DIR


def run(module: str) -> None:
    """Run one command in its own process and stop the update if it fails."""
    print(f"== {module}", flush=True)
    code = subprocess.run([sys.executable, "-m", module]).returncode
    if code != 0:
        raise SystemExit(f"{module} failed (exit code {code})")


def main() -> None:
    run("ridash.refresh")
    run("ridash.review")
    as_of = latest_review()["date"][0]
    if (STABILITY_DIR / f"{as_of.isoformat()}.parquet").exists():
        print(f"{as_of}: reproducibility already tested, nothing to do")
    else:
        run("ridash.stability")


if __name__ == "__main__":
    main()
