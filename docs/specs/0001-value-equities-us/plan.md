# Plan 0001

## Architecture

```
ingestion  →  stockage (Parquet)  →  calcul (pur)  →  présentation (Streamlit)
```

Chaque flèche est une frontière stricte : aucun module de calcul n'effectue
de requête réseau ni de lecture/écriture disque ; aucun module d'ingestion
ne contient de logique de valorisation.

### Ingestion (effets de bord isolés, réseau + écriture disque)

- `ingestion.edgar_tickers` — télécharge `company_tickers.json`, produit la
  correspondance ticker → CIK.
- `ingestion.edgar_submissions` — télécharge les dépôts par CIK (historique,
  `accn`, dates `filed`, code SIC), alimente `filings.parquet` et
  `sic_codes.parquet`.
- `ingestion.edgar_facts` — télécharge `companyfacts.zip`, retient les
  faits des taxonomies `us-gaap` et `dei` (liste blanche, pas une exclusion
  d'`ifrs-full` : toute taxonomie hors de cette liste, connue ou non, est
  rejetée), écrit `fundamentals_raw.parquet` en mode ajout seul. Le nombre
  de faits rejetés par taxonomie est compté et rapporté au même titre que
  le taux de couverture des indicateurs (critère 11, invariant 7) — un
  rejet silencieux et non comptabilisé serait indiscernable d'une simple
  absence de données.
- `ingestion.eodhd_prices` — télécharge en bulk les cours de clôture bruts
  et ajustés du jour pour l'univers, écrit `prices_raw.parquet` et
  `prices_adjusted.parquet` séparément (invariant 4).
- `ingestion.eodhd_actions` — télécharge en bulk les fractionnements et
  dividendes, écrit `corporate_actions.parquet`.
- `ingestion.clock` — unique point d'accès à l'heure/date « maintenant » du
  système. Aucun autre module n'appelle une fonction d'horloge : la valeur
  est toujours reçue en paramètre, jamais lue directement (invariant 5).

### Couche réseau (clients HTTP, effets de bord)

Les modules `edgar_tickers`, `edgar_submissions`, `edgar_facts`,
`eodhd_prices` et `eodhd_actions` ci-dessus n'exposent pour l'instant que
leur moitié pure (`parse_*`, prenant un `raw` déjà chargé) — c'était le bon
choix pour rester testables hors réseau, mais aucun module ne récupère
encore réellement les données. Chacun gagne une fonction `fetch_*`
correspondante, qui appelle le client de sa source puis délègue au
`parse_*` déjà écrit :

- `ingestion.edgar_client` — point d'entrée HTTP unique pour EDGAR.
  Porte le User-Agent identifiant obligatoire sur chaque requête, la
  limitation à 10 req/s concentrée à cet unique endroit (aucune autre
  fonction ne doit émettre de requête EDGAR en dehors de ce client), et la
  gestion des délais et des erreurs HTTP. `get_json(url) -> dict | list` ;
  lève une exception explicite en cas d'échec, ne renvoie jamais de
  résultat vide ou partiel (invariant 7) — un échec de récupération n'est
  jamais confondu avec une réponse valide.
- `ingestion.eodhd_client` — point d'entrée HTTP unique pour EODHD.
  Authentification par clé, gestion des erreurs. Même contrat que le client
  EDGAR : échec explicite, jamais de repli silencieux.
- `ingestion.secrets` — utilitaire de masquage (`redact(text) -> text`),
  testé séparément, appliqué systématiquement par les deux clients à tout
  message d'exception qu'ils lèvent et à toute représentation textuelle
  (`repr`/`str`) d'un objet de configuration portant une clé. Le vecteur
  principal à couvrir : le message d'exception d'une bibliothèque HTTP
  contient l'URL complète, donc la clé passée en chaîne de requête.

### Stockage (schéma seul, voir section dédiée)

Fichiers Parquet, interrogés via DuckDB pour la présentation. Aucun serveur,
aucun ORM (CLAUDE.md).

### Calcul (fonctions pures, Polars, aucune E/S)

- `calc.point_in_time` — résout la dernière valeur connue d'un concept à
  une date `t` (filed ≤ t), sans jamais renvoyer une valeur postérieure.
- `calc.market_calendar` — calendrier de séance explicite ; résout la
  dernière séance effective à partir d'un instant fourni en paramètre.
- `calc.universe` — calcule l'univers du jour (ADR 0002), à partir des
  actions en circulation point-in-time, des cours ajustés, du code SIC et
  de la nature de l'émetteur. Trois règles, dans l'ordre :
  1. Exclusion : code SIC 6000–6799, et tout émetteur dont la nature n'est
     pas « société opérationnelle » (fonds, ETF, véhicule assimilé).
  2. Classement par capitalisation lissée : capitalisation = actions en
     circulation (dernière valeur connue à `t`) × moyenne du cours de
     clôture ajusté sur les 20 dernières séances. Le lissage sur 20 séances
     (environ un mois de bourse) absorbe le bruit d'un seul jour de cours
     sans retarder de plus de quelques semaines la prise en compte d'un
     vrai changement de taille — durée choisie pour rester cohérente avec
     le rythme quotidien du reste du pipeline (D5), pas une reconstitution
     périodique séparée.
  3. Hystérésis au rang de coupure : *N* = 900 (paramètre de configuration).
     Un titre déjà dans l'univers la veille y reste tant que son rang reste
     ≤ *N* + *buffer*. Un titre absent la veille n'entre que si son rang
     atteint ≤ *N* − *buffer*. *buffer* = 100 par défaut (paramètre de
     configuration), soit une bande neutre de 800 à 1000 dans laquelle un
     titre proche du seuil ne change pas de statut d'un jour à l'autre.
     *N* et *buffer* sont recalibrables sans perte de données : la
     composition passée reste celle enregistrée le jour où elle a été
     calculée (invariant 3).
  Garde-fou : si le nombre de titres résultant sort d'une plage plausible
  configurée (ex. hors 700–1100), `calc.universe` renvoie un échec explicite
  plutôt qu'un univers tronqué (critère 25) ; c'est `pipeline.daily_run` qui
  arrête le traitement du jour sur cet échec.
- `calc.ttm` / `calc.normalized_5y` — agrègent les fondamentaux
  point-in-time sur quatre trimestres glissants, ou sur la médiane des cinq
  derniers exercices.
- Chaînes de repli pour EBIT, FCF, dette nette, capital investi, EBITDA et
  NOPAT/ROIC — détaillées dans la sous-section « Grandeurs dérivées »
  ci-dessous. Chaque résultat porte la valeur, le ou les tags effectivement
  utilisés et un statut calculable/non calculable.
- `calc.shares_bridge` — même principe pour les actions en circulation,
  utilisées à la fois par `calc.universe` (capitalisation) et par
  `calc.ratios` (rapport des fondamentaux au marché). Chaîne de repli, dans
  l'ordre :
  1. `dei:EntityCommonStockSharesOutstanding` (tag de couverture, déposé à
     chaque 10-K/10-Q avec sa propre date « as of », la plus proche en
     pratique de la date de dépôt — la mieux adaptée au calcul
     point-in-time).
  2. `us-gaap:CommonStockSharesOutstanding` (bilan, à la date de fin de
     période) si le tag de couverture est absent pour ce dépôt.
  3. `us-gaap:CommonStockSharesIssued` moins `us-gaap:TreasuryStockShares`
     (ou l'équivalent par classe) si aucun des deux tags précédents n'est
     présent.
  4. Sinon : non calculable, signalé comme tel (critère 6) — le titre est
     exclu du classement par capitalisation ce jour-là, jamais classé avec
     une valeur devinée.
  Émetteurs à plusieurs classes d'actions : seule la classe associée au
  ticker principal déjà enregistré dans `ticker_cik.parquet` est retenue,
  sans somme multi-classes ni prix composite — simplification assumée,
  documentée comme risque connu (voir Risques), pas une omission.
- `calc.ratios` — calcule les six indicateurs (EV/EBIT, rendement FCF/EV,
  ROIC, dette nette/EBITDA, et les deux percentiles) à partir des sorties
  ci-dessus, du prix et des actions en circulation.
- `calc.sector_grouping` — regroupe le code SIC d'un titre (déjà hors
  SIC 6000–6799 : cette exclusion reste de la seule responsabilité de
  `calc.universe`, pas répétée ici) dans l'une des neuf divisions SIC
  officielles, le standard du régulateur plutôt qu'un regroupement inventé :

  | Division | Plage SIC | Libellé |
  |---|---|---|
  | A | 0100–0999 | Agriculture, sylviculture, pêche |
  | B | 1000–1499 | Mines |
  | C | 1500–1799 | Construction |
  | D | 2000–3999 | Industrie manufacturière |
  | E | 4000–4999 | Transport, communications, énergie, eau |
  | F | 5000–5199 | Commerce de gros |
  | G | 5200–5999 | Commerce de détail |
  | I | 7000–8999 | Services |
  | J | 9100–9999 | Administration publique |

  La division H (6000–6799, finance/assurance/immobilier) n'apparaît jamais
  ici puisqu'elle est déjà hors univers. Un code SIC hors de ces plages
  (1800–1999 ou 9000–9099, non affectés par le standard) est non calculable
  pour le regroupement sectoriel, jamais rattaché par défaut à une division
  voisine.
- `calc.percentiles` — percentile face à l'histoire propre depuis 2011
  (avec nombre d'années disponibles) et percentile sectoriel (repli sur
  l'absolu si groupe < 10 titres).
- `calc.divergence` — signale un écart TTM / normalisé au-delà du seuil
  configuré.
- `calc.filters` puis `calc.ranking` — appliquent les seuils configurés,
  comptent les titres retenus, classent et plafonnent à 25.
- `calc.streak` — calcule, à partir de l'historique du screen, le nombre de
  jours consécutifs où un titre passe les filtres.

### Grandeurs dérivées : chaînes de repli et règles de calcul

Règle transversale à toutes les chaînes ci-dessous : l'absence d'un tag pour
la période requise rend la grandeur non calculable ; elle n'est jamais
traitée comme zéro, y compris quand zéro serait économiquement plausible
(ex. société sans dette). Distinguer « le poste vaut zéro » de « le poste
n'a pas été trouvé » exigerait une inférence non vérifiable à partir du
dépôt ; la règle la plus sûre au regard de l'invariant 7 est de toujours
traiter l'absence comme une absence, quitte à sous-compter des titres
calculables plutôt que d'en sur-compter.

- **`calc.ebit_bridge`** — EBIT :
  1. Primaire : `us-gaap:OperatingIncomeLoss`.
  2. Repli : `NetIncomeLoss + IncomeTaxExpenseBenefit + InterestExpense`
     (voir `calc.interest_bridge`), si le tag primaire est absent.
  3. Sinon : non calculable.
- **`calc.interest_bridge`** — charge d'intérêts, utilisée uniquement par le
  repli d'EBIT (le cas primaire ne la sollicite pas) :
  `InterestExpense`, repli `InterestExpenseDebt`, repli
  `-1 × InterestIncomeExpenseNet` (solde net). Sinon non calculable — cette
  chaîne n'étant sollicitée que rarement, l'impact d'un sur-signalement pour
  les émetteurs sans dette y reste limité.
- **`calc.dna_bridge`** — dotation aux amortissements, pour l'EBITDA :
  primaire `DepreciationDepletionAndAmortization`, repli
  `Depreciation + AmortizationOfIntangibleAssets` si les deux composantes
  sont présentes séparément. Sinon non calculable.
- **`calc.ebitda`** (formule) = EBIT + D&A. Non calculable si l'une des
  deux composantes l'est.
- **`calc.fcf_bridge`** — flux de trésorerie disponible :
  primaire `NetCashProvidedByUsedInOperatingActivities −
  PaymentsToAcquirePropertyPlantAndEquipment` ; repli CapEx
  `PaymentsToAcquireProductiveAssets` si le tag primaire de CapEx est
  absent ; repli CFO `NetCashProvidedByUsedInOperatingActivitiesContinuingOperations`
  si le tag primaire de CFO est absent. Sinon non calculable.
- **`calc.debt_bridge`** — dette totale, brique partagée par le capital
  investi et la dette nette : part long terme `LongTermDebtNoncurrent`
  (repli `LongTermDebt`), part courante `LongTermDebtCurrent` (repli
  `DebtCurrent`), emprunts court terme distincts s'ils existent
  `ShortTermBorrowings`. Dette totale = somme des composantes trouvées ;
  non calculable seulement si aucune composante n'est trouvée (règle
  transversale ci-dessus, pas de repli à zéro).
- **`calc.cash_bridge`** — trésorerie, brique partagée elle aussi :
  primaire `CashAndCashEquivalentsAtCarryingValue`, repli `Cash`. Sinon non
  calculable. Les placements à court terme (titres négociables) ne sont pas
  inclus — simplification assumée, voir Risques.
- **`calc.equity_bridge`** — capitaux propres, pour le capital investi :
  primaire `StockholdersEquity`, repli
  `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`.
  Sinon non calculable.
- **`calc.net_debt`** (formule) = dette totale − trésorerie. Non calculable
  si l'une des deux composantes l'est.
- **`calc.invested_capital`** (formule) = dette totale + capitaux propres −
  trésorerie. Non calculable si l'une des composantes l'est ; traité comme
  non calculable pour le ROIC si le résultat est ≤ 0 (un retour sur capital
  investi négatif ou nul n'est pas interprétable).
- **`calc.ev`** (formule) = capitalisation (`calc.universe` /
  `calc.shares_bridge`) + dette nette. Non calculable si la dette nette
  l'est.
- **NOPAT et ROIC** :
  - Taux d'imposition effectif : si le résultat avant impôt (primaire
    `IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest`,
    repli `NetIncomeLoss + IncomeTaxExpenseBenefit`) est strictement
    positif, taux = `IncomeTaxExpenseBenefit` / résultat avant impôt,
    plafonné à la bande [0 %, 50 %]. Sinon (résultat avant impôt nul,
    négatif ou non calculable), taux = 21 % (taux fédéral statutaire
    américain), utilisé comme approximation par défaut documentée plutôt
    que de rendre le ROIC non calculable pour des sociétés
    opérationnellement rentables mais lourdement endettées — précisément le
    profil que l'indicateur qualité doit pouvoir capter (R1).
  - NOPAT = EBIT × (1 − taux). Non calculable seulement si EBIT l'est : le
    taux a toujours une valeur, calculée ou approximée par défaut.
  - ROIC = NOPAT / capital investi. Non calculable si NOPAT ou le capital
    investi l'est, ou si le capital investi est ≤ 0.
- **Ratios rendus non interprétables par leur dénominateur** :
  - EV/EBIT : non calculable si l'EBIT (TTM) est ≤ 0 — même raison que
    l'exclusion du P/E en R1, un multiple sur bénéfice négatif ou nul n'a
    pas de lecture « bon marché / cher ».
  - Dette nette/EBITDA : non calculable si l'EBITDA est ≤ 0, pour la même
    raison.

### Persistance des résultats (effet de bord, écriture seule)

- `storage.screen_history` — ajoute une ligne par titre par jour dans
  `screen_results.parquet`, jamais réécrite ni supprimée.
- `storage.universe_history` — ajoute une ligne par titre par jour dans
  `universe_membership.parquet`, jamais réécrite ni supprimée. Seule trace
  de la composition de l'univers, qui n'existe dans aucune source externe
  depuis l'ADR 0002.

### Orchestration (impure par nature, isole l'ordre des appels)

- `pipeline.daily_run` — enchaîne ingestion → `calc.universe` → reste du
  calcul → persistance pour une date de traitement donnée ; seul module
  autorisé à composer les effets de bord entre eux. Arrête le traitement et
  n'affiche pas d'écran si `calc.universe` échoue (critère 25).

### Présentation (Streamlit, lecture seule via DuckDB)

- `app.screen_view` — tableau filtré/classé, compteur de titres retenus
  (y compris zéro), alertes de divergence et de couverture manquante.
- `app.detail_view` — détail d'un titre : pour une grandeur issue d'un
  dépôt, champ source, rang de repli utilisé, `end`, `filed`, `accn` ; pour
  une grandeur dérivée (percentile, indicateur composé), formule, entrées,
  population de comparaison et fenêtre retenue (invariant 8 amendé, ADR
  0004, critères 9 et 27).

## Schéma de données

### `fundamentals_raw.parquet`
| Colonne | Type | Rôle |
|---|---|---|
| cik | str | identifiant émetteur |
| concept | str | tag XBRL |
| taxonomy | str | `us-gaap` ou `dei` — liste blanche appliquée à l'ingestion, `ifrs-full` et toute autre taxonomie rejetées et comptées (critère 5) |
| unit | str | unité XBRL |
| end | date | fin de période couverte par le fait |
| start | date, nullable | début de période (nul pour les faits instantanés) |
| filed | date | date de dépôt (critère 1, 3) |
| accn | str | numéro de dépôt (critère 9) |
| value | float64 | valeur du fait |
| fiscal_period | str | `Q1`…`Q4`, `FY` (nécessaire au TTM, critère 12) |
| fiscal_year | int | exercice fiscal |

Clé : `(cik, concept, end, filed, accn)`. Plusieurs lignes pour un même
`(cik, concept, end)` sont attendues (retraitements, critère 3) — jamais
dédupliquées. Ajout seul.

### `filings.parquet`
| Colonne | Type |
|---|---|
| cik | str |
| accn | str |
| form | str |
| filed | date |
| period_of_report | date |

Clé : `(cik, accn)`. Justifie le critère 9 (traçabilité du dépôt).

### `sic_codes.parquet`
| Colonne | Type |
|---|---|
| cik | str |
| sic | str (4 chiffres) |
| sic_description | str |
| entity_type | str (ex. « operating company », « investment company ») |
| as_of | date |

Clé : `(cik, as_of)`, historisée. `entity_type` vient du même endpoint de
dépôts (submissions) qu'`sic`, sans source supplémentaire ; sert à exclure
les fonds, ETF et véhicules assimilés (critère 23). Justifie les critères
14, 19, 20, 23.

### `ticker_cik.parquet`
| Colonne | Type |
|---|---|
| cik | str |
| ticker | str |
| name | str |
| as_of | date |

Clé : `(cik, as_of)`, historisée — un ticker peut changer d'émetteur dans
le temps.

### `universe_membership.parquet`
| Colonne | Type | Rôle |
|---|---|---|
| date | date | |
| cik | str | |
| ticker | str | |
| market_cap_smoothed | float64 | capitalisation lissée sur 20 séances ayant servi au classement du jour |
| rank | int | rang par capitalisation lissée, avant hystérésis |
| in_universe | bool | résultat après application de l'hystérésis (critère 24) |

Clé : `(date, cik)`. Ajout seul, jamais élagué. Justifie les critères 2, 21,
22, 23, 24 et l'invariant 3 (deux univers distincts). Ne référence aucun
indice publié (ADR 0002) : `rank` et `in_universe` sont calculés par
`calc.universe`, jamais lus d'une source externe.

### `prices_raw.parquet`
| Colonne | Type |
|---|---|
| ticker | str |
| date | date |
| open, high, low, close | float64 |
| volume | int64 |

Clé : `(ticker, date)`.

### `prices_adjusted.parquet`
| Colonne | Type |
|---|---|
| ticker | str |
| date | date |
| close_adj | float64 |

Clé : `(ticker, date)`. Table physiquement distincte de `prices_raw`,
jamais jointe dans un même calcul sans que les deux colonnes restent
identifiables séparément (invariant 4, critère 4).

### `corporate_actions.parquet`
| Colonne | Type |
|---|---|
| ticker | str |
| date_effective | date |
| action_type | str (`split` \| `dividend`) |
| ratio_or_amount | float64 |

Clé : `(ticker, date_effective, action_type)`. Justifie le critère 4.

### `screen_results.parquet`
| Colonne | Type |
|---|---|
| date | date |
| cik | str |
| ticker | str |
| ev_ebit_ttm, ev_ebit_5y_median | float64, nullable |
| fcf_yield, roic, net_debt_ebitda | float64, nullable |
| divergence_flag | bool |
| pct_own_history | float64, nullable |
| years_of_history | int |
| sector_group | str |
| pct_sector | float64, nullable |
| sector_pct_available | bool |
| passed_filters | bool |
| rank | int, nullable |
| missing_indicators | list[str] |

Clé : `(date, cik)`. Ajout seul, jamais réécrite. Justifie les critères
11 à 20.

Les actions en circulation ne forment pas une table séparée : c'est un
concept parmi d'autres dans `fundamentals_raw.parquet`, avec la même
exigence point-in-time que le reste.

## Contrats de module

Amendement (invariant 8, ADR 0004) : la traçabilité n'avait pas été
traduite en contrat de module à l'écriture initiale de ce plan — seul le
cas d'une grandeur directement issue d'un dépôt était couvert. Chaque
famille de grandeurs gagne un point d'accès détail dédié, additif, qui ne
modifie la signature d'aucune fonction déjà écrite ni testée :
- `calc.point_in_time` gagne `resolve_detail(facts, concept, cik, end, t)
  -> {concept, end, filed, accn, value} | absente`, une fonction sœur de
  `resolve` ; `resolve` peut l'appeler en interne et n'en extraire que la
  valeur, sans que son propre contrat change.
- Chaque bridge à chaîne de repli (T25–T31) expose, à côté du tag déjà
  renvoyé, le rang de repli effectivement utilisé (1 = tag primaire, 2 =
  premier repli, etc.) — l'information de qualité que l'invariant 8 exige
  désormais explicitement : un indicateur calculé sur un repli lointain ne
  vaut pas un indicateur calculé sur le tag primaire.
- Les grandeurs dérivées (`calc.percentiles`) exposent leur détail sous la
  forme formule + entrées + population de comparaison + fenêtre retenue,
  jamais sous la forme tag/`filed`/`accn`, qui n'a pas de sens pour elles.

- **`calc.point_in_time(facts, concept, cik, t) -> valeur | absente`**
  Garantit : ne renvoie jamais une valeur dont `filed > t`. Refuse : de
  deviner une valeur en l'absence de dépôt antérieur à `t` — renvoie
  « absente », jamais zéro ni une moyenne.
- **`calc.ratios(fundamentals_pit, prices, actions, t) -> indicateurs +
  statuts`** Garantit : un statut explicite par indicateur et par titre
  (calculable / non calculable). Refuse : de produire une valeur numérique
  pour un indicateur dont une composante est absente.
- **`calc.market_calendar.last_session(instant) -> date`** Pure : ne lit
  jamais l'horloge système elle-même ; `instant` est toujours fourni par
  l'appelant (`pipeline.daily_run`, via `ingestion.clock`).
- **`calc.universe(shares_pit, prices_adj, sic, entity_type, hier_membership,
  n, buffer, t) -> membres_du_jour | échec`** Garantit : exclut SIC
  6000–6799 et tout émetteur non « société opérationnelle » avant tout
  classement ; applique l'hystérésis à partir de `hier_membership`, jamais
  un classement brut sans mémoire de la veille. Refuse : de renvoyer un
  univers dont la taille sort de la plage plausible configurée — renvoie un
  échec explicite plutôt qu'un résultat tronqué.
- **`calc.filters(indicateurs, seuils) -> (retenus, compteur)`** Garantit :
  le compteur est renvoyé même si `retenus` est vide. Refuse : un seuil en
  dur non paramétrable — les seuils sont toujours reçus en argument.
- **`storage.screen_history.append(lignes_du_jour)`** Garantit : n'écrit
  que des lignes nouvelles pour la date donnée ; refuse d'écraser une ligne
  déjà présente pour `(date, cik)` — erreur explicite plutôt que
  réécriture silencieuse.
- **`ingestion.edgar_client.get_json(url) -> dict | list`** Garantit : User-
  Agent identifiant sur chaque requête, débit ≤ 10 req/s. Refuse : de
  renvoyer un résultat vide ou partiel en cas d'échec — lève une exception
  dont le message ne contient jamais l'URL en clair si elle porte un secret.
- **`ingestion.eodhd_client.get_json(url) -> dict | list`** Même contrat que
  le client EDGAR, authentification par clé plutôt que par User-Agent.
- **`ingestion.secrets.redact(text) -> text`** Garantit : toute sous-chaîne
  reconnue comme secret (clé API, valeur portée par une variable
  d'environnement déclarée sensible) est remplacée avant retour. Refuse :
  de renvoyer le texte inchangé si un secret configuré y est présent.
- **`ingestion.*` (modules de parsing T2–T8)** : garantissent l'écriture en
  ajout seul dans leurs tables respectives ; refusent de retourner une
  valeur par défaut en cas d'échec — l'absence de mise à jour du jour est
  un état visible, jamais comblé silencieusement par la veille.

## Traçabilité

| Critère (spec.md) | Module | Test |
|---|---|---|
| 1 — aucun look-ahead | `calc.point_in_time` | `test_point_in_time_rejects_future_filed` |
| 2 — titre sorti de l'univers absent du screen | `calc.universe`, `calc.filters` | `test_screen_excludes_non_members` |
| 3 — dernière valeur connue, historique préservé | `calc.point_in_time`, `fundamentals_raw` | `test_restatement_latest_value_history_preserved` |
| 4 — brut/ajusté jamais mélangés | `prices_raw`/`prices_adjusted`, `calc.ratios` | `test_no_raw_adjusted_mixing` |
| 5 — IFRS exclu | `ingestion.edgar_facts` | `test_ifrs_taxonomy_excluded` |
| 6 — donnée absente signalée, jamais par défaut | `calc.ratios` | `test_missing_fundamental_flagged` |
| 7 — écran reflète clôture + dépôts connus du jour | `pipeline.daily_run` | `test_daily_run_uses_close_and_known_filings` |
| 8 — date de référence = dernière séance | `calc.market_calendar` | `test_last_session_not_calendar_today` |
| 9 — traçabilité d'une grandeur issue d'un dépôt (dont le rang de repli, et, pour un prix, la date de cotation) | `app.detail_view`, `calc.point_in_time.resolve_detail`, `filings.parquet` | `test_every_displayed_number_traceable`, `test_price_traceable_to_quotation_date`, `test_default_tax_rate_fallback_disclosed_in_roic_trace` |
| 10 — devise explicite, sans conversion | schéma (colonnes devise), `calc.ratios` | `test_currency_explicit_no_conversion` |
| 11 — taux de couverture par indicateur | `calc.ratios` et les bridges (`ebit`, `fcf`, `debt`, `cash`, `equity`, `dna`, `shares`) | `test_coverage_rate_reported_per_indicator` |
| 12 — TTM primaire, médiane 5 ans secondaire | `calc.ttm`, `calc.normalized_5y` | `test_ttm_and_5y_median_computed` |
| 13 — divergence signalée au-delà du seuil | `calc.divergence` | `test_divergence_flag_above_threshold` |
| 14 — SIC 6000–6799 exclu | `ingestion.edgar_submissions`, `calc.universe` | `test_universe_exclusions` |
| 15 — compteur affiché y compris zéro | `calc.filters` | `test_filter_count_including_zero` |
| 16 — classement plafonné à 25 | `calc.ranking` | `test_ranking_capped_at_25` |
| 17 — historique du screen append-only | `storage.screen_history` | `test_screen_history_never_rewritten` |
| 18 — jours consécutifs affichés | `calc.streak` | `test_consecutive_days_streak` |
| 19 — percentile propre histoire + années dispo | `calc.percentiles` | `test_own_history_percentile_and_years` |
| 20 — repli absolu si secteur < 10 titres | `calc.percentiles` | `test_sector_percentile_fallback_below_10` |
| 21 — données préservées pour titre sorti | `fundamentals_raw`, `screen_results` (jamais élaguées) | `test_delisted_ticker_history_preserved` |
| 22 — table d'appartenance append-only | `storage.universe_history` | `test_membership_table_append_only`, `test_universe_history_rejects_duplicate_date_cik` |
| 23 — fonds/ETF exclus | `calc.universe` | `test_universe_exclusions` |
| 24 — stabilité au rang de coupure | `calc.universe` | `test_universe_stable_near_cutoff_with_hysteresis` |
| 25 — échec bruyant si taille implausible | `calc.universe`, `pipeline.daily_run` | `test_universe_failure_halts_pipeline` |
| 26 — jamais présenté comme le S&P 500/400 | `app.screen_view` | `test_no_index_label_in_ui` |
| 27 — traçabilité d'une grandeur dérivée (formule, entrées, population, fenêtre) | `app.detail_view`, `calc.percentiles` | `test_every_displayed_number_traceable`, `test_default_tax_rate_fallback_disclosed_in_roic_trace` |
| Invariant 10 — aucune clé dans logs/erreurs | `ingestion.edgar_client`, `ingestion.eodhd_client`, `ingestion.secrets` | `test_no_api_key_in_logs_or_errors` |

## Risques

- **Fractionnement non reflété à temps par la source de prix** — écart de
  50 % qui se présente comme la meilleure opportunité du jour (déjà noté
  dans research.md). Garde-fou : `calc.ratios` compare le ratio de prix
  veille/jour à un seuil de cohérence et signale l'anomalie plutôt que de
  la laisser silencieusement fausser un indicateur.
- **Chaîne de repli de tags XBRL mal choisie pour un émetteur atypique** —
  produirait une valeur plausible mais fausse, sans erreur visible. Garde-
  fou : le tag effectivement utilisé est stocké et affichable
  (traçabilité), jamais implicite dans le résultat numérique seul.
- **Changement de code SIC ou de ticker non reflété** — mauvais
  regroupement sectoriel, ou rupture de série de prix. Garde-fou :
  `sic_codes` et `ticker_cik` sont historisées avec `as_of`, toute
  jointure se fait à la date effective, jamais sur la valeur la plus
  récente sans égard à la date.
- **Amplitude du buffer d'hystérésis mal calibrée** — trop petit, le bruit
  quotidien reste ; trop grand, une vraie évolution de taille est ignorée
  trop longtemps. Garde-fou : `n` et `buffer` sont des paramètres de
  configuration, testés sur des instantanés figés couvrant des cas de bord
  proches du rang de coupure ; recalibrables sans perte de données
  (l'historique déjà enregistré n'est jamais recalculé).
- **Mauvaise identification d'un fonds ou d'un ETF comme société
  opérationnelle, ou l'inverse** — fausserait le classement par
  capitalisation. Garde-fou : `entity_type` vient directement des dépôts
  SEC (endpoint submissions), jamais d'une heuristique sur le nom ou le
  ticker.
- **Actions en circulation manquantes ou en retard pour un émetteur** —
  capitalisation sous-estimée, rang faussé. Garde-fou : même traitement que
  les autres fondamentaux absents (critère 6) — l'émetteur concerné est
  signalé non calculable pour le classement plutôt qu'exclu silencieusement
  ou classé avec une valeur par défaut.
- **Émetteur à plusieurs classes d'actions, capitalisation sous-estimée par
  construction** — `calc.shares_bridge` ne retient que la classe du ticker
  principal, pas la somme des classes. Garde-fou : simplification
  documentée et traçable (le tag et la classe retenue sont stockés), pas un
  biais silencieux ; revisitable sans perte de données si elle s'avère
  fausser significativement le classement d'un émetteur concerné.
- **Approximation du taux d'imposition à 21 % en l'absence de résultat
  avant impôt positif** — peut s'écarter du taux effectif réel d'un
  émetteur multinational (crédits d'impôt, reports déficitaires). Garde-fou :
  approximation documentée et traçable (le taux utilisé, calculé ou
  approximé, est stocké avec le résultat), jamais un ROIC affiché sans que
  l'origine du taux ne reste retrouvable.
- **Trésorerie hors placements à court terme** — sous-estime la trésorerie
  réelle des émetteurs riches en titres négociables, surestimant leur dette
  nette et sous-estimant leur capital investi net de trésorerie. Garde-fou :
  simplification documentée, traçable via le tag utilisé, revisitable sans
  perte de données.
- **Multiplication des chaînes de repli** (une dizaine de bridges pour six
  indicateurs) — surface d'erreur de correspondance de tags plus large
  qu'un calcul à source unique. Garde-fou : chaque bridge est une fonction
  pure testée indépendamment de `calc.ratios`, et chaque résultat porte le
  ou les tags effectivement utilisés, jamais une valeur numérique seule.
- **Dépassement de la limite de 10 requêtes/seconde d'EDGAR** — réponse 403
  en cascade. Garde-fou : la limitation de débit est isolée dans
  `ingestion.edgar_client`, seul point du code autorisé à émettre une
  requête EDGAR, testée indépendamment.
- **Fuite d'une clé d'API dans un message d'erreur** — le vecteur principal
  est le message d'exception d'une bibliothèque HTTP, qui contient l'URL
  complète et donc la clé en chaîne de requête. Garde-fou :
  `ingestion.secrets.redact` appliqué systématiquement par les deux clients
  à tout message d'exception et à toute représentation de configuration ;
  testé en provoquant un échec réel du client, pas seulement de l'utilitaire
  de masquage isolé.
- **Horodatage des dépôts SEC en heure de l'Est américain, pas en UTC** —
  une conversion implicite ou absente fausserait la comparaison `filed ≤ t`
  près de minuit. Garde-fou : la conversion vers UTC est explicite et
  documentée au point d'ingestion, jamais laissée à la valeur telle que
  reçue.

## Décisions structurantes

- **Définition de l'univers par règle plutôt que par indice publié** —
  tranchée par l'ADR 0002. Aucune nouvelle source introduite : `calc.universe`
  se dérive entièrement des actions en circulation (EDGAR) et des cours
  (EODHD) déjà décidés.
- **Taille de l'univers (*N* = 900) et bande d'hystérésis (*buffer* = 100)**
  — ne constituent pas une nouvelle source de données, donc pas d'ADR requis
  au sens strict de CLAUDE.md. Documentées ici comme paramètres de
  configuration, réversibles sans perte de données : `universe_membership`
  conserve la composition telle que calculée chaque jour quelle que soit
  une recalibration future de ces paramètres (invariant 3).
- **Chaînes de repli de tags XBRL pour les grandeurs dérivées** (actions en
  circulation, EBIT, D&A/EBITDA, FCF, dette, trésorerie, capitaux propres,
  capital investi, NOPAT/ROIC) — méthode centrale au calcul des six
  indicateurs et de la capitalisation, coûteuse à changer rétroactivement
  sans casser la comparabilité de l'historique déjà produit. Toutes fixées
  dans la sous-section « Grandeurs dérivées », y compris le taux
  d'imposition par défaut (21 %) utilisé pour le ROIC et les règles
  rendant EV/EBIT et dette nette/EBITDA non calculables sur dénominateur
  non positif. Ne constituent pas une nouvelle source au sens de CLAUDE.md
  — documentées ici comme décisions de plan, pas dans un ADR séparé, à
  condition que le tag effectivement utilisé reste stocké et traçable pour
  chaque valeur produite (critères 9, 11).
- **Traçabilité des grandeurs dérivées (invariant 8 amendé, ADR 0004)** —
  découverte en implémentant T61 : l'invariant 8 initial et le critère 9
  supposaient que tout nombre affiché remontait à un fait déposé
  (champ source, `end`, `filed`, `accn`), ce qui ne dit rien pour un
  percentile ou tout indicateur composé de plusieurs faits. Corrigé par
  un second cas de traçabilité (formule, entrées, population de
  comparaison, fenêtre — critère 27) plutôt que par une extension forcée
  du premier cas. Ne constitue pas une nouvelle source de données, donc
  pas d'ADR requis au sens strict de CLAUDE.md pour la distinction
  elle-même ; l'ADR 0004 documente néanmoins le fait que cette
  traçabilité n'avait pas été traduite en contrat de module au moment du
  plan initial, et que les points d'accès détail ont été ajoutés après
  coup, de façon additive.
- **Regroupement des codes SIC en catégories grossières** — les neuf
  divisions SIC officielles (voir section Calcul, `calc.sector_grouping`),
  plutôt qu'un regroupement inventé : standard du régulateur, déjà « une
  dizaine de catégories grossières » sans reconstruire une classification
  GICS. Ne constitue pas une nouvelle source de données, donc pas d'ADR
  requis au sens strict de CLAUDE.md ; réversible sans perte de données
  puisque `sic_codes.parquet` conserve le code SIC brut et permet un
  reclassement ultérieur.
