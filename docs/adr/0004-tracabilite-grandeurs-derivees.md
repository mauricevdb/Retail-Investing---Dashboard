# ADR 0004 — Traçabilité des grandeurs dérivées

Date : 2026-09-11
Statut : accepté

## Contexte

L'invariant 8 de CLAUDE.md et le critère d'acceptation 9 de spec.md
supposaient, tels qu'écrits au moment du plan, que tout nombre affiché à
l'écran remonte à un fait déposé : champ source, date de fin d'exercice,
date de dépôt, numéro d'accession. Cette hypothèse tient pour les quatre
indicateurs directement dérivés de faits XBRL (EV/EBIT, rendement FCF/EV,
ROIC, dette nette/EBITDA), mais pas pour les deux percentiles : depuis
l'amendement de T45, ils sont reçus par `calc.ratios.indicator_status`
déjà résolus, en paramètres — une grandeur croisée sur l'univers ou sur
l'historique d'un titre, jamais la lecture d'un seul fait déposé un jour
donné.

La découverte a eu lieu en implémentant T61 (traçabilité à l'écran) :
tracer un percentile jusqu'à un `accn` n'a pas de sens, et aucun module de
plan.md ne prévoyait de point d'accès détail distinct pour ce cas. Ni
`plan.md`, ni les contrats de module qui y sont écrits, ne traduisaient
cette distinction — l'invariant avait été rédigé avant que la nature des
grandeurs dérivées ne soit pleinement explorée.

## Décision

L'invariant 8 est reformulé en deux cas plutôt qu'étendu de force au
premier :

- **Grandeur issue d'un dépôt** : origine = champ source, rang de repli
  utilisé dans la chaîne de tags, `end`, `filed`, `accn` (critère 9).
- **Grandeur dérivée** (percentile, indicateur composé) : origine =
  formule, entrées, population de comparaison le cas échéant, fenêtre
  temporelle retenue (nouveau critère 27).

Chaque famille de grandeurs gagne un point d'accès détail dédié, ajouté de
façon additive, sans modifier la signature d'aucune fonction déjà écrite
ni testée :

- `calc.point_in_time.resolve_detail(facts, concept, cik, end, t) ->
  {concept, end, filed, accn, value} | absente` — fonction sœur de
  `resolve`, qui peut l'appeler en interne sans que son propre contrat
  change.
- Chaque bridge à chaîne de repli (T25–T31) expose, à côté du tag déjà
  renvoyé, le rang de repli effectivement utilisé — une information de
  qualité : un indicateur calculé sur un repli lointain ne vaut pas un
  indicateur calculé sur le tag primaire.
- `calc.percentiles` expose son détail sous forme formule + entrées +
  population + fenêtre, jamais sous forme tag/`filed`/`accn`.

## Conséquences

- `app.detail_view` (T61) traite les deux cas distinctement plutôt que de
  chercher un format de traçabilité unique pour toutes les grandeurs.
- Aucun bridge, aucune fonction de `calc.ratios`, aucun test déjà vert
  n'est modifié par cet amendement : les nouveaux points d'accès sont des
  ajouts, jamais des changements de signature.
- tasks.md (T61) gagne T49 et T51 comme dépendances, qui manquaient — la
  même incohérence structurelle que celle corrigée en T45 (une tâche
  présupposant une brique que sa propre liste de dépendances n'incluait
  pas), ici sur les percentiles plutôt que sur le rendement FCF/EV.
- Le rang de repli devient une information exposée systématiquement,
  utile au-delà de la seule traçabilité : un futur écran pourra signaler
  visuellement qu'un indicateur repose sur un repli profond, sans
  attendre une tâche dédiée.

## Alternatives écartées

- **Étendre le format existant (tag/`end`/`filed`/`accn`) aux
  percentiles** — rejeté : un percentile n'a pas de `filed` ni d'`accn`
  propres ; forcer ce format aurait produit des champs vides ou inventés,
  contraire à l'invariant 7.
- **Réécrire chaque bridge pour renvoyer une structure enrichie
  (valeur, tag, rang de repli, `end`, `filed`, `accn`) au lieu d'un
  simple `(valeur, tag)`** — rejeté pour cette tranche : casserait la
  signature de neuf modules déjà écrits et testés (T25–T31) pour un
  bénéfice capturable de façon additive, via `resolve_detail`.
