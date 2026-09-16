from datetime import date

import polars as pl

# Marge conservatrice entre la fin de la période de frames et t (ADR 0005) :
# frames ne porte aucune date de dépôt, donc aucun moyen direct de vérifier
# l'invariant 1 sur ses données. 120 jours dépasse largement les délais de
# dépôt SEC (10-Q sous 40-45 jours, 10-K sous 60-90 jours).
_MIN_LAG_DAYS = 120


class FramePeriodTooRecentError(Exception):
    pass


def rank_candidates(
    shares_frame: pl.DataFrame,
    ticker_cik: pl.DataFrame,
    prices_adj: pl.DataFrame,
    t: date,
    n: int = 900,
    buffer: int = 100,
) -> pl.DataFrame:
    frame_end = shares_frame["end"].max()
    lag_days = (t - frame_end).days
    if lag_days < _MIN_LAG_DAYS:
        raise FramePeriodTooRecentError(
            f"période de frames trop récente : fin {frame_end}, t={t} "
            f"({lag_days} jours d'écart, {_MIN_LAG_DAYS} requis, cf. ADR 0005)"
        )

    with_ticker = shares_frame.join(ticker_cik.select(["cik", "ticker"]), on="cik")

    latest_price = (
        prices_adj.filter(pl.col("date") <= t)
        .sort("date", descending=True)
        .group_by("ticker", maintain_order=True)
        .first()
        .select(["ticker", "close_adj"])
    )

    merged = with_ticker.join(latest_price, on="ticker").with_columns(
        (pl.col("value") * pl.col("close_adj")).alias("approx_market_cap")
    )

    # Un émetteur à plusieurs tickers (classes d'actions multiples, ex.
    # GOOG/GOOGL) porte plusieurs lignes après la jointure ci-dessus --
    # chacune consommerait sa propre place à la coupure sans cette étape,
    # au détriment d'émetteurs distincts qui auraient dû être retenus à la
    # place (trouvé en tentant un vrai lancement à l'échelle de production,
    # T85/T86). Un seul CIK par ligne avant de classer et couper : celle de
    # capitalisation la plus haute.
    deduplicated = (
        merged.sort("approx_market_cap", descending=True)
        .group_by("cik", maintain_order=True)
        .first()
    )

    ranked = deduplicated.sort("approx_market_cap", descending=True).with_row_index(
        name="rank", offset=1
    )
    return ranked.filter(pl.col("rank") <= n + buffer)
