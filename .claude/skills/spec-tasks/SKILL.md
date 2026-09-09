---
name: spec-tasks
description: Découpe un plan validé en tâches ordonnées, chacune testable isolément. À utiliser après approbation de plan.md.
---

# Découpage en tâches

## Contrat

Entrée : `plan.md` validé.
Sortie : `docs/specs/<NNNN>-<slug>/tasks.md`.

## Règles de découpage

- Une tâche produit une valeur vérifiable seule. « Créer un fichier vide »
  n'est pas une tâche.
- Une tâche tient dans un seul test qui la valide. Si deux tests sans rapport
  sont nécessaires, ce sont deux tâches.
- L'ordre suit le flux de données : ingestion, stockage, calcul, affichage.
  Pas d'interface avant que les données existent.
- La première tâche de toute tranche est la constitution de l'instantané figé
  dans `tests/golden/`. Sans lui, rien n'est vérifiable.

## Format par tâche

```markdown
### T<n> — <titre à l'impératif>
- **Objectif** : une phrase.
- **Fichiers** : chemins créés ou modifiés.
- **Test** : nom du test et ce qu'il prouve.
- **Critères de la spec couverts** : #1, #4…
- **Terminée quand** : condition observable.
- **Dépend de** : T<n-1> ou « aucune ».
```

## Fin de tâche

Vérifier que l'union des critères couverts égale l'ensemble des critères de
la spec. Signaler tout critère orphelin.

Vérifier symétriquement que tout module nommé dans `plan.md` est couvert par
au moins une tâche. Signaler tout module orphelin.

Raison de ce second contrôle : le découpage initial de la tranche 0001 a fait
de la testabilité hors réseau le critère implicite d'existence d'une tâche,
ce qui a rendu la couche d'effets de bord (les clients réseau eux-mêmes)
invisible au découpage — aucune tâche ne les construisait, alors que
`plan.md` les décrivait. Le contrôle sur les critères orphelins ne l'aurait
jamais détecté, puisque ces modules ne portent aucun critère de spec en
propre.

S'arrêter.
