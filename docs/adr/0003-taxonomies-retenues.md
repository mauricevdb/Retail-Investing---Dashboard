# ADR 0003 — Taxonomies retenues en stockage : liste blanche `{us-gaap, dei}`

Date : 2026-09-09
Statut : accepté

## Contexte

L'ADR 0001 exclut les émetteurs déposant en IFRS de la tranche 0001 (décision
D2 de research.md). L'implémentation de T18 (chaîne de repli des actions en
circulation, `calc.shares_bridge`) a montré que le tag de couverture
`dei:EntityCommonStockSharesOutstanding` appartient à la taxonomie `dei`,
distincte de `us-gaap`. `parse_company_facts` (T5) ne lisait que la clé
`us-gaap` de `companyfacts`, ce qui excluait `dei` pour tous les émetteurs,
pas seulement les émetteurs IFRS : le tag primaire de la chaîne des actions en
circulation n'aurait jamais atteint `fundamentals_raw.parquet`.

L'exclusion IFRS et le filtrage des taxonomies retenues en stockage sont deux
décisions distinctes que la formulation initiale de l'ADR 0001 confondait.
Cet ADR précise l'ADR 0001 sans le modifier : les ADR passés sont immuables
(CLAUDE.md, « Ne pas toucher »).

## Décision

`ingestion.edgar_facts` retient une liste blanche de taxonomies, `{us-gaap,
dei}`, plutôt qu'un filtre unique sur `us-gaap` ou une exclusion d'`ifrs-full`.
Toute taxonomie hors de cette liste, connue ou non, est rejetée. Le nombre de
faits rejetés est compté par taxonomie et rapporté au même titre que le taux
de couverture des indicateurs (critère 11 de spec.md, invariant 7 de
CLAUDE.md) : un rejet silencieux et non comptabilisé serait indiscernable
d'une simple absence de données.

L'exclusion des émetteurs IFRS (décision D2, ADR 0001) porte sur la catégorie
d'émetteurs, pas sur les taxonomies retenues en stockage : un émetteur
`ifrs-full` ne dépose aucun fait `us-gaap` ni `dei` reconnu par la liste
blanche et produit donc naturellement zéro ligne, sans qu'un filtre dédié à
son cas soit nécessaire.

## Conséquences

- La taxonomie `dei` (Document and Entity Information) est retenue au même
  titre que `us-gaap` : elle porte des faits présents dans tous les dépôts
  américains normaux (dont les actions en circulation), et n'est pas
  spécifique aux émetteurs IFRS.
- `fundamentals_raw.parquet` peut contenir des lignes `taxonomy = "dei"`, à
  distinguer des lignes `us-gaap` mais soumises aux mêmes exigences
  point-in-time (invariant 2).
- Toute nouvelle taxonomie à retenir (une extension future hors du périmètre
  actuel) exige une mise à jour explicite de cette liste blanche, jamais une
  extension implicite par retrait d'un filtre d'exclusion.

## Alternatives écartées

- **Filtre d'exclusion sur `ifrs-full` plutôt que liste blanche** : c'est la
  formulation initialement retenue, invalidée par T18 — elle laisse passer
  implicitement toute taxonomie non explicitement exclue, y compris une
  taxonomie inconnue ou mal orthographiée, sans qu'aucun rejet ne soit
  visible ni compté.
- **Filtre unique sur `us-gaap`** : c'est le bug corrigé par cet ADR — exclut
  `dei` pour tous les émetteurs, pas seulement les émetteurs IFRS, alors que
  `dei` porte des faits nécessaires (actions en circulation) pour des
  émetteurs par ailleurs parfaitement dans le périmètre de la tranche.
