# ADR 0001 — Sources de données de la tranche 0001

Date : 2026-09-09
Statut : accepté

## Contexte

Le value investing exige des données fondamentales *point-in-time* : pour
évaluer un signal en date `t`, il faut savoir ce qui était publiquement connu
en `t`. Les fournisseurs commerciaux facturent cher cette caractéristique.
Budget disponible : environ 30 €/mois.

## Décision

- **Fondamentaux** : API XBRL de la SEC (`data.sec.gov`), gratuite. Chaque fait
  porte sa date de dépôt (`filed`) et son numéro d'accession (`accn`), ce qui
  donne le point-in-time nativement. Contraintes : 10 requêtes/seconde,
  User-Agent identifiant obligatoire.
- **Prix, actions sur titres, titres délistés** : EODHD, offre EOD All World.
  Couvre les délistés et les changements de ticker, donc le biais du survivant.
- **Univers** : actions américaines uniquement.

## Conséquences

- L'Europe est hors périmètre de la tranche 0001 : il n'existe pas
  d'équivalent gratuit d'EDGAR pour les émetteurs européens.
- Le stockage des fondamentaux doit porter `(concept, end, filed, accn, value)`
  et non une simple valeur par période.
- Un même exercice peut apparaître plusieurs fois avec des valeurs différentes
  (retraitements). C'est voulu, ce n'est pas un doublon à dédupliquer.
- La taxonomie `dei` (Document and Entity Information) est retenue au même
  titre que `us-gaap` : elle porte des faits présents dans tous les dépôts
  américains normaux (dont les actions en circulation), et n'est pas
  spécifique aux émetteurs IFRS. L'exclusion IFRS porte sur la catégorie
  d'émetteurs, non sur les taxonomies retenues en stockage.

## Alternatives écartées

- Fournisseur unique tout-en-un : le point-in-time des fondamentaux n'est
  disponible que sur des offres nettement au-dessus du budget.
- Sources gratuites non contractuelles de type scraping : conditions
  d'utilisation incertaines et rupture silencieuse des formats.
