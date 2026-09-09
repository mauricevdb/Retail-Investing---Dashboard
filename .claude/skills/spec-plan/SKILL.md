---
name: spec-plan
description: Traduit une spec validée en plan technique (architecture, schémas, contrats). À utiliser une fois spec.md approuvée et sans [À CLARIFIER] restant.
---

# Rédaction d'un plan

## Préalable bloquant

Lire `spec.md`. S'il reste un `[À CLARIFIER]`, s'arrêter et le signaler.
Un plan écrit sur une spec ambiguë produit du code à jeter.

## Contrat

Entrée : `docs/specs/<NNNN>-<slug>/spec.md`.
Sortie : `docs/specs/<NNNN>-<slug>/plan.md`. Aucun code à ce stade.

## Structure imposée

```markdown
# Plan <NNNN>

## Architecture
Un schéma en texte : ingestion → stockage → calcul → présentation.
Nommer les modules et leur responsabilité unique.

## Schéma de données
Chaque table Parquet : colonnes, types, clé, granularité.
Justifier chaque colonne par un critère d'acceptation de la spec.

## Contrats de module
Pour chaque module : signature publique, ce qu'il garantit, ce qu'il refuse.
Les fonctions publiques sont pures quand c'est possible ; les effets de bord
(réseau, disque) sont isolés dans des modules dédiés et nommés comme tels.

## Traçabilité
Tableau : critère d'acceptation → module → test qui le vérifie.
Tout critère sans ligne est une omission.

## Risques
Ce qui peut casser silencieusement, et le garde-fou correspondant.

## Décisions structurantes
Toute décision coûteuse à défaire → un ADR dans docs/adr/.
```

## Fin de tâche

Résumer en cinq lignes l'architecture retenue et les alternatives écartées.
S'arrêter. Ne pas générer les tâches.
