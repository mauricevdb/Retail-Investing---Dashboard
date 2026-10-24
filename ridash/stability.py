"""Reproducibility of the qualitative review: the same evidence, analysed again.

Claude does not answer twice in exactly the same way. If a stock's trap risk moved by more
than the gap between the last stock kept and the first one excluded, the keep/exclude
suggestions would partly be chance. This asks Claude again, on exactly the briefs of the latest
review, and measures how far the scores move and how many suggestions would flip.

    uv run --env-file .env python -m ridash.stability [--stocks 10] [--runs 2]

It counts against the Claude plan's usage limits like the review: stocks × runs analyses.
"""

import argparse
import asyncio
import json

import polars as pl

from ridash.config import BRIEF_DIR, DATA_DIR
from ridash.review import CRITERIA, ask_all, latest_review, trap_risk, use_subscription

STABILITY_DIR = DATA_DIR / "stability"


def spread_sample(review: pl.DataFrame, count: int) -> pl.DataFrame:
    """`count` stocks evenly spread from the lowest to the highest trap risk, so that the
    stocks on both sides of the keep/exclude cut-off are represented."""
    analysed = review.filter(pl.col("trap_risk").is_not_null()).sort("trap_risk")
    if analysed.height <= count:
        return analysed
    step = (analysed.height - 1) / (count - 1)
    return analysed[[round(i * step) for i in range(count)]]


def cutoff(review: pl.DataFrame) -> float | None:
    """Midpoint between the highest trap risk kept and the lowest one excluded."""
    kept = review.filter(pl.col("suggestion") == "keep")["trap_risk"].max()
    excluded = review.filter(
        (pl.col("suggestion") == "exclude") & (pl.col("trap_risk") > (kept or 0))
    )["trap_risk"].min()
    if kept is None or excluded is None:
        return None
    return (kept + excluded) / 2


def compare(sample: pl.DataFrame, reruns: dict[str, list[dict]], cut: float | None) -> pl.DataFrame:
    """Per stock: the original trap risk, the risks of the reruns, their spread, the share of
    criteria scored identically, and whether a rerun lands on the other side of the cut-off."""
    rows = []
    for stock in sample.iter_rows(named=True):
        original = json.loads(stock["criteria"])
        risks = [trap_risk(criteria) for criteria in reruns.get(stock["ticker"], [])]
        same = [
            criteria[name]["score"] == original[name]["score"]
            for criteria in reruns.get(stock["ticker"], [])
            for name in CRITERIA
        ]
        every = [stock["trap_risk"], *risks]
        rows.append(
            {
                "ticker": stock["ticker"],
                "trap_risk": stock["trap_risk"],
                "reruns": risks,
                "spread": max(every) - min(every) if risks else None,
                "same_scores": sum(same) / len(same) if same else None,
                "flips": cut is not None
                and any((risk < cut) != (stock["trap_risk"] < cut) for risk in risks),
            }
        )
    return pl.DataFrame(rows, infer_schema_length=None)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stocks", type=int, default=10)
    parser.add_argument("--runs", type=int, default=2)
    args = parser.parse_args()

    review = latest_review()
    if review is None:
        raise SystemExit("no review to test: run python -m ridash.review first")
    as_of = review["date"][0]
    brief_file = BRIEF_DIR / f"{as_of.isoformat()}.parquet"
    if not brief_file.exists():
        raise SystemExit(f"no briefs saved for the {as_of} review: run the review again first")
    briefs = dict(pl.read_parquet(brief_file).select("ticker", "brief").iter_rows())

    # Only stocks analysed on that day: a reused verdict was based on an earlier brief.
    analysed = review.filter((pl.col("analysed_on") == as_of) & pl.col("criteria").is_not_null())
    sample = spread_sample(analysed, args.stocks)
    if sample.is_empty():
        print(f"{as_of}: every verdict was reused from an earlier review, nothing to test")
        return
    requests = [t for t in sample["ticker"] for _ in range(args.runs)]
    use_subscription()
    answers = asyncio.run(ask_all([briefs[t] for t in requests]))
    reruns: dict[str, list[dict]] = {}
    for ticker, (assessment, _, error) in zip(requests, answers, strict=True):
        if assessment is None:
            print(f"error {ticker}: {error}")
        else:
            reruns.setdefault(ticker, []).append(assessment["criteria"])

    cut = cutoff(review)
    result = compare(sample, reruns, cut)
    STABILITY_DIR.mkdir(parents=True, exist_ok=True)
    result.write_parquet(STABILITY_DIR / f"{as_of.isoformat()}.parquet")

    with pl.Config(tbl_rows=-1, tbl_formatting="ASCII_MARKDOWN", fmt_table_cell_list_len=10):
        print(result)
    print(
        f"{len(requests)} analyses on {sample.height} stocks of the {as_of} review | "
        f"trap-risk spread: median {result['spread'].median():.1f}, max "
        f"{result['spread'].max():.1f} points | criteria scored identically: "
        f"{result['same_scores'].mean():.0%} | keep/exclude cut-off "
        f"{'n/a' if cut is None else f'{cut:.1f}'}, crossed by {result['flips'].sum()} stock(s)"
    )


if __name__ == "__main__":
    main()
