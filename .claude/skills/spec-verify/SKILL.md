---
name: spec-verify
description: Audite une tranche terminée contre sa spec et les invariants du projet. À utiliser avant de clore une tranche.
---

# Vérification d'une tranche

Cette procédure est adversariale : l'objectif est de trouver ce qui est faux,
pas de confirmer que tout va bien. Un rapport sans réserve est suspect.

## 1. Couverture de la spec

Pour chaque critère d'acceptation : nommer le test qui le couvre et le lancer.
Tout critère sans test est signalé comme non couvert, sans exception.

## 2. Audit des invariants

Passer en revue les dix invariants de CLAUDE.md et chercher activement une
violation dans le code. En particulier :

- toute comparaison de dates : la date de dépôt est-elle bien celle utilisée ?
- tout `join` sur des dates : fuseaux et calendriers concordent-ils ?
- tout `fillna`, `dropna`, valeur par défaut, `except` : justifier ou signaler.
- tout univers de titres : d'où vient la liste, inclut-elle les délistés ?

## 3. Sondage numérique

Choisir trois titres au hasard dans l'univers. Pour chacun, remonter un chiffre
affiché jusqu'à son champ source et sa date de dépôt. Montrer la chaîne
complète. Si elle casse, l'invariant 8 est violé.

## 4. Rapport

```markdown
## Couverture : n/m critères
## Violations d'invariants : liste, ou « aucune trouvée, voici où j'ai cherché »
## Dette assumée : ce qui est volontairement imparfait
## Ce que ce tableau de bord ne prouve pas
```

La dernière section est obligatoire et ne doit pas être complaisante.
