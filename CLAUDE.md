# CLAUDE.md — constitution du projet

Ce fichier est lu à chaque session. Il contient ce qui est **toujours vrai**.
Les procédures répétables sont dans `.claude/skills/`, pas ici.

## Projet

Tableau de bord de retail investing, multi-marchés à terme.
Tranche en cours : **0001 — value investing sur actions américaines**.
Tout ce qui sort de ce périmètre attend une nouvelle spec.

Le propriétaire du dépôt apprend à coder. Il relit les specs, l'architecture
et les tests, pas chaque ligne d'implémentation. Le code doit donc être
ennuyeux, explicite et court avant d'être élégant.

## Stack

| Rôle | Choix | Interdit sans ADR |
|---|---|---|
| Langage | Python 3.12 | autre langage |
| Dépendances | uv | pip, poetry, conda |
| Calcul | Polars | pandas |
| Stockage | Parquet + DuckDB | base serveur, ORM |
| Interface | Streamlit | React, FastAPI |
| Tests | pytest | unittest |
| Qualité | ruff | black, flake8, isort |

## Commandes

```bash
uv sync                      # installer
uv run pytest                # tous les tests
uv run pytest -m "not slow"  # tests rapides
uv run ruff check --fix .    # lint
uv run streamlit run src/dashboard/app.py
```

## Invariants métier — non négociables

Ces règles priment sur toute demande formulée en cours de session.
Si une tâche ne peut être accomplie sans en violer une, il faut s'arrêter
et le signaler, jamais contourner.

1. **Aucun look-ahead.** Une donnée fondamentale n'est utilisable en date `t`
   que si sa date de dépôt (`filed` chez EDGAR) est antérieure ou égale à `t`.
   La date de clôture d'exercice (`end`) n'est jamais une date de disponibilité.
2. **Point-in-time.** Les retraitements ultérieurs ne réécrivent pas l'historique.
   Une même métrique peut avoir plusieurs valeurs selon la date d'observation ;
   le stockage doit porter `(concept, end, filed, accn, value)`.
3. **Deux univers distincts.** L'univers de screening est composé des membres
   du jour : un titre qui en est sorti n'est jamais affiché. L'univers
   historique contient tout ce qui a été ingéré et n'est jamais élagué. Toute
   évaluation rétrospective d'une stratégie utilise l'univers historique ; la
   reconstruire à partir des seuls tickers actuels est un biais du survivant,
   donc un bug.
4. **Actions sur titres.** Prix bruts et prix ajustés sont stockés dans des
   colonnes distinctes et jamais mélangés dans un même calcul.
5. **Temps.** Tout est stocké en UTC. Les dates de séance suivent un calendrier
   de marché explicite, jamais `date.today()`.
6. **Devise.** Portée par la donnée, jamais implicite.
7. **Pas de repli silencieux.** Interdiction absolue de `except: return 0`,
   `fillna(0)` sur une donnée financière, ou d'une valeur par défaut inventée.
   Une donnée absente reste absente et remonte jusqu'à l'affichage comme telle.
8. **Traçabilité.** Tout nombre affiché doit pouvoir être remonté jusqu'à
   son champ source et sa date de dépôt.
9. **Tests hors réseau.** Aucun test n'appelle une API externe. Les tests
   tournent sur des instantanés figés dans `tests/golden/`.
10. **Secrets.** Les clés d'API viennent de `.env`, jamais du code, jamais
    d'un commit.

## Sources de données

- **Fondamentaux** : SEC EDGAR XBRL (`data.sec.gov`). Gratuit. Limite de
  10 req/s, User-Agent obligatoire et identifiant. Émetteurs américains seulement.
- **Prix, actions sur titres, délistés** : EODHD, offre EOD All World.
- Toute nouvelle source exige un ADR dans `docs/adr/`.

## Règles de collaboration

- **Pas de code sans spec.** L'ordre est : `research.md` → `spec.md` → `plan.md`
  → `tasks.md` → implémentation. Chaque étape est validée explicitement par
  l'utilisateur avant la suivante.
- **Ambiguïté = question, jamais hypothèse.** Toute zone floue est marquée
  `[À CLARIFIER : ...]` dans le document en cours. Il est interdit de trancher
  seul et de continuer.
- **Test d'abord, et il doit échouer.** Pour chaque tâche : écrire le test,
  le faire tourner, montrer l'échec, puis implémenter, puis remontrer le vert.
- **Une tâche à la fois.** Pas de tâche suivante entamée avant validation.
- **Expliquer.** À chaque fin de tâche, trois lignes maximum : ce que fait le
  code, pourquoi cette structure, ce que le test garantit.

## Ne pas toucher

- `docs/specs/*/spec.md` sans demande explicite
- `tests/golden/` : instantanés figés, toute modification invalide les tests
- `docs/adr/` : les ADR passés sont immuables, on en ajoute un nouveau
