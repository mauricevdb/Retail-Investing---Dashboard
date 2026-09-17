from datetime import date
from pathlib import Path

import polars as pl

from dashboard.calc.candidate_pool import rank_candidates
from dashboard.ingestion.edgar_client import EdgarClient
from dashboard.ingestion.edgar_facts import fetch_company_facts
from dashboard.ingestion.edgar_frames import fetch_shares_outstanding_frame
from dashboard.ingestion.edgar_submissions import fetch_submissions
from dashboard.ingestion.edgar_tickers import fetch_company_tickers
from dashboard.ingestion.eodhd_actions import fetch_bulk_actions
from dashboard.ingestion.eodhd_client import EodhdClient
from dashboard.ingestion.eodhd_prices import fetch_bulk_prices
from dashboard.pipeline.daily_run import run_daily


class IngestionSelectionError(Exception):
    pass


def _checkpoint_paths(checkpoint_dir: Path, t: date) -> tuple[Path, Path]:
    return (
        checkpoint_dir / f"sic_checkpoint_{t.isoformat()}.parquet",
        checkpoint_dir / f"facts_checkpoint_{t.isoformat()}.parquet",
    )


def _load_checkpoint(checkpoint_dir: Path, t: date) -> tuple[pl.DataFrame, pl.DataFrame] | None:
    sic_path, facts_path = _checkpoint_paths(checkpoint_dir, t)
    # Scindé par t (invariant 1) : un fichier de reprise d'un autre jour
    # n'est jamais réutilisé -- ses colonnes `as_of` refléteraient un t
    # différent de celui du lancement en cours. Simplement ignoré, jamais
    # une erreur (T96).
    if sic_path.exists() and facts_path.exists():
        return pl.read_parquet(sic_path), pl.read_parquet(facts_path)
    return None


def _write_checkpoint(
    checkpoint_dir: Path, t: date, sic_rows: list[pl.DataFrame], facts_frames: list[pl.DataFrame]
) -> None:
    sic_path, facts_path = _checkpoint_paths(checkpoint_dir, t)
    pl.concat(sic_rows).write_parquet(sic_path)
    pl.concat(facts_frames).write_parquet(facts_path)


def run_from_network(
    edgar_client: EdgarClient,
    eodhd_client: EodhdClient,
    t: date,
    end: date,
    universe_history_path: Path,
    hier_membership: set[str],
    ciks: list[str] | None = None,
    tickers: list[str] | None = None,
    frame_period: str | None = None,
    thresholds: dict[str, tuple[float | None, float | None]] | None = None,
    screen_history_path: Path | None = None,
    fundamentals_history_path: Path | None = None,
    n: int = 900,
    buffer: int = 100,
    discovery_buffer: int | None = None,
    plausible_range: tuple[int, int] = (700, 1100),
    own_history_by_cik: dict[str, list[tuple[int, float]]] | None = None,
    since_year: int = 2011,
    checkpoint_dir: Path | None = None,
    checkpoint_every: int = 25,
    fundamentals_snapshot_path: Path | None = None,
) -> str | None:
    if sum(mode is not None for mode in (ciks, tickers, frame_period)) != 1:
        raise IngestionSelectionError(
            "fournir exactement une méthode de sélection : ciks, tickers ou "
            "frame_period, jamais deux ni aucune"
        )

    ticker_cik = fetch_company_tickers(edgar_client, as_of=t)
    # Le bulk de prix sert aussi bien au classement approché (frame_period)
    # qu'au calcul des indicateurs plus bas -- un seul appel, jamais deux,
    # quel que soit le mode de sélection.
    _prices_raw, prices_adj = fetch_bulk_prices(eodhd_client, t)

    if frame_period is not None:
        # Découverte automatique du bassin (T83-T85, ADR 0005) : seuls les
        # candidats retenus après classement par capitalisation approchée
        # sont réellement ingérés ci-dessous -- jamais le bassin entier.
        # `ranked` porte déjà exactly un ticker par CIK (le plus capitalisé,
        # T86) -- le reprendre tel quel plutôt que refiltrer ticker_cik par
        # appartenance au CIK, qui redonnerait tous ses tickers (T88 : un
        # même CIK peut porter des dizaines de tickers, ex. Freddie Mac et
        # ses séries d'actions préférentielles).
        # La marge de découverte (combien de candidats sont réellement
        # ingérés) et la marge de l'univers final (hystérésis de
        # calc.universe) sont deux paramètres distincts (T89) : l'attrition
        # réelle par exclusion SIC (finance/assurance/immobilier, fonds)
        # dépasse largement ce qu'un buffer d'hystérésis a vocation à
        # absorber. Repli sur `buffer` si non fourni, pour ne rien changer
        # au comportement par défaut.
        effective_discovery_buffer = buffer if discovery_buffer is None else discovery_buffer
        shares_frame = fetch_shares_outstanding_frame(edgar_client, period=frame_period)
        ranked = rank_candidates(
            shares_frame, ticker_cik, prices_adj, t, n=n, buffer=effective_discovery_buffer
        )
        selected = ranked.select(["cik", "ticker"])
        missing: set[str] = set()
    elif ciks is not None:
        selected = ticker_cik.filter(pl.col("cik").is_in(ciks))
        missing = set(ciks) - set(selected["cik"].to_list())
        # Un CIK demandé peut porter plusieurs tickers dans company_tickers
        # (même cause qu'au-dessus, T88) : un seul retenu, jamais une
        # ingestion réelle répétée pour le même émetteur.
        # `maintain_order=True` (T96) : sans lui, l'ordre des lignes après
        # `unique()` n'est pas garanti par Polars -- l'ordre de traitement
        # des CIK dans la boucle ci-dessous en dépend directement (reprise
        # sur échec), un ordre instable rend un lancement interrompu
        # imprévisible d'une tentative à l'autre.
        selected = selected.unique(subset=["cik"], keep="first", maintain_order=True)
    else:
        selected = ticker_cik.filter(pl.col("ticker").is_in(tickers))
        missing = set(tickers) - set(selected["ticker"].to_list())

    if missing:
        raise IngestionSelectionError(f"non trouvés dans company_tickers : {sorted(missing)}")

    sic_rows = []
    facts_frames = []
    done_ciks: set[str] = set()

    if checkpoint_dir is not None:
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        loaded = _load_checkpoint(checkpoint_dir, t)
        if loaded is not None:
            checkpoint_sic, checkpoint_facts = loaded
            sic_rows.append(checkpoint_sic)
            facts_frames.append(checkpoint_facts)
            done_ciks = set(checkpoint_sic["cik"].to_list())

    # Un CIK déjà obtenu avant une panne réseau isolée n'est jamais
    # refetché après reprise : le coût réel d'une requête EDGAR (invariant
    # 10) ne doit jamais être payé deux fois pour le même travail (T96).
    since_last_checkpoint = 0
    for cik in selected["cik"].to_list():
        if cik in done_ciks:
            continue
        _filings, sic_row = fetch_submissions(edgar_client, cik, as_of=t)
        sic_rows.append(sic_row)
        facts_frames.append(fetch_company_facts(edgar_client, cik))

        if checkpoint_dir is not None:
            since_last_checkpoint += 1
            if since_last_checkpoint >= checkpoint_every:
                _write_checkpoint(checkpoint_dir, t, sic_rows, facts_frames)
                since_last_checkpoint = 0

    sic_codes = pl.concat(sic_rows).join(selected.select(["cik", "ticker"]), on="cik")
    facts = pl.concat(facts_frames)

    # Récupérées pour de vrai (T75), non consommées par daily_run dont la
    # signature reste figée -- signalé, pas masqué (cf. tasks.md T75).
    fetch_bulk_actions(eodhd_client, t)

    # Valeur de repli sans effet : écrasée par des actions en circulation
    # réellement dérivées des faits (pipeline.daily_run._derive_shares_pit,
    # T71) dès lors que facts est fourni, ce qui est toujours le cas ici.
    shares_pit = selected.select(["ticker", "cik"]).with_columns(
        pl.lit(0.0).alias("shares_outstanding")
    )

    result = run_daily(
        shares_pit=shares_pit,
        prices_adj=prices_adj,
        sic_codes=sic_codes,
        hier_membership=hier_membership,
        t=t,
        universe_history_path=universe_history_path,
        facts=facts,
        end=end,
        thresholds=thresholds,
        screen_history_path=screen_history_path,
        fundamentals_history_path=fundamentals_history_path,
        n=n,
        buffer=buffer,
        plausible_range=plausible_range,
        own_history_by_cik=own_history_by_cik,
        since_year=since_year,
    )

    if checkpoint_dir is not None:
        # Le lancement a abouti : les résultats durables vivent déjà dans
        # fundamentals_history_path/screen_history_path/
        # universe_history_path -- le fichier de reprise n'a plus
        # d'utilité pour ce t (T96).
        sic_path, facts_path = _checkpoint_paths(checkpoint_dir, t)
        sic_path.unlink(missing_ok=True)
        facts_path.unlink(missing_ok=True)

    if fundamentals_snapshot_path is not None:
        # Écrase à chaque lancement, jamais un cumul (contrairement à
        # fundamentals_history_path, append-only depuis T78) : l'historique
        # complet grossit indéfiniment (invariants 2/3) et ne peut pas être
        # commité dans un dépôt Git au fil des jours -- déjà 220 Mo pour
        # une seule journée de production (T98).
        # Filtré aux seuls titres réellement retenus dans le screen du
        # jour -- jamais l'ensemble du bassin de découverte (T89 : jusqu'à
        # ~1250 candidats réellement ingérés pour classer et exclure, très
        # supérieur aux quelques dizaines finalement retenues). La
        # plateforme déployée ne propose jamais de détailler un titre en
        # dehors du screen affiché (T80) -- un instantané portant tout le
        # bassin de découverte resterait lui-même trop volumineux (~65M
        # lignes, ~147 Mo mesurés en pratique, toujours au-dessus de la
        # limite GitHub), constaté en préparant le premier commit réel.
        if screen_history_path is not None and screen_history_path.exists():
            retained_ciks = (
                pl.read_parquet(screen_history_path).filter(pl.col("date") == t)["cik"].to_list()
            )
            facts.filter(pl.col("cik").is_in(retained_ciks)).write_parquet(
                fundamentals_snapshot_path
            )
        else:
            # Aucun screen final connu (usage T58 seul, cf. daily_run) :
            # impossible de filtrer, replier sur le bassin complet plutôt
            # que ne rien écrire.
            facts.write_parquet(fundamentals_snapshot_path)

    return result
