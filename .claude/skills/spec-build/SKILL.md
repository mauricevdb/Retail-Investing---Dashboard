---
name: spec-build
description: Implémente une seule tâche de tasks.md en test-first. À utiliser tâche par tâche, jamais en lot.
---

# Implémentation d'une tâche

## Séquence obligatoire

1. Annoncer la tâche traitée et relire son bloc dans `tasks.md`.
2. Écrire **le test seul**. Le lancer. **Montrer la sortie en échec.**
   Un test qui passe avant l'implémentation ne teste rien : le réécrire.
3. Écrire l'implémentation minimale qui fait passer ce test. Rien de plus.
   Pas d'option « au cas où », pas de généralisation anticipée.
4. Relancer la suite complète : `uv run pytest`. Montrer la sortie.
5. Expliquer en trois lignes : ce que fait le code, pourquoi cette structure,
   ce que le test garantit et ce qu'il ne garantit pas.
6. S'arrêter et attendre validation.

## Fin de tâche

Toute limite connue de l'implémentation constatée en fin de tâche doit
devenir un critère d'acceptation ou une tâche, jamais un commentaire dans le
code ni une note en fin de réponse. Une limite documentée en note ne remonte
ni dans les tests ni dans l'audit : elle disparaît.

Raison : la limite de traçabilité des replis (`app.detail_view` ne suivait
que les tags primaires) avait été correctement documentée à la fin de T61
— « se limite au cas où chaque bridge résout au niveau primaire » — et
n'a refait surface que par sondage manuel lors d'un `/spec-verify`, sur un
titre réel (Gamma) dont la trace s'est révélée entièrement vide. Consignée
comme tâche dès T61, elle aurait été vérifiée par un test avant d'être
découverte après.

## Interdits

- Traiter plusieurs tâches dans un même tour.
- Modifier `spec.md`, `plan.md` ou `tests/golden/`.
- Introduire une dépendance absente du plan.
- Écrire un `except` sans type, ou un repli sur une valeur par défaut.
- Écrire un test qui appelle le réseau.

## Si l'implémentation révèle une faille du plan

S'arrêter. Décrire la faille, proposer l'amendement du plan, attendre.
Ne jamais rattraper une erreur de plan par une astuce dans le code.
