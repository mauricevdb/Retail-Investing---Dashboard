# Tasks 0001

Convention de chemins : `src/dashboard/<module>.py` reflète le nom pointé du
plan (`ingestion.edgar_tickers` → `src/dashboard/ingestion/edgar_tickers.py`,
`calc.ebit_bridge` → `src/dashboard/calc/ebit_bridge.py`, etc.), tests sous
`tests/` en miroir, fixtures figées sous `tests/golden/`.

## Ingestion

### T1 — Constituer l'instantané figé initial
- **Objectif** : disposer de fixtures figées couvrant les cas de base (un
  émetteur normal, un retraitement, un émetteur IFRS, un émetteur SIC
  6000–6799, un émetteur `entity_type` fonds/ETF, un fractionnement) pour
  que toute tâche suivante puisse s'exécuter hors réseau.
- **Fichiers** : `tests/golden/raw/edgar_company_tickers.json`,
  `tests/golden/raw/edgar_submissions_*.json`,
  `tests/golden/raw/edgar_companyfacts_*.json`,
  `tests/golden/raw/eodhd_bulk_prices_*.json`,
  `tests/golden/raw/eodhd_bulk_actions_*.json`.
- **Test** : `test_golden_fixtures_load` — chaque fichier se charge et
  respecte la forme attendue (clés présentes, pas de champ vide non
  documenté).
- **Critères de la spec couverts** : aucun (fondation requise par toutes
  les tâches suivantes).
- **Terminée quand** : `test_golden_fixtures_load` passe et les six cas
  listés ci-dessus sont chacun présents dans au moins un fichier.
- **Dépend de** : aucune.

### T2 — Parser la correspondance ticker → CIK
- **Objectif** : produire `ticker_cik.parquet` à partir de
  `company_tickers.json`, CIK complété à 10 chiffres.
- **Fichiers** : `src/dashboard/ingestion/edgar_tickers.py`,
  `tests/unit/test_edgar_tickers.py`.
- **Test** : `test_edgar_tickers_pads_cik_to_ten_digits` — vérifie le
  format du CIK et la présence de `ticker`, `name`, `as_of`.
- **Critères de la spec couverts** : aucun directement (support identité).
- **Terminée quand** : le test passe sur la fixture T1.
- **Dépend de** : T1.

### T3 — Parser l'historique des dépôts
- **Objectif** : produire `filings.parquet` (accn, form, filed,
  period_of_report) à partir de la réponse submissions d'EDGAR.
- **Fichiers** : `src/dashboard/ingestion/edgar_submissions.py`,
  `tests/unit/test_edgar_submissions_filings.py`.
- **Test** : `test_edgar_submissions_parses_filing_history` — chaque dépôt
  de la fixture apparaît avec son `accn` et sa date `filed`.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 9, prouvé en T53).
- **Terminée quand** : le test passe sur la fixture T1.
- **Dépend de** : T1.

### T4 — Parser le code SIC et la nature de l'émetteur
- **Objectif** : produire `sic_codes.parquet` (sic, sic_description,
  entity_type, as_of) à partir de la même réponse submissions.
- **Fichiers** : `src/dashboard/ingestion/edgar_submissions.py` (même
  module que T3, fonction distincte), `tests/unit/test_edgar_submissions_sic.py`.
- **Test** : `test_edgar_submissions_parses_sic_and_entity_type` — le code
  SIC et `entity_type` de chaque émetteur de la fixture (y compris le cas
  SIC 6000–6799 et le cas fonds/ETF) sont correctement extraits.
- **Critères de la spec couverts** : aucun directement (prérequis des
  critères 14, 23, prouvés en T26).
- **Terminée quand** : le test passe sur la fixture T1.
- **Dépend de** : T1.

### T5 — Ingérer les fondamentaux `us-gaap`, rejeter l'IFRS
- **Objectif** : produire `fundamentals_raw.parquet` à partir de
  `companyfacts`, en ne retenant que la taxonomie `us-gaap`.
- **Fichiers** : `src/dashboard/ingestion/edgar_facts.py`,
  `tests/unit/test_edgar_facts_taxonomy.py`.
- **Test** : `test_ifrs_taxonomy_excluded` — un émetteur `ifrs-full` de la
  fixture n'apparaît dans aucune ligne de `fundamentals_raw.parquet`.
- **Critères de la spec couverts** : #5.
- **Terminée quand** : le test passe sur la fixture T1.
- **Dépend de** : T1.

### T6 — Conserver les retraitements sans déduplication
- **Objectif** : garantir que deux dépôts pour le même `(cik, concept,
  end)` avec des `filed` différents produisent deux lignes distinctes.
- **Fichiers** : `src/dashboard/ingestion/edgar_facts.py`,
  `tests/unit/test_edgar_facts_restatement.py`.
- **Test** : `test_edgar_facts_ingestion_no_dedup_on_restatement` — les
  deux valeurs du cas de retraitement de la fixture sont toutes deux
  présentes après ingestion.
- **Critères de la spec couverts** : #3 (volet ingestion).
- **Terminée quand** : le test passe sur la fixture T1.
- **Dépend de** : T5.

### T7 — Ingérer les prix bruts et ajustés séparément
- **Objectif** : produire `prices_raw.parquet` et `prices_adjusted.parquet`
  comme deux tables distinctes à partir du bulk EODHD.
- **Fichiers** : `src/dashboard/ingestion/eodhd_prices.py`,
  `tests/unit/test_eodhd_prices.py`.
- **Test** : `test_prices_raw_and_adjusted_written_separately` — les deux
  fichiers existent, aucune colonne ajustée dans `prices_raw`, aucune
  colonne brute dans `prices_adjusted`.
- **Critères de la spec couverts** : #4 (volet ingestion).
- **Terminée quand** : le test passe sur la fixture T1.
- **Dépend de** : T1.

### T8 — Ingérer les opérations sur titres
- **Objectif** : produire `corporate_actions.parquet` (splits, dividendes)
  à partir du bulk EODHD.
- **Fichiers** : `src/dashboard/ingestion/eodhd_actions.py`,
  `tests/unit/test_eodhd_actions.py`.
- **Test** : `test_corporate_actions_parsed` — le fractionnement de la
  fixture apparaît avec son ratio et sa date d'effet.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 4, prouvé en T39).
- **Terminée quand** : le test passe sur la fixture T1.
- **Dépend de** : T1.

### T9 — Masquer les secrets dans un texte
- **Objectif** : `ingestion.secrets.redact` remplace, dans un texte, toute
  occurrence d'un secret configuré par un marqueur non exploitable.
- **Fichiers** : `src/dashboard/ingestion/secrets.py`,
  `tests/unit/test_secrets_redact.py`.
- **Test** : `test_redact_masks_configured_secret` — un texte contenant une
  clé factice fournie en paramètre ne la contient plus après `redact` ; un
  texte sans cette clé reste inchangé caractère pour caractère.
- **Critères de la spec couverts** : aucun directement (prérequis
  Invariant 10, prouvé en T12).
- **Terminée quand** : le test passe.
- **Dépend de** : aucune.

### T10 — Client EDGAR : User-Agent, débit limité, échec explicite
- **Objectif** : `ingestion.edgar_client.get_json` envoie le User-Agent
  configuré, respace les appels d'au moins 100 ms (10 req/s), et lève une
  exception explicite si le transport échoue — jamais un résultat vide ou
  partiel.
- **Fichiers** : `src/dashboard/ingestion/edgar_client.py`,
  `tests/unit/test_edgar_client.py`.
- **Test** : `test_edgar_client_user_agent_throttle_and_explicit_failure` —
  avec un transport et une horloge factices injectés (aucun réseau réel) :
  le header envoyé porte le User-Agent attendu ; un second appel immédiat
  déclenche une attente calculée par le limiteur ; un transport qui échoue
  fait lever une exception, jamais un `dict` vide.
- **Critères de la spec couverts** : aucun directement (prérequis
  Invariant 10 ; base réseau pour T49 et suivants).
- **Terminée quand** : le test passe.
- **Dépend de** : aucune.

### T11 — Client EODHD : authentification par clé, échec explicite
- **Objectif** : `ingestion.eodhd_client.get_json` authentifie chaque
  requête par la clé configurée et lève une exception explicite si le
  transport échoue.
- **Fichiers** : `src/dashboard/ingestion/eodhd_client.py`,
  `tests/unit/test_eodhd_client.py`.
- **Test** : `test_eodhd_client_authenticates_and_raises_on_failure` — avec
  un transport factice injecté : la clé configurée apparaît dans la requête
  envoyée (paramètre d'authentification) ; un transport qui échoue fait
  lever une exception, jamais un résultat vide.
- **Critères de la spec couverts** : aucun directement (prérequis
  Invariant 10 ; base réseau pour T49 et suivants).
- **Terminée quand** : le test passe.
- **Dépend de** : aucune.

### T12 — Ne jamais exposer une clé d'API dans une erreur réseau réelle
- **Objectif** : un échec réel du transport HTTP dans l'un ou l'autre
  client ne laisse la clé apparaître ni dans le message d'exception, ni
  dans sa trace, ni dans un journal.
- **Fichiers** : `src/dashboard/ingestion/edgar_client.py`,
  `src/dashboard/ingestion/eodhd_client.py`,
  `tests/unit/test_no_secrets_leaked.py`.
- **Test** : `test_no_api_key_in_logs_or_errors` — provoque, pour chaque
  client, un échec de transport factice dont le message brut contient
  l'URL complète avec la clé de test en chaîne de requête ; vérifie que la
  clé n'apparaît nulle part dans `str(exception)`, dans la trace formatée,
  ni dans les journaux capturés. Le test échoue si l'appel à
  `secrets.redact` est retiré du chemin d'erreur des clients.
- **Critères de la spec couverts** : Invariant 10.
- **Terminée quand** : le test passe pour les deux clients.
- **Dépend de** : T9, T10, T11.

### T13 — Fournir l'heure système en UTC, en un point unique
- **Objectif** : `ingestion.clock.now` est l'unique point d'accès à l'heure
  système du projet, et renvoie toujours un instant explicitement en UTC
  (invariant 5).
- **Fichiers** : `src/dashboard/ingestion/clock.py`,
  `tests/unit/test_clock.py`.
- **Test** : `test_clock_now_returns_utc_aware_datetime` — le résultat est
  un `datetime` dont le fuseau est explicitement UTC (jamais naïf, jamais
  local), et sa valeur est à quelques secondes de l'heure réelle au moment
  de l'appel — pas une valeur figée ou incohérente.
- **Critères de la spec couverts** : aucun directement (support invariant
  5 ; `calc.market_calendar`, T16, reçoit déjà l'instant en paramètre et ne
  lit jamais l'horloge lui-même — c'est `ingestion.clock` qui la lui
  fournira depuis `pipeline.daily_run`).
- **Terminée quand** : le test passe.
- **Dépend de** : aucune.

## Calcul — fondations point-in-time et calendrier

### T14 — Refuser tout look-ahead
- **Objectif** : `calc.point_in_time` ne renvoie jamais une valeur dont
  `filed > t`.
- **Fichiers** : `src/dashboard/calc/point_in_time.py`,
  `tests/calc/test_point_in_time.py`.
- **Test** : `test_point_in_time_rejects_future_filed` — pour un concept
  ayant un dépôt après `t`, seule la valeur antérieure ou égale à `t` est
  retournée.
- **Critères de la spec couverts** : #1.
- **Terminée quand** : le test passe sur la fixture T1.
- **Dépend de** : T5.

### T15 — Résoudre la dernière valeur connue malgré un retraitement
- **Objectif** : `calc.point_in_time` retourne la valeur du dépôt le plus
  récent avec `filed ≤ t`, sans que le dépôt antérieur ne disparaisse du
  stockage.
- **Fichiers** : `src/dashboard/calc/point_in_time.py`,
  `tests/calc/test_point_in_time_restatement.py`.
- **Test** : `test_restatement_latest_value_history_preserved` — sur le
  cas de retraitement de la fixture, la résolution à `t` avant et après le
  second dépôt donne deux résultats différents, et les deux valeurs restent
  individuellement interrogeables.
- **Critères de la spec couverts** : #3 (volet calcul).
- **Terminée quand** : le test passe.
- **Dépend de** : T6.

### T16 — Résoudre la dernière séance de bourse effective
- **Objectif** : `calc.market_calendar.last_session` ne lit jamais
  l'horloge système et résout correctement un jour non ouvré.
- **Fichiers** : `src/dashboard/calc/market_calendar.py`,
  `tests/calc/test_market_calendar.py`.
- **Test** : `test_last_session_not_calendar_today` — pour un `instant`
  fourni tombant un dimanche ou un jour férié du calendrier américain, la
  séance retournée est la dernière séance effective, jamais la date fournie
  telle quelle.
- **Critères de la spec couverts** : #8.
- **Terminée quand** : le test passe.
- **Dépend de** : T1.

## Calcul — grandeurs dérivées (bridges)

### T17 — Chaîne de repli des actions en circulation
- **Objectif** : `calc.shares_bridge` applique la chaîne de tags définie
  dans le plan et signale le statut calculable/non calculable.
- **Fichiers** : `src/dashboard/calc/shares_bridge.py`,
  `tests/calc/test_shares_bridge.py`.
- **Test** : `test_shares_bridge_fallback_chain` — trois émetteurs de la
  fixture, un par niveau de repli, plus un cas sans aucun tag disponible
  (non calculable).
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11, prouvé en T38).
- **Terminée quand** : le test passe.
- **Dépend de** : T5.

### T18 — Chaîne de repli de l'EBIT
- **Objectif** : `calc.ebit_bridge` (et `calc.interest_bridge` pour son
  repli) applique la chaîne définie dans le plan.
- **Fichiers** : `src/dashboard/calc/ebit_bridge.py`,
  `src/dashboard/calc/interest_bridge.py`,
  `tests/calc/test_ebit_bridge.py`.
- **Test** : `test_ebit_bridge_fallback_chain` — un émetteur avec
  `OperatingIncomeLoss`, un sans (reconstruction depuis le résultat net),
  un sans aucun des deux (non calculable).
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T5.

### T19 — D&A et EBITDA
- **Objectif** : `calc.dna_bridge` applique sa chaîne de repli ;
  `calc.ebitda` compose EBIT + D&A.
- **Fichiers** : `src/dashboard/calc/dna_bridge.py`,
  `src/dashboard/calc/ebitda.py`, `tests/calc/test_ebitda.py`.
- **Test** : `test_ebitda_composes_ebit_and_dna` — EBITDA correct quand les
  deux composantes sont calculables, non calculable si l'une manque.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T18.

### T20 — Chaîne de repli du free cash flow
- **Objectif** : `calc.fcf_bridge` applique la chaîne CFO − CapEx définie
  dans le plan, avec ses replis.
- **Fichiers** : `src/dashboard/calc/fcf_bridge.py`,
  `tests/calc/test_fcf_bridge.py`.
- **Test** : `test_fcf_bridge_fallback_chain` — cas primaire, cas de repli
  CapEx, cas de repli CFO, cas non calculable.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T5.

### T21 — Chaîne de repli de la dette totale
- **Objectif** : `calc.debt_bridge` somme les composantes trouvées, sans
  repli à zéro en cas d'absence totale.
- **Fichiers** : `src/dashboard/calc/debt_bridge.py`,
  `tests/calc/test_debt_bridge.py`.
- **Test** : `test_debt_bridge_sums_available_components` — un émetteur
  avec dette long terme et courante, un émetteur sans aucune composante
  trouvée (non calculable, pas zéro).
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T5.

### T22 — Chaîne de repli de la trésorerie
- **Objectif** : `calc.cash_bridge` applique sa chaîne de repli, sans
  inclure les placements à court terme.
- **Fichiers** : `src/dashboard/calc/cash_bridge.py`,
  `tests/calc/test_cash_bridge.py`.
- **Test** : `test_cash_bridge_fallback_chain` — cas primaire, cas de
  repli, cas non calculable.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T5.

### T23 — Chaîne de repli des capitaux propres
- **Objectif** : `calc.equity_bridge` applique sa chaîne de repli.
- **Fichiers** : `src/dashboard/calc/equity_bridge.py`,
  `tests/calc/test_equity_bridge.py`.
- **Test** : `test_equity_bridge_fallback_chain` — cas primaire, cas de
  repli, cas non calculable.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T5.

### T24 — Dette nette
- **Objectif** : `calc.net_debt` calcule dette totale − trésorerie.
- **Fichiers** : `src/dashboard/calc/net_debt.py`,
  `tests/calc/test_net_debt.py`.
- **Test** : `test_net_debt_formula` — valeur correcte quand les deux
  composantes sont calculables, non calculable sinon.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11 ; utilisé par T34, dette nette/EBITDA).
- **Terminée quand** : le test passe.
- **Dépend de** : T21, T22.

### T25 — Capital investi
- **Objectif** : `calc.invested_capital` calcule dette totale + capitaux
  propres − trésorerie, non calculable pour le ROIC si le résultat est ≤ 0.
- **Fichiers** : `src/dashboard/calc/invested_capital.py`,
  `tests/calc/test_invested_capital.py`.
- **Test** : `test_invested_capital_formula_and_non_positive_case` — cas
  positif, cas où le résultat est négatif ou nul.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T21, T22, T23.

## Calcul — univers défini par règle

### T26 — Exclure SIC 6000–6799 et les fonds/ETF
- **Objectif** : `calc.universe` applique sa règle d'exclusion (étape 1)
  avant tout classement.
- **Fichiers** : `src/dashboard/calc/universe.py`,
  `tests/calc/test_universe_exclusions.py`.
- **Test** : `test_universe_exclusions` — l'émetteur SIC 6000–6799 et
  l'émetteur `entity_type` fonds/ETF de la fixture sont tous deux absents
  du résultat.
- **Critères de la spec couverts** : #14, #23.
- **Terminée quand** : le test passe.
- **Dépend de** : T4.

### T27 — Classer par capitalisation lissée sur 20 séances
- **Objectif** : `calc.universe` calcule la capitalisation à partir des
  actions en circulation point-in-time et de la moyenne du cours ajusté sur
  20 séances, puis classe les titres.
- **Fichiers** : `src/dashboard/calc/universe.py`,
  `tests/calc/test_universe_ranking.py`.
- **Test** : `test_universe_ranking_uses_smoothed_market_cap` — un titre
  dont le cours du jour est anormal mais dont la moyenne sur 20 séances est
  stable garde un rang cohérent avec cette moyenne, pas avec le cours du
  jour seul.
- **Critères de la spec couverts** : aucun directement (prérequis des
  critères 24, 25).
- **Terminée quand** : le test passe.
- **Dépend de** : T17, T7, T26.

### T28 — Appliquer l'hystérésis au rang de coupure
- **Objectif** : un titre déjà dans l'univers reste jusqu'au rang N+buffer,
  un titre absent n'entre qu'au rang N−buffer.
- **Fichiers** : `src/dashboard/calc/universe.py`,
  `tests/calc/test_universe_hysteresis.py`.
- **Test** : `test_universe_stable_near_cutoff_with_hysteresis` — un titre
  dont le rang oscille entre 850 et 950 d'un jour à l'autre garde le même
  statut d'appartenance sur toute la séquence.
- **Critères de la spec couverts** : #24.
- **Terminée quand** : le test passe.
- **Dépend de** : T27.

### T29 — Échouer bruyamment si la taille de l'univers est implausible
- **Objectif** : `calc.universe` renvoie un échec explicite si le nombre
  de titres résultant sort de la plage configurée, plutôt qu'un univers
  tronqué.
- **Fichiers** : `src/dashboard/calc/universe.py`,
  `tests/calc/test_universe_plausibility.py`.
- **Test** : `test_universe_failure_on_implausible_size` — une fixture où
  l'essentiel des titres est artificiellement exclu produit un échec
  explicite, pas un univers de quelques titres affiché comme normal.
- **Critères de la spec couverts** : #25 (volet calcul).
- **Terminée quand** : le test passe.
- **Dépend de** : T26, T27, T28.

## Calcul — indicateurs et ratios

### T30 — Valeur d'entreprise
- **Objectif** : `calc.ev` calcule capitalisation + dette nette.
- **Fichiers** : `src/dashboard/calc/ev.py`, `tests/calc/test_ev.py`.
- **Test** : `test_ev_formula` — valeur correcte, non calculable si la
  dette nette l'est.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T24, T27.

### T31 — NOPAT avec taux d'imposition plafonné
- **Objectif** : calculer le taux d'imposition effectif borné à [0 %,
  50 %], avec repli à 21 % si le résultat avant impôt n'est pas
  strictement positif.
- **Fichiers** : `src/dashboard/calc/nopat.py`, `tests/calc/test_nopat.py`.
- **Test** : `test_nopat_tax_rate_capping_and_fallback` — cas de résultat
  avant impôt positif dans la bande, cas hors bande (plafonné), cas
  négatif ou nul (repli à 21 %).
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T18, T14.

### T32 — ROIC
- **Objectif** : `calc.roic` = NOPAT / capital investi, non calculable si
  le capital investi est ≤ 0.
- **Fichiers** : `src/dashboard/calc/roic.py`, `tests/calc/test_roic.py`.
- **Test** : `test_roic_formula_and_non_positive_invested_capital` — cas
  normal, cas capital investi ≤ 0.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T31, T25.

### T33 — EV/EBIT non calculable sur EBIT non positif
- **Objectif** : l'indicateur EV/EBIT est signalé non calculable quand
  l'EBIT (TTM) est ≤ 0.
- **Fichiers** : `src/dashboard/calc/ratios.py`,
  `tests/calc/test_ev_ebit_non_positive.py`.
- **Test** : `test_ev_ebit_non_calculable_on_non_positive_ebit` — un
  émetteur en perte opérationnelle de la fixture n'a pas de valeur EV/EBIT
  numérique.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T18, T30.

### T34 — Dette nette/EBITDA non calculable sur EBITDA non positif
- **Objectif** : même règle que T33 pour l'indicateur de solvabilité.
- **Fichiers** : `src/dashboard/calc/ratios.py`,
  `tests/calc/test_net_debt_ebitda_non_positive.py`.
- **Test** : `test_net_debt_ebitda_non_calculable_on_non_positive_ebitda`.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T19, T24.

### T35 — TTM primaire et médiane 5 ans secondaire
- **Objectif** : `calc.ttm` agrège quatre trimestres glissants,
  `calc.normalized_5y` calcule la médiane sur cinq exercices.
- **Fichiers** : `src/dashboard/calc/ttm.py`,
  `src/dashboard/calc/normalized_5y.py`, `tests/calc/test_ttm_and_5y.py`.
- **Test** : `test_ttm_and_5y_median_computed` — les deux valeurs sont
  produites et diffèrent sur un cas de fixture conçu pour cela.
- **Critères de la spec couverts** : #12.
- **Terminée quand** : le test passe.
- **Dépend de** : T14.

### T36 — Signaler la divergence TTM / normalisé
- **Objectif** : `calc.divergence` signale un titre quand l'écart entre
  percentile TTM et percentile normalisé dépasse le seuil configuré.
- **Fichiers** : `src/dashboard/calc/divergence.py`,
  `tests/calc/test_divergence.py`.
- **Test** : `test_divergence_flag_above_threshold` — cas au-dessus du
  seuil (signalé), cas en dessous (non signalé).
- **Critères de la spec couverts** : #13.
- **Terminée quand** : le test passe.
- **Dépend de** : T35.

### T37 — Signaler un indicateur non calculable, jamais de valeur par défaut
- **Objectif** : `calc.ratios` porte un statut calculable/non calculable
  par indicateur et par titre, sans jamais inventer de valeur.
- **Fichiers** : `src/dashboard/calc/ratios.py`,
  `tests/calc/test_ratios_missing_data.py`.
- **Test** : `test_missing_fundamental_flagged` — un titre dont une
  composante d'un seul indicateur est absente a ce seul indicateur signalé
  non calculable, les cinq autres restent produits normalement.
- **Critères de la spec couverts** : #6.
- **Terminée quand** : le test passe.
- **Dépend de** : T33, T34, T32.

### T38 — Rapporter le taux de couverture par indicateur
- **Objectif** : le pipeline rapporte, pour chaque indicateur, le nombre
  de titres calculables sur le nombre total.
- **Fichiers** : `src/dashboard/calc/ratios.py`,
  `tests/calc/test_coverage_rate.py`.
- **Test** : `test_coverage_rate_reported_per_indicator` — sur une fixture
  à couverture partielle connue, le taux rapporté correspond exactement au
  compte attendu pour chacun des six indicateurs.
- **Critères de la spec couverts** : #11.
- **Terminée quand** : le test passe.
- **Dépend de** : T37.

### T39 — Ne jamais mélanger prix bruts et ajustés dans un calcul
- **Objectif** : `calc.ratios` (et tout calcul de variation de prix)
  n'utilise que la série ajustée pour toute période chevauchant un
  fractionnement.
- **Fichiers** : `src/dashboard/calc/ratios.py`,
  `tests/calc/test_no_raw_adjusted_mixing.py`.
- **Test** : `test_no_raw_adjusted_mixing` — sur le cas de fractionnement
  de la fixture, le résultat calculé avec la série brute seule diffère du
  résultat produit par le pipeline, qui doit correspondre à la série
  ajustée.
- **Critères de la spec couverts** : #4 (volet calcul).
- **Terminée quand** : le test passe.
- **Dépend de** : T7, T37.

### T40 — Devise explicite, sans conversion implicite
- **Objectif** : chaque valeur produite par `calc.ratios` porte sa devise,
  toujours USD dans cette tranche, jamais convertie silencieusement.
- **Fichiers** : `src/dashboard/calc/ratios.py`,
  `tests/calc/test_currency_explicit.py`.
- **Test** : `test_currency_explicit_no_conversion` — le résultat de deux
  titres comparés porte la même devise déclarée, aucune opération de
  conversion n'est appliquée dans le chemin de calcul.
- **Critères de la spec couverts** : #10.
- **Terminée quand** : le test passe.
- **Dépend de** : T37.

### T41 — Percentile face à l'histoire propre, années disponibles affichées
- **Objectif** : `calc.percentiles` calcule le percentile du multiple
  primaire sur l'historique depuis 2011 et le nombre d'années réellement
  disponibles.
- **Fichiers** : `src/dashboard/calc/percentiles.py`,
  `tests/calc/test_own_history_percentile.py`.
- **Test** : `test_own_history_percentile_and_years` — un émetteur introduit
  en 2019 dans la fixture affiche six ans d'historique, pas plus.
- **Critères de la spec couverts** : #19.
- **Terminée quand** : le test passe.
- **Dépend de** : T37.

### T42 — Classer un code SIC dans sa division officielle
- **Objectif** : `calc.sector_grouping` classe le code SIC d'un titre dans
  l'une des neuf divisions SIC officielles définies dans le plan, non
  calculable si le code sort des plages couvertes.
- **Fichiers** : `src/dashboard/calc/sector_grouping.py`,
  `tests/calc/test_sector_grouping.py`. Étend
  `tests/golden/raw/edgar_submissions_0000000005.json` (nouvel émetteur,
  SIC de services, ex. 7372) pour disposer d'au moins deux divisions
  distinctes dans la fixture, en plus du cas hors plage (ex. SIC 1850).
- **Test** : `test_sector_grouping_classifies_by_sic_division` — le SIC
  3674 d'Alpha est classé en division D (industrie manufacturière), le SIC
  7372 du nouvel émetteur en division I (services), et un SIC hors plage
  (1850) est signalé non calculable, jamais rattaché par défaut à une
  division voisine.
- **Critères de la spec couverts** : aucun directement (prérequis des
  critères 19, 20 ; #20 est prouvé en T43 en s'appuyant sur ce
  regroupement).
- **Terminée quand** : le test passe.
- **Dépend de** : T4.

### T43 — Repli sur l'absolu si le groupe sectoriel a moins de dix titres
- **Objectif** : `calc.percentiles` ne calcule pas de percentile sectoriel
  pour un groupe grossier de moins de dix titres et le signale.
- **Fichiers** : `src/dashboard/calc/percentiles.py`,
  `tests/calc/test_sector_percentile_fallback.py`.
- **Test** : `test_sector_percentile_fallback_below_10` — un groupe
  sectoriel de la fixture réduit à moins de dix titres n'a pas de
  percentile sectoriel, `sector_pct_available` vaut faux.
- **Critères de la spec couverts** : #20.
- **Terminée quand** : le test passe.
- **Dépend de** : T41, T42.

### T44 — Filtrer avec des seuils configurables, compteur y compris zéro
- **Objectif** : `calc.filters` applique des seuils reçus en paramètre et
  retourne systématiquement le compteur de titres retenus.
- **Fichiers** : `src/dashboard/calc/filters.py`,
  `tests/calc/test_filters.py`.
- **Test** : `test_filter_count_including_zero` — un jeu de seuils
  n'excluant aucun titre, et un jeu de seuils excluant tous les titres
  (compteur à zéro, sans erreur).
- **Critères de la spec couverts** : #15.
- **Terminée quand** : le test passe.
- **Dépend de** : T37.

### T45 — Classer et plafonner à 25
- **Objectif** : `calc.ranking` classe les titres retenus et n'en affiche
  jamais plus de 25.
- **Fichiers** : `src/dashboard/calc/ranking.py`,
  `tests/calc/test_ranking.py`.
- **Test** : `test_ranking_capped_at_25` — une fixture à 40 titres retenus
  ne produit que 25 lignes classées.
- **Critères de la spec couverts** : #16.
- **Terminée quand** : le test passe.
- **Dépend de** : T44.

## Stockage et persistance

### T46 — Historique du screen en ajout seul
- **Objectif** : `storage.screen_history` ajoute une ligne par titre par
  jour dans `screen_results.parquet` et refuse d'écraser une ligne
  existante pour `(date, cik)`.
- **Fichiers** : `src/dashboard/storage/screen_history.py`,
  `tests/storage/test_screen_history.py`.
- **Test** : `test_screen_history_never_rewritten` — un second appel pour
  la même date et le même titre lève une erreur explicite plutôt que
  d'écraser la ligne.
- **Critères de la spec couverts** : #17.
- **Terminée quand** : le test passe.
- **Dépend de** : T45.

### T47 — Historique d'appartenance à l'univers en ajout seul
- **Objectif** : `storage.universe_history` ajoute une ligne par titre par
  jour, jamais élaguée.
- **Fichiers** : `src/dashboard/storage/universe_history.py`,
  `tests/storage/test_universe_history.py`.
- **Test** : `test_membership_table_append_only` — après plusieurs jours
  de traitement simulés, toutes les lignes précédentes sont toujours
  présentes et inchangées.
- **Critères de la spec couverts** : #22.
- **Terminée quand** : le test passe.
- **Dépend de** : T29.

### T48 — Compter les jours consécutifs passés
- **Objectif** : `calc.streak` calcule, à partir de l'historique du
  screen, le nombre de jours consécutifs où un titre passe les filtres.
- **Fichiers** : `src/dashboard/calc/streak.py`,
  `tests/calc/test_streak.py`.
- **Test** : `test_consecutive_days_streak` — un titre présent 5 jours de
  suite puis absent un jour affiche une série de 5, pas 6.
- **Critères de la spec couverts** : #18.
- **Terminée quand** : le test passe.
- **Dépend de** : T46.

## Orchestration

### T49 — Le traitement quotidien reflète la clôture et les dépôts connus
- **Objectif** : `pipeline.daily_run` produit un résultat qui n'utilise
  que les cours de clôture du jour et les dépôts SEC connus jusqu'à cette
  date.
- **Fichiers** : `src/dashboard/pipeline/daily_run.py`,
  `tests/pipeline/test_daily_run.py`.
- **Test** : `test_daily_run_uses_close_and_known_filings` — un dépôt
  postérieur à la date de traitement simulée n'apparaît dans aucun résultat
  produit pour cette date.
- **Critères de la spec couverts** : #7.
- **Terminée quand** : le test passe.
- **Dépend de** : T16, T14, T5, T7.

### T50 — Arrêter le traitement si le calcul de l'univers échoue
- **Objectif** : `pipeline.daily_run` n'écrit aucun résultat et n'affiche
  pas d'écran pour le jour si `calc.universe` renvoie un échec.
- **Fichiers** : `src/dashboard/pipeline/daily_run.py`,
  `tests/pipeline/test_daily_run_universe_failure.py`.
- **Test** : `test_universe_failure_halts_pipeline` — sur le cas de fixture
  d'univers implausible (T29), aucune ligne n'est ajoutée à
  `screen_results.parquet` ni à `universe_membership.parquet` pour ce jour.
- **Critères de la spec couverts** : #25 (volet orchestration).
- **Terminée quand** : le test passe.
- **Dépend de** : T29, T49.

## Présentation

### T51 — Exclure du screen les titres sortis de l'univers du jour
- **Objectif** : un titre qui ne fait plus partie de l'univers défini par
  règle n'apparaît pas dans le résultat du jour.
- **Fichiers** : `src/dashboard/calc/filters.py` ou
  `src/dashboard/pipeline/daily_run.py`, `tests/pipeline/test_screen_excludes_non_members.py`.
- **Test** : `test_screen_excludes_non_members` — un titre présent la
  veille mais sorti de l'univers aujourd'hui (hors hystérésis) n'apparaît
  pas dans le résultat du jour.
- **Critères de la spec couverts** : #2.
- **Terminée quand** : le test passe.
- **Dépend de** : T29, T44.

### T52 — Préserver les données d'un titre sorti de l'univers
- **Objectif** : les fondamentaux et l'historique de screen d'un titre
  sorti de l'univers restent intacts et consultables.
- **Fichiers** : `tests/pipeline/test_delisted_ticker_history_preserved.py`.
- **Test** : `test_delisted_ticker_history_preserved` — après la sortie
  simulée d'un titre de l'univers, ses lignes dans `fundamentals_raw`,
  `screen_results` et `universe_membership` restent lisibles et inchangées.
- **Critères de la spec couverts** : #21.
- **Terminée quand** : le test passe.
- **Dépend de** : T29, T46, T47.

### T53 — Tracer tout nombre affiché jusqu'à sa source
- **Objectif** : `app.detail_view` permet de remonter, pour tout nombre
  affiché, jusqu'au champ source, sa date de fin d'exercice, sa date de
  dépôt et son numéro de dépôt — ou, pour un prix, sa date de cotation.
- **Fichiers** : `src/dashboard/app/detail_view.py`,
  `tests/app/test_detail_view_traceability.py`.
- **Test** : `test_every_displayed_number_traceable` — pour chacun des six
  indicateurs d'un titre de la fixture, la fonction de détail retourne le
  ou les tags, `end`, `filed` et `accn` correspondants.
- **Critères de la spec couverts** : #9.
- **Terminée quand** : le test passe.
- **Dépend de** : T3, T37, T49.

### T54 — Ne jamais présenter l'écran comme une mesure d'un indice publié
- **Objectif** : `app.screen_view` porte une mention explicite que
  l'univers est défini par nous, et aucune statistique n'est étiquetée
  S&P 500 ou S&P 400.
- **Fichiers** : `src/dashboard/app/screen_view.py`,
  `tests/app/test_screen_view_no_index_label.py`.
- **Test** : `test_no_index_label_in_ui` — le texte rendu par la vue ne
  contient aucune occurrence de « S&P » associée à une statistique du
  screen, et contient la mention d'univers défini par règle.
- **Critères de la spec couverts** : #26.
- **Terminée quand** : le test passe.
- **Dépend de** : T49, T51.

## Vérification de couverture

### Critères de la spec

Union des critères couverts : #1 (T14), #2 (T51), #3 (T6, T15), #4 (T7,
T39), #5 (T5), #6 (T37), #7 (T49), #8 (T16), #9 (T53), #10 (T40), #11
(T38), #12 (T35), #13 (T36), #14 (T26), #15 (T44), #16 (T45), #17 (T46),
#18 (T48), #19 (T41), #20 (T43), #21 (T52), #22 (T47), #23 (T26), #24
(T28), #25 (T29, T50), #26 (T54), Invariant 10 (T12).

Les 26 critères d'acceptation de spec.md et l'invariant 10 sont couverts.
Aucun critère orphelin.

### Modules de plan.md

Contrôle appliqué une deuxième fois après l'amendement de
`.claude/skills/spec-tasks/SKILL.md`. Les 38 modules nommés dans `plan.md`
sont chacun couverts par au moins une tâche, y compris les trois ajoutés
lors de l'amendement réseau (`ingestion.edgar_client`, T10 ;
`ingestion.eodhd_client`, T11 ; `ingestion.secrets`, T9) et les deux
découverts ensuite (`ingestion.clock`, T13 ; `calc.sector_grouping`, T42).

Aucun module orphelin.

