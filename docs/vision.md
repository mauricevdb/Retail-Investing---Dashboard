# Vision

Un tableau de bord personnel d'aide à la décision d'investissement, couvrant à
terme devises, matières premières, crypto et actions, et pour chaque marché
plusieurs familles d'opportunités : value, mean reversion, momentum, stat arb.

## Ce que ce projet est

Un outil d'exploration et d'apprentissage, construit tranche verticale par
tranche verticale, chacune allant de l'ingestion de données jusqu'à l'écran.

## Ce que ce projet n'est pas

- Un système d'exécution. Aucun ordre n'est passé, jamais.
- Un conseil en investissement. Le tableau de bord affiche des mesures, pas
  des recommandations.
- Un backtest de stratégie. Une tranche peut produire un backtest, mais il
  fera l'objet d'une spec dédiée avec ses propres garde-fous.

## Ordre des tranches

| N° | Tranche | État |
|----|---------|------|
| 0001 | Value investing — actions américaines | en cours |
| 0002 | à définir | — |

Une seule tranche ouverte à la fois.

## Note sur la rubrique « momentum / accumulation institutionnelle »

Repérer des phases d'accumulation institutionnelle suppose des données de flux
d'ordres inaccessibles au particulier, ou des dépôts 13F trimestriels, en
retard d'un trimestre et limités aux positions longues américaines. Cette
rubrique ne sera spécifiée que le jour où ses critères d'acceptation pourront
être rendus falsifiables. Sinon elle produirait un écran convaincant et faux.
