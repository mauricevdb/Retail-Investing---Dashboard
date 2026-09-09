# ADR 0002 — Univers défini par règle, sans source externe d'indice

Date : 2026-09-09
Statut : accepté

## Contexte

Le plan de la tranche 0001 restait bloqué sur une source non décidée pour les
constituants du S&P 500 et du S&P 400 : ni research.md ni l'ADR 0001 ne
couvrent l'appartenance à un indice, seulement les fondamentaux (EDGAR) et les
prix/actions sur titres (EODHD). L'appartenance à un indice n'est utilisée
dans cette tranche que comme filtre de taille et de liquidité, jamais comme
référence pour répliquer un indice ou calculer un écart de suivi.

## Décision

L'univers de screening n'est plus « les constituants du S&P 500 et du
S&P 400 » mais un univers défini par une règle interne : les *N* premières
sociétés américaines par capitalisation boursière, après exclusion des codes
SIC 6000 à 6799, et à l'exclusion des fonds, ETF et véhicules assimilés — ne
retenir que des sociétés opérationnelles déposant en `us-gaap`. La
capitalisation est calculée à partir du nombre d'actions en circulation
(EDGAR) et du dernier cours de clôture (EODHD). *N* est de l'ordre de 900 ;
sa valeur exacte, la fréquence de recalcul et le mécanisme de stabilité de la
composition relèvent du plan, pas de cette décision.

## Conséquences

- Aucune source de données supplémentaire n'est introduite : la composition
  de l'univers se dérive entièrement de ce qui est déjà décidé (EDGAR pour
  les actions en circulation, EODHD pour les cours).
- L'univers ainsi défini n'est l'appartenance à aucun indice publié. L'écran
  doit le dire explicitement et ne jamais présenter ses statistiques comme
  une mesure du S&P 500 ou du S&P 400.
- La composition de cet univers n'existe nulle part ailleurs et ne peut donc
  pas être reconstituée après coup si elle n'est pas conservée : la table
  d'appartenance quotidienne (R8, règle 3) devient la seule trace de ce
  qu'était l'univers un jour donné, ce qui la rend plus indispensable encore
  que lorsqu'un indice publié faisait référence.
- Le calcul de l'univers doit rester stable au voisinage du rang de coupure
  pour ne pas faire entrer et sortir des titres au bruit quotidien des cours
  — mécanisme à définir dans le plan.
- Le calcul de la capitalisation dépend d'une chaîne de tags de repli pour le
  nombre d'actions en circulation, sur le même principe que les autres
  grandeurs dérivées (EBIT, FCF, etc.) — à documenter dans le plan.

## Alternatives écartées

- **API de constituants d'indice d'EODHD** : disponible uniquement dans le
  package Fundamentals à 59,99 €/mois, soit la totalité du budget déclaré
  pour une simple liste de tickers, alors que les fondamentaux sont déjà
  couverts gratuitement par EDGAR.
- **Liste publique non contractuelle** (par exemple une page communautaire) :
  conditions d'utilisation incertaines et rupture silencieuse de format —
  même argument que celui déjà écarté dans l'ADR 0001 pour les fondamentaux.
- **Portefeuilles d'ETF répliquant ces indices, publiés quotidiennement par
  leurs émetteurs** : viable techniquement, mais conserve une dépendance
  externe sans bénéfice pour un usage qui ne cherche qu'un filtre de taille
  et de liquidité, pas une réplication d'indice.
