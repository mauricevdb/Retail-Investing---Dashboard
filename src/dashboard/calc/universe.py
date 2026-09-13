from datetime import date

import polars as pl


def resolve_sic_as_of(sic_codes: pl.DataFrame, t: date) -> pl.DataFrame:
    return (
        sic_codes.filter(pl.col("as_of") <= t)
        .sort("as_of", descending=True)
        .group_by("ticker", maintain_order=True)
        .first()
    )


def apply_exclusions(sic_codes: pl.DataFrame) -> pl.DataFrame:
    # "operating" est la vraie valeur renvoyée par l'API SEC pour
    # entityType (vérifié en ingestion réelle, T75) -- "operating company"
    # n'existe nulle part dans les vraies réponses.
    is_operating_company = sic_codes["entity_type"] == "operating"

    # cast non strict : un émetteur sans SIC assigné (fonds réglementé, BDC
    # -- vérifié sur un cas réel, entityType y vaut aussi "operating") doit
    # être traité comme non éligible, jamais planter ni être inclus par
    # défaut (invariant 7). Un SIC absent devient null, qui rend
    # in_finance_insurance_real_estate et sa négation également nulles :
    # filter() exclut alors la ligne, comme une valeur manquante le doit.
    sic_numeric = sic_codes["sic"].cast(pl.Int64, strict=False)
    in_finance_insurance_real_estate = (sic_numeric >= 6000) & (sic_numeric <= 6799)

    return sic_codes.filter(~in_finance_insurance_real_estate & is_operating_company)


def rank_by_smoothed_market_cap(
    shares_pit: pl.DataFrame, prices_adj: pl.DataFrame, t: date, window: int = 20
) -> pl.DataFrame:
    recent = prices_adj.filter(pl.col("date") <= t).with_columns(
        pl.col("date").rank(method="ordinal", descending=True).over("ticker").alias("_recency")
    )
    windowed = recent.filter(pl.col("_recency") <= window)

    smoothed = windowed.group_by("ticker").agg(
        pl.col("close_adj").mean().alias("market_cap_smoothed")
    )
    market_cap = smoothed.join(shares_pit, on="ticker").with_columns(
        (pl.col("market_cap_smoothed") * pl.col("shares_outstanding")).alias("market_cap_smoothed")
    )

    return market_cap.sort("market_cap_smoothed", descending=True).with_row_index(
        name="rank", offset=1
    )


def apply_hysteresis(
    ranked: pl.DataFrame, hier_membership: set[str], n: int = 900, buffer: int = 100
) -> pl.DataFrame:
    was_member = pl.col("ticker").is_in(list(hier_membership))
    in_universe = (was_member & (pl.col("rank") <= n + buffer)) | (
        ~was_member & (pl.col("rank") <= n - buffer)
    )
    return ranked.with_columns(in_universe.alias("in_universe"))


class UniverseImplausibleSizeError(Exception):
    pass


def universe(
    shares_pit: pl.DataFrame,
    prices_adj: pl.DataFrame,
    sic_codes: pl.DataFrame,
    hier_membership: set[str],
    t: date,
    n: int = 900,
    buffer: int = 100,
    window: int = 20,
    plausible_range: tuple[int, int] = (700, 1100),
) -> pl.DataFrame:
    resolved_sic = resolve_sic_as_of(sic_codes, t)
    eligible_tickers = apply_exclusions(resolved_sic)["ticker"].to_list()
    eligible_shares = shares_pit.filter(pl.col("ticker").is_in(eligible_tickers))
    eligible_prices = prices_adj.filter(pl.col("ticker").is_in(eligible_tickers))

    ranked = rank_by_smoothed_market_cap(eligible_shares, eligible_prices, t, window=window)
    membership = apply_hysteresis(ranked, hier_membership, n=n, buffer=buffer)

    member_count = membership.filter(pl.col("in_universe")).height
    low, high = plausible_range
    if not (low <= member_count <= high):
        raise UniverseImplausibleSizeError(
            f"taille de l'univers ({member_count}) hors de la plage plausible {plausible_range}"
        )

    return membership
