---
name: spec-new
description: Rédige la spec fonctionnelle d'une tranche verticale, sans aucun choix technique. À utiliser au démarrage d'une nouvelle tranche, après research.md.
---

# Rédaction d'une spec

## Contrat

Entrée : un numéro de tranche et une description en une phrase.
Sortie : `docs/specs/<NNNN>-<slug>/spec.md`. Aucun autre fichier.

## Interdits

- Aucun nom de bibliothèque, de fonction, de table ou de fichier.
- Aucun choix d'algorithme. « Détecter la sous-valorisation » est une spec ;
  « calculer un ratio EV/EBIT » est un plan.
- Aucune hypothèse comblée en silence. Toute zone floue devient
  `[À CLARIFIER : question précise]` et la rédaction continue autour.

## Structure imposée

```markdown
# Spec <NNNN> — <titre>

## Intention
Le problème de l'utilisateur, en trois phrases. Pas de solution.

## Périmètre
### Inclus
### Explicitement exclu
(section la plus importante ; être généreux en exclusions)

## Utilisateur et usage
Qui regarde cet écran, à quelle fréquence, pour décider quoi.

## Données requises
Par champ : nature, granularité, profondeur d'historique, fraîcheur exigée.
Sans nommer de fournisseur.

## Critères d'acceptation
Numérotés. Chacun vérifiable par une machine.
Format : « Étant donné <état>, quand <action>, alors <observable mesurable>. »
Un critère qu'on ne peut pas transformer en test est mal écrit : le réécrire.

## Critères liés aux invariants
Décliner en critères testables les invariants de CLAUDE.md qui s'appliquent
à cette tranche. Cette section n'est jamais vide.

## Hors-tests
Ce qu'on accepte de ne pas vérifier automatiquement, et pourquoi.

## Questions ouvertes
Reprise de tous les [À CLARIFIER] du document.
```

## Fin de tâche

Afficher la liste des `[À CLARIFIER]` et s'arrêter. Ne pas proposer de plan.
