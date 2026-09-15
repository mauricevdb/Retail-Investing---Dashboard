# ADR 0005 — Classement approché du bassin de candidats via l'API frames

Date : 2026-09-15
Statut : accepté

## Contexte

T81 a confirmé que `calc.universe`/`pipeline.daily_run` fonctionnent
correctement à l'échelle cible (~900-1100 titres) sur une fixture
synthétique, mais a aussi rappelé qu'aucun mécanisme n'existe pour
*découvrir* ce bassin automatiquement : `pipeline.ingest.run_from_network`
(T75) exige une liste explicite de `ciks`/`tickers`. Classer par
capitalisation boursière suppose de connaître les actions en circulation
d'un nombre de candidats bien plus grand que 900-1100 — un appel
`fetch_company_facts` par candidat serait inenvisageable à l'échelle de
tout le bassin SEC (potentiellement des milliers d'appels à 10 req/s,
invariant 10).

T83 a construit et vérifié en direct un client pour l'API frames de SEC
EDGAR (`data.sec.gov/api/xbrl/frames/...`), qui renvoie un concept XBRL
donné (ici `dei:EntityCommonStockSharesOutstanding`) pour tous les
émetteurs l'ayant déposé sur une période donnée, en un seul appel — 4960
émetteurs obtenus pour `CY2024Q1I` lors de la vérification. Mais la
réponse ne porte que `accn`, `cik`, `end`, `entityName`, `loc`, `val` —
**aucune date de dépôt (`filed`)**. L'invariant 1 de CLAUDE.md (« une
donnée fondamentale n'est utilisable en date `t` que si sa date de dépôt
est antérieure ou égale à `t` ») ne peut donc pas être vérifié directement
sur les données de frames.

## Décision

Les données de frames servent **uniquement à classer et présélectionner**
les candidats à ingérer réellement (via les fonctions `fetch_*` déjà
existantes, T14-T18) — **jamais à calculer ou afficher un indicateur**.
Une fois un candidat retenu, ses indicateurs réels repassent toujours par
la chaîne stricte `calc.point_in_time.resolve`/`resolve_detail`, qui
vérifie `filed <= t` comme partout ailleurs dans la tranche. L'absence de
`filed` dans frames n'affecte donc jamais un chiffre affiché à l'écran —
seulement la composition du bassin de candidats retenu pour un jour donné.

Pour limiter le risque qu'une valeur de frames ne soit pas encore
publique à `t`, seule une période de frames dont la fin (`end`) précède
`t` d'au moins **120 jours** est utilisée. Justification du seuil : un
10-Q doit être déposé sous 40 à 45 jours après la fin de trimestre, un
10-K sous 60 à 90 jours selon la catégorie de déposant — 120 jours laisse
une marge large au-delà même des déposants les plus lents dans le cas
courant. Ce n'est **pas** une garantie absolue par émetteur (un dépôt très
en retard, prorogation Rule 12b-25, reste possible) : c'est une
approximation probabiliste, documentée comme telle, dont la conséquence
en cas d'échec reste bornée à une composition de bassin légèrement
imprécise — jamais une donnée fondamentale mal datée affichée à
l'utilisateur, jamais un nombre faux.

## Conséquences

- Le module qui consomme frames (à construire) doit exposer explicitement
  la période choisie et son décalage par rapport à `t`, jamais un choix
  opaque — cohérent avec l'invariant 7 (paramètre de modélisation déclaré,
  jamais caché).
- Un émetteur entré en bourse ou ayant changé de calendrier fiscal très
  récemment peut être absent du classement approché pendant un cycle,
  jusqu'à ce qu'une période de frames suffisamment ancienne couvre son
  premier dépôt — auto-corrigé au traitement suivant, jamais une exclusion
  permanente.
- `etat-de-tranche.md` doit consigner ce choix comme une dette assumée
  documentée, pas une lacune non traitée.

## Alternatives écartées

- **Vérifier `filed` via `fetch_submissions` pour chaque candidat
  présélectionné par frames** — reporté, pas rejeté : reste une option si
  le décalage de 120 jours se révèle insuffisant en pratique (un appel de
  plus par candidat déjà présélectionné, pas par tout le bassin, donc
  encore raisonnable) ; non retenu pour cette première itération afin de
  garder le pipeline simple.
- **Abandonner l'approche frames** — rejeté : sans elle, la découverte
  automatique du bassin resterait bloquée par le coût d'un appel par
  candidat sur l'ensemble du bassin SEC, un obstacle plus grave que
  l'imprécision bornée du décalage conservateur.
