# Tasks 0001

Convention de chemins : `src/dashboard/<module>.py` reflète le nom pointé du
plan (`ingestion.edgar_tickers` → `src/dashboard/ingestion/edgar_tickers.py`,
`calc.ebit_bridge` → `src/dashboard/calc/ebit_bridge.py`, etc.), tests sous
`tests/` en miroir, fixtures figées sous `tests/golden/`. Les tests de contact
(invariant 9, marqueur pytest `contact`) vivent sous `tests/contact/`, hors du
miroir habituel, pour rester trivialement exclus par un filtre de chemin si
`addopts` venait à changer.

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
  critère 9, prouvé en T61).
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
  critères 14, 23, prouvés en T34).
- **Terminée quand** : le test passe sur la fixture T1.
- **Dépend de** : T1.

### T5 — Ingérer les fondamentaux, rejeter les émetteurs IFRS
- **Objectif** : produire `fundamentals_raw.parquet` à partir de
  `companyfacts`, en ne retenant que les taxonomies `us-gaap` et `dei`
  (liste blanche) — un émetteur `ifrs-full` produit alors zéro ligne,
  faute de fait dans l'une ou l'autre.
- **Fichiers** : `src/dashboard/ingestion/edgar_facts.py`,
  `tests/unit/test_edgar_facts_taxonomy.py`.
- **Test** : `test_ifrs_taxonomy_excluded` — un émetteur `ifrs-full` de la
  fixture n'apparaît dans aucune ligne de `fundamentals_raw.parquet` ;
  un émetteur `us-gaap` conserve à la fois ses faits `us-gaap` et `dei`
  (amendement : `dei:EntityCommonStockSharesOutstanding`, nécessaire à
  T25, appartient à la taxonomie `dei`, distincte de `us-gaap` — un filtre
  à `us-gaap` seul l'aurait aussi exclu par erreur).
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

### T7 — Compter les faits rejetés par taxonomie
- **Objectif** : `ingestion.edgar_facts` compte, par taxonomie hors liste
  blanche `{us-gaap, dei}`, le nombre de faits rejetés — jamais un rejet
  silencieux et non comptabilisé (amendement de T5 : liste blanche plutôt
  que liste noire, R1/invariant 7).
- **Fichiers** : `src/dashboard/ingestion/edgar_facts.py`,
  `tests/unit/test_edgar_facts_rejected_taxonomies.py`.
- **Test** : `test_edgar_facts_counts_rejected_taxonomies` — l'émetteur
  `ifrs-full` de la fixture donne `{"ifrs-full": 1}` ; l'émetteur `us-gaap`
  (dont les faits sont tous dans la liste blanche) donne `{}`, explicitement
  vide plutôt qu'absent.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11 et de l'invariant 7 ; le report effectif dans l'écran
  quotidien reste à câbler dans `pipeline.daily_run`, hors périmètre de
  cette tâche).
- **Terminée quand** : le test passe.
- **Dépend de** : T5.

### T8 — Ingérer les prix bruts et ajustés séparément
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

### T9 — Ingérer les opérations sur titres
- **Objectif** : produire `corporate_actions.parquet` (splits, dividendes)
  à partir du bulk EODHD.
- **Fichiers** : `src/dashboard/ingestion/eodhd_actions.py`,
  `tests/unit/test_eodhd_actions.py`.
- **Test** : `test_corporate_actions_parsed` — le fractionnement de la
  fixture apparaît avec son ratio et sa date d'effet.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 4, prouvé en T47).
- **Terminée quand** : le test passe sur la fixture T1.
- **Dépend de** : T1.

### T10 — Masquer les secrets dans un texte
- **Objectif** : `ingestion.secrets.redact` remplace, dans un texte, toute
  occurrence d'un secret configuré par un marqueur non exploitable.
- **Fichiers** : `src/dashboard/ingestion/secrets.py`,
  `tests/unit/test_secrets_redact.py`.
- **Test** : `test_redact_masks_configured_secret` — un texte contenant une
  clé factice fournie en paramètre ne la contient plus après `redact` ; un
  texte sans cette clé reste inchangé caractère pour caractère.
- **Critères de la spec couverts** : aucun directement (prérequis
  Invariant 10, prouvé en T13).
- **Terminée quand** : le test passe.
- **Dépend de** : aucune.

### T11 — Client EDGAR : User-Agent, débit limité, échec explicite
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
  Invariant 10 ; base réseau pour T14–T16 et T57 et suivants).
- **Terminée quand** : le test passe.
- **Dépend de** : aucune.

### T12 — Client EODHD : authentification par clé, échec explicite
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
  Invariant 10 ; base réseau pour T17–T18 et T57 et suivants).
- **Terminée quand** : le test passe.
- **Dépend de** : aucune.

### T13 — Ne jamais exposer une clé d'API dans une erreur réseau réelle
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
- **Dépend de** : T10, T11, T12.

### T14 — Câbler `fetch_company_tickers` sur le client EDGAR
- **Objectif** : `ingestion.edgar_tickers.fetch_company_tickers(client,
  as_of)` appelle `client.get_json` sur l'URL de `company_tickers.json`
  puis délègue à `parse_company_tickers` déjà écrit — aucune logique de
  parsing dupliquée dans la couche réseau (amendement couche réseau,
  plan.md).
- **Fichiers** : `src/dashboard/ingestion/edgar_tickers.py`,
  `tests/unit/test_edgar_tickers_fetch.py`.
- **Test** : `test_fetch_company_tickers_calls_client_and_parses` — un
  client factice (transport figé sur la fixture T1) est appelé exactement
  une fois sur l'URL attendue (`https://www.sec.gov/files/company_tickers.json`) ;
  le résultat retourné est identique à `parse_company_tickers` appliqué
  directement à cette même fixture.
- **Critères de la spec couverts** : aucun directement (prérequis de
  l'orchestration, câblé dans T57).
- **Terminée quand** : le test passe, aucun appel réseau réel.
- **Dépend de** : T2, T11, T13.

### T15 — Câbler `fetch_submissions` sur le client EDGAR
- **Objectif** : `ingestion.edgar_submissions.fetch_submissions(client,
  cik, as_of)` appelle `client.get_json` une seule fois sur l'URL des
  dépôts (`submissions/CIK##########.json`) et délègue le même `raw` à
  `parse_filings` et `parse_sic_and_entity_type` déjà écrits — un seul
  appel réseau pour alimenter les deux tables.
- **Fichiers** : `src/dashboard/ingestion/edgar_submissions.py`,
  `tests/unit/test_edgar_submissions_fetch.py`.
- **Test** : `test_fetch_submissions_single_call_produces_both_tables` —
  le client factice n'est appelé qu'une fois ; le couple de DataFrames
  retourné est identique à `(parse_filings(raw), parse_sic_and_entity_type(raw,
  as_of))` appliqué à la fixture T1.
- **Critères de la spec couverts** : aucun directement (prérequis de
  l'orchestration, câblé dans T57).
- **Terminée quand** : le test passe, aucun appel réseau réel.
- **Dépend de** : T3, T4, T11, T13.

### T16 — Câbler `fetch_company_facts` sur le client EDGAR
- **Objectif** : `ingestion.edgar_facts.fetch_company_facts(client, cik)`
  appelle `client.get_json` sur l'URL `companyfacts/CIK##########.json` et
  délègue à `parse_company_facts` déjà écrit.
- **Fichiers** : `src/dashboard/ingestion/edgar_facts.py`,
  `tests/unit/test_edgar_facts_fetch.py`.
- **Test** : `test_fetch_company_facts_calls_client_and_parses` — client
  factice appelé une fois sur l'URL attendue ; résultat identique à
  `parse_company_facts` appliqué directement à la fixture T1 (émetteur
  Alpha, us-gaap + dei).
- **Critères de la spec couverts** : aucun directement (prérequis de
  l'orchestration, câblé dans T57).
- **Terminée quand** : le test passe, aucun appel réseau réel.
- **Dépend de** : T5, T11, T13.

### T17 — Câbler `fetch_bulk_prices` sur le client EODHD
- **Objectif** : `ingestion.eodhd_prices.fetch_bulk_prices(client, date)`
  appelle `client.get_json` sur l'URL bulk EODHD du jour et délègue à
  `parse_bulk_prices` déjà écrit.
- **Fichiers** : `src/dashboard/ingestion/eodhd_prices.py`,
  `tests/unit/test_eodhd_prices_fetch.py`.
- **Test** : `test_fetch_bulk_prices_calls_client_and_parses` — client
  factice appelé une fois sur l'URL bulk attendue pour la date donnée ; le
  couple `(prices_raw, prices_adjusted)` retourné est identique à
  `parse_bulk_prices` appliqué directement à la fixture T1.
- **Critères de la spec couverts** : aucun directement (prérequis de
  l'orchestration, câblé dans T57).
- **Terminée quand** : le test passe, aucun appel réseau réel.
- **Dépend de** : T8, T12, T13.

### T18 — Câbler `fetch_bulk_actions` sur le client EODHD
- **Objectif** : `ingestion.eodhd_actions.fetch_bulk_actions(client, date)`
  appelle `client.get_json` sur l'URL bulk EODHD des opérations sur titres
  du jour et délègue à `parse_corporate_actions` déjà écrit.
- **Fichiers** : `src/dashboard/ingestion/eodhd_actions.py`,
  `tests/unit/test_eodhd_actions_fetch.py`.
- **Test** : `test_fetch_bulk_actions_calls_client_and_parses` — client
  factice appelé une fois sur l'URL bulk attendue ; résultat identique à
  `parse_corporate_actions` appliqué directement à la fixture T1.
- **Critères de la spec couverts** : aucun directement (prérequis de
  l'orchestration, câblé dans T57).
- **Terminée quand** : le test passe, aucun appel réseau réel.
- **Dépend de** : T9, T12, T13.

### T19 — Test de contact EDGAR
- **Objectif** : vérifier, contre le vrai `data.sec.gov` / `www.sec.gov`,
  que le contrat de forme tient toujours — accessibilité et forme de la
  réponse, jamais une logique métier (invariant 9 amendé).
- **Fichiers** : `tests/contact/test_edgar_contact.py`.
- **Test** : `test_edgar_contact_company_tickers_reachable`, marqué
  `@pytest.mark.contact` — appelle réellement
  `https://www.sec.gov/files/company_tickers.json` avec un `EdgarClient`
  réel (User-Agent lu depuis `.env`) et vérifie uniquement : absence
  d'exception, réponse désérialisable en JSON, présence d'au moins une
  entrée portant les clés `cik_str`, `ticker`, `title`. Aucune assertion
  sur une valeur de cotation ou de dépôt précise.
- **Critères de la spec couverts** : aucun (invariant 9, volet test de
  contact).
- **Terminée quand** : le test passe en exécution manuelle
  (`uv run pytest -m contact`) et reste exclu de `uv run pytest` par
  défaut (vérifié par `addopts` de `pyproject.toml`).
- **Dépend de** : T11, T13.

### T20 — Test de contact EODHD
- **Objectif** : même exigence que T19, pour EODHD.
- **Fichiers** : `tests/contact/test_eodhd_contact.py`.
- **Test** : `test_eodhd_contact_bulk_endpoint_reachable`, marqué
  `@pytest.mark.contact` — appelle réellement l'endpoint bulk EODHD du jour
  avec la clé lue depuis `.env` et vérifie uniquement l'absence
  d'exception, la désérialisation JSON, et la présence des clés de forme
  attendues (`code`, `date`, `close`). Aucune assertion sur un cours réel.
- **Critères de la spec couverts** : aucun (invariant 9, volet test de
  contact).
- **Terminée quand** : le test passe en exécution manuelle
  (`uv run pytest -m contact`) et reste exclu de `uv run pytest` par
  défaut.
- **Dépend de** : T12, T13.

### T21 — Fournir l'heure système en UTC, en un point unique
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
  5 ; `calc.market_calendar`, T24, reçoit déjà l'instant en paramètre et ne
  lit jamais l'horloge lui-même — c'est `ingestion.clock` qui la lui
  fournira depuis `pipeline.daily_run`).
- **Terminée quand** : le test passe.
- **Dépend de** : aucune.

## Calcul — fondations point-in-time et calendrier

### T22 — Refuser tout look-ahead
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

### T23 — Résoudre la dernière valeur connue malgré un retraitement
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

### T24 — Résoudre la dernière séance de bourse effective
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

### T25 — Chaîne de repli des actions en circulation
- **Objectif** : `calc.shares_bridge` applique la chaîne de tags définie
  dans le plan et signale le statut calculable/non calculable.
- **Fichiers** : `src/dashboard/calc/shares_bridge.py`,
  `tests/calc/test_shares_bridge.py`.
- **Test** : `test_shares_bridge_fallback_chain` — trois émetteurs de la
  fixture, un par niveau de repli, plus un cas sans aucun tag disponible
  (non calculable).
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11, prouvé en T46).
- **Terminée quand** : le test passe.
- **Dépend de** : T5.

### T26 — Chaîne de repli de l'EBIT
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

### T27 — D&A et EBITDA
- **Objectif** : `calc.dna_bridge` applique sa chaîne de repli ;
  `calc.ebitda` compose EBIT + D&A.
- **Fichiers** : `src/dashboard/calc/dna_bridge.py`,
  `src/dashboard/calc/ebitda.py`, `tests/calc/test_ebitda.py`.
- **Test** : `test_ebitda_composes_ebit_and_dna` — EBITDA correct quand les
  deux composantes sont calculables, non calculable si l'une manque.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T26.

### T28 — Chaîne de repli du free cash flow
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

### T29 — Chaîne de repli de la dette totale
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

### T30 — Chaîne de repli de la trésorerie
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

### T31 — Chaîne de repli des capitaux propres
- **Objectif** : `calc.equity_bridge` applique sa chaîne de repli.
- **Fichiers** : `src/dashboard/calc/equity_bridge.py`,
  `tests/calc/test_equity_bridge.py`.
- **Test** : `test_equity_bridge_fallback_chain` — cas primaire, cas de
  repli, cas non calculable.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T5.

### T32 — Dette nette
- **Objectif** : `calc.net_debt` calcule dette totale − trésorerie.
- **Fichiers** : `src/dashboard/calc/net_debt.py`,
  `tests/calc/test_net_debt.py`.
- **Test** : `test_net_debt_formula` — valeur correcte quand les deux
  composantes sont calculables, non calculable sinon.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11 ; utilisé par T42, dette nette/EBITDA).
- **Terminée quand** : le test passe.
- **Dépend de** : T29, T30.

### T33 — Capital investi
- **Objectif** : `calc.invested_capital` calcule dette totale + capitaux
  propres − trésorerie, non calculable pour le ROIC si le résultat est ≤ 0.
- **Fichiers** : `src/dashboard/calc/invested_capital.py`,
  `tests/calc/test_invested_capital.py`.
- **Test** : `test_invested_capital_formula_and_non_positive_case` — cas
  positif, cas où le résultat est négatif ou nul.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T29, T30, T31.

## Calcul — univers défini par règle

### T34 — Exclure SIC 6000–6799 et les fonds/ETF
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

### T35 — Classer par capitalisation lissée sur 20 séances
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
- **Dépend de** : T25, T8, T34.

### T36 — Appliquer l'hystérésis au rang de coupure
- **Objectif** : un titre déjà dans l'univers reste jusqu'au rang N+buffer,
  un titre absent n'entre qu'au rang N−buffer.
- **Fichiers** : `src/dashboard/calc/universe.py`,
  `tests/calc/test_universe_hysteresis.py`.
- **Test** : `test_universe_stable_near_cutoff_with_hysteresis` — un titre
  dont le rang oscille entre 850 et 950 d'un jour à l'autre garde le même
  statut d'appartenance sur toute la séquence.
- **Critères de la spec couverts** : #24.
- **Terminée quand** : le test passe.
- **Dépend de** : T35.

### T37 — Échouer bruyamment si la taille de l'univers est implausible
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
- **Dépend de** : T34, T35, T36.

## Calcul — indicateurs et ratios

### T38 — Valeur d'entreprise
- **Objectif** : `calc.ev` calcule capitalisation + dette nette.
- **Fichiers** : `src/dashboard/calc/ev.py`, `tests/calc/test_ev.py`.
- **Test** : `test_ev_formula` — valeur correcte, non calculable si la
  dette nette l'est.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T32, T35.

### T39 — NOPAT avec taux d'imposition plafonné
- **Objectif** : calculer le taux d'imposition effectif borné à [0 %,
  50 %], avec repli à 21 % si le résultat avant impôt n'est pas
  strictement positif.
- **Fichiers** : `src/dashboard/calc/nopat.py`, `tests/calc/test_nopat.py`.
- **Test** : `test_nopat_tax_rate_capping_and_fallback` — cas de résultat
  avant impôt positif dans la bande, cas hors bande (plafonné), cas
  négatif ou nul (repli à 21 %).
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11 ; le statut du repli à 21 % comme paramètre de modélisation,
  au sens de l'invariant 7 amendé, reste à traiter dans cette tâche
  elle-même — pas anticipé ici).
- **Terminée quand** : le test passe.
- **Dépend de** : T26, T22.

### T40 — ROIC
- **Objectif** : `calc.roic` = NOPAT / capital investi, non calculable si
  le capital investi est ≤ 0.
- **Fichiers** : `src/dashboard/calc/roic.py`, `tests/calc/test_roic.py`.
- **Test** : `test_roic_formula_and_non_positive_invested_capital` — cas
  normal, cas capital investi ≤ 0.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T39, T33.

### T41 — EV/EBIT non calculable sur EBIT non positif
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
- **Dépend de** : T26, T38.

### T42 — Dette nette/EBITDA non calculable sur EBITDA non positif
- **Objectif** : même règle que T41 pour l'indicateur de solvabilité.
- **Fichiers** : `src/dashboard/calc/ratios.py`,
  `tests/calc/test_net_debt_ebitda_non_positive.py`.
- **Test** : `test_net_debt_ebitda_non_calculable_on_non_positive_ebitda`.
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11).
- **Terminée quand** : le test passe.
- **Dépend de** : T27, T32.

### T43 — TTM primaire et médiane 5 ans secondaire
- **Objectif** : `calc.ttm` agrège quatre trimestres glissants,
  `calc.normalized_5y` calcule la médiane sur cinq exercices.
- **Fichiers** : `src/dashboard/calc/ttm.py`,
  `src/dashboard/calc/normalized_5y.py`, `tests/calc/test_ttm_and_5y.py`.
- **Test** : `test_ttm_and_5y_median_computed` — les deux valeurs sont
  produites et diffèrent sur un cas de fixture conçu pour cela.
- **Critères de la spec couverts** : #12.
- **Terminée quand** : le test passe.
- **Dépend de** : T22.

### T44 — Signaler la divergence TTM / normalisé
- **Objectif** : énoncé corrigé après implémentation : le texte original
  parlait à tort de « percentile TTM et percentile normalisé » — un mot
  du vocabulaire de T51 (`calc.percentiles`, pas encore construite à ce
  stade, et pas une dépendance de cette tâche) s'était substitué à celui
  de spec.md critère 13 et de plan.md, qui parlent tous deux de
  l'indicateur lui-même. `calc.divergence` signale un titre quand l'écart
  entre l'indicateur TTM et l'indicateur normalisé dépasse le seuil
  configuré.
- **Fichiers** : `src/dashboard/calc/divergence.py`,
  `tests/calc/test_divergence.py`.
- **Test** : `test_divergence_flag_above_threshold` — cas au-dessus du
  seuil (signalé), cas en dessous (non signalé).
- **Critères de la spec couverts** : #13.
- **Terminée quand** : le test passe.
- **Dépend de** : T43.

### T45 — Signaler un indicateur non calculable, jamais de valeur par défaut
- **Objectif** : énoncé corrigé après implémentation : le texte original
  supposait « les cinq autres [indicateurs] » déjà disponibles à ce stade,
  ce qui présuppose les six indicateurs de spec.md construits — or aucune
  tâche ne construisait le rendement FCF/EV (indicateur #2 de spec.md,
  colonne `fcf_yield` de `screen_results.parquet` dans plan.md). `calc.ratios`
  porte un statut calculable/non calculable par indicateur et par titre,
  sans jamais inventer de valeur ; `calc.ratios.fcf_yield` est construit
  ici pour combler ce trou, sur le modèle de
  `ev_to_ebit`/`net_debt_to_ebitda`, sans garde de signe (plan.md ne le
  classe pas parmi les ratios non interprétables par leur dénominateur).
  Les deux percentiles (`calc.percentiles`, T51, pas encore construite)
  sont reçus par `indicator_status` déjà résolus, en paramètres — comme
  `market_cap` pour `calc.ev` — plutôt que recalculés ici : un percentile
  est une mesure croisée sur l'univers, pas une propriété d'un titre isolé
  qu'un test à un seul émetteur peut exercer.
- **Fichiers** : `src/dashboard/calc/ratios.py`,
  `tests/calc/test_ratios_missing_data.py`.
- **Test** : `test_missing_fundamental_flagged` — un titre dont une
  composante d'un seul indicateur (les capitaux propres, donc ROIC) est
  absente a ce seul indicateur signalé non calculable ; les cinq autres
  (EV/EBIT, rendement FCF/EV, dette nette/EBITDA, et les deux percentiles
  passés déjà résolus) restent produits normalement.
- **Critères de la spec couverts** : #6.
- **Terminée quand** : le test passe.
- **Dépend de** : T41, T42, T40, T28.

### T46 — Rapporter le taux de couverture par indicateur
- **Objectif** : le pipeline rapporte, pour chaque indicateur, le nombre
  de titres calculables sur le nombre total.
- **Fichiers** : `src/dashboard/calc/ratios.py`,
  `tests/calc/test_coverage_rate.py`.
- **Test** : `test_coverage_rate_reported_per_indicator` — sur une fixture
  à couverture partielle connue, le taux rapporté correspond exactement au
  compte attendu pour chacun des six indicateurs.
- **Critères de la spec couverts** : #11.
- **Terminée quand** : le test passe.
- **Dépend de** : T45.

### T47 — Ne jamais mélanger prix bruts et ajustés dans un calcul
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
- **Dépend de** : T8, T45.

### T48 — Devise explicite, sans conversion implicite
- **Objectif** : chaque valeur produite par `calc.ratios` porte sa devise,
  toujours USD dans cette tranche, jamais convertie silencieusement.
- **Fichiers** : `src/dashboard/calc/ratios.py`,
  `tests/calc/test_currency_explicit.py`.
- **Test** : `test_currency_explicit_no_conversion` — le résultat de deux
  titres comparés porte la même devise déclarée, aucune opération de
  conversion n'est appliquée dans le chemin de calcul.
- **Critères de la spec couverts** : #10.
- **Terminée quand** : le test passe.
- **Dépend de** : T45.

### T49 — Percentile face à l'histoire propre, années disponibles affichées
- **Objectif** : `calc.percentiles` calcule le percentile du multiple
  primaire sur l'historique depuis 2011 et le nombre d'années réellement
  disponibles.
- **Fichiers** : `src/dashboard/calc/percentiles.py`,
  `tests/calc/test_own_history_percentile.py`.
- **Test** : `test_own_history_percentile_and_years` — un émetteur introduit
  en 2019 dans la fixture affiche six ans d'historique, pas plus.
- **Critères de la spec couverts** : #19.
- **Terminée quand** : le test passe.
- **Dépend de** : T45.

### T50 — Classer un code SIC dans sa division officielle
- **Objectif** : `calc.sector_grouping` classe le code SIC d'un titre dans
  l'une des neuf divisions SIC officielles définies dans le plan, non
  calculable si le code sort des plages couvertes.
- **Fichiers** : `src/dashboard/calc/sector_grouping.py`,
  `tests/calc/test_sector_grouping.py`. Énoncé corrigé après
  implémentation : CIK 5 n'était plus disponible pour « un nouvel
  émetteur » — Epsilon (SIC 5040, fonds/ETF) occupe ce CIK depuis T34,
  pour un besoin sans rapport (isoler le critère `entity_type` de
  l'exclusion d'univers). `calc.sector_grouping` ne se soucie pas
  d'`entity_type` : le SIC d'Epsilon (5040, plage 5000–5199) suffit à
  fournir une seconde division distincte sans nouvel émetteur. Introduit
  à la place : `tests/golden/raw/edgar_submissions_0000000006.json`
  (CIK 6, SIC 1850) pour le cas hors plage.
- **Test** : `test_sector_grouping_classifies_by_sic_division` — le SIC
  3674 d'Alpha est classé en division D (industrie manufacturière), le SIC
  5040 d'Epsilon en division F (commerce de gros), et le SIC 1850 de CIK 6
  (hors plage) est signalé non calculable, jamais rattaché par défaut à
  une division voisine.
- **Critères de la spec couverts** : aucun directement (prérequis des
  critères 19, 20 ; #20 est prouvé en T51 en s'appuyant sur ce
  regroupement).
- **Terminée quand** : le test passe.
- **Dépend de** : T4.

### T51 — Repli sur l'absolu si le groupe sectoriel a moins de dix titres
- **Objectif** : `calc.percentiles` ne calcule pas de percentile sectoriel
  pour un groupe grossier de moins de dix titres et le signale.
- **Fichiers** : `src/dashboard/calc/percentiles.py`,
  `tests/calc/test_sector_percentile_fallback.py`.
- **Test** : `test_sector_percentile_fallback_below_10` — un groupe
  sectoriel de la fixture réduit à moins de dix titres n'a pas de
  percentile sectoriel, `sector_pct_available` vaut faux.
- **Critères de la spec couverts** : #20.
- **Terminée quand** : le test passe.
- **Dépend de** : T49, T50.

### T52 — Filtrer avec des seuils configurables, compteur y compris zéro
- **Objectif** : `calc.filters` applique des seuils reçus en paramètre et
  retourne systématiquement le compteur de titres retenus.
- **Fichiers** : `src/dashboard/calc/filters.py`,
  `tests/calc/test_filters.py`.
- **Test** : `test_filter_count_including_zero` — un jeu de seuils
  n'excluant aucun titre, et un jeu de seuils excluant tous les titres
  (compteur à zéro, sans erreur).
- **Critères de la spec couverts** : #15.
- **Terminée quand** : le test passe.
- **Dépend de** : T45.

### T53 — Classer et plafonner à 25
- **Objectif** : `calc.ranking` classe les titres retenus et n'en affiche
  jamais plus de 25.
- **Fichiers** : `src/dashboard/calc/ranking.py`,
  `tests/calc/test_ranking.py`.
- **Test** : `test_ranking_capped_at_25` — une fixture à 40 titres retenus
  ne produit que 25 lignes classées.
- **Critères de la spec couverts** : #16.
- **Terminée quand** : le test passe.
- **Dépend de** : T52.

## Stockage et persistance

### T54 — Historique du screen en ajout seul
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
- **Dépend de** : T53.

### T55 — Historique d'appartenance à l'univers en ajout seul
- **Objectif** : `storage.universe_history` ajoute une ligne par titre par
  jour, jamais élaguée.
- **Fichiers** : `src/dashboard/storage/universe_history.py`,
  `tests/storage/test_universe_history.py`.
- **Test** : `test_membership_table_append_only` — après plusieurs jours
  de traitement simulés, toutes les lignes précédentes sont toujours
  présentes et inchangées.
- **Critères de la spec couverts** : #22.
- **Terminée quand** : le test passe.
- **Dépend de** : T37.

### T56 — Compter les jours consécutifs passés
- **Objectif** : `calc.streak` calcule, à partir de l'historique du
  screen, le nombre de jours consécutifs où un titre passe les filtres.
- **Fichiers** : `src/dashboard/calc/streak.py`,
  `tests/calc/test_streak.py`.
- **Test** : `test_consecutive_days_streak` — un titre présent 5 jours de
  suite puis absent un jour affiche une série de 5, pas 6.
- **Critères de la spec couverts** : #18.
- **Terminée quand** : le test passe.
- **Dépend de** : T54.

## Orchestration

### T57 — Le traitement quotidien reflète la clôture et les dépôts connus
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
- **Dépend de** : T24, T22, T5, T8.

### T58 — Arrêter le traitement si le calcul de l'univers échoue
- **Objectif** : `pipeline.daily_run` n'écrit aucun résultat et n'affiche
  pas d'écran pour le jour si `calc.universe` renvoie un échec.
- **Fichiers** : `src/dashboard/pipeline/daily_run.py`,
  `tests/pipeline/test_daily_run_universe_failure.py`.
- **Test** : énoncé corrigé après implémentation : le texte original
  vérifiait `screen_results.parquet` en plus de `universe_membership.parquet`,
  ce qui présuppose les indicateurs, les filtres et le classement déjà
  câblés dans `pipeline.daily_run` — or T45 à T53 ne sont pas des
  dépendances de T58, et rien n'écrit encore dans `screen_results.parquet`
  à ce stade, échec ou pas : l'assertion n'aurait rien prouvé.
  `test_universe_failure_halts_pipeline` — sur le cas de fixture d'univers
  implausible (T37), aucune ligne n'est ajoutée à
  `universe_membership.parquet` pour ce jour.
- **Critères de la spec couverts** : #25 (volet orchestration).
- **Terminée quand** : le test passe.
- **Dépend de** : T37, T57.

## Présentation

### T59 — Exclure du screen les titres sortis de l'univers du jour
- **Objectif** : un titre qui ne fait plus partie de l'univers défini par
  règle n'apparaît pas dans le résultat du jour.
- **Fichiers** : `src/dashboard/calc/filters.py` ou
  `src/dashboard/pipeline/daily_run.py`, `tests/pipeline/test_screen_excludes_non_members.py`.
- **Test** : `test_screen_excludes_non_members` — un titre présent la
  veille mais sorti de l'univers aujourd'hui (hors hystérésis) n'apparaît
  pas dans le résultat du jour.
- **Critères de la spec couverts** : #2.
- **Terminée quand** : le test passe.
- **Dépend de** : T37, T52.

### T60 — Préserver les données d'un titre sorti de l'univers
- **Objectif** : les fondamentaux et l'historique de screen d'un titre
  sorti de l'univers restent intacts et consultables.
- **Fichiers** : `tests/pipeline/test_delisted_ticker_history_preserved.py`.
- **Test** : `test_delisted_ticker_history_preserved` — après la sortie
  simulée d'un titre de l'univers, ses lignes dans `fundamentals_raw`,
  `screen_results` et `universe_membership` restent lisibles et inchangées.
- **Critères de la spec couverts** : #21.
- **Terminée quand** : le test passe.
- **Dépend de** : T37, T54, T55.

### T61 — Tracer tout nombre affiché jusqu'à sa source
- **Objectif** : énoncé corrigé après implémentation — invariant 8 amendé,
  ADR 0004 : le texte original et l'ancien critère 9 supposaient que tout
  nombre affiché remonte à un fait déposé (champ source, `end`, `filed`,
  `accn`), ce qui est faux pour les deux percentiles, des grandeurs
  dérivées de l'historique de `screen_results`, pas d'un fait d'un jour
  donné — la même incohérence structurelle qu'à T45, ici sur les
  dépendances plutôt que sur le compte d'indicateurs. `app.detail_view`
  permet de remonter, pour une grandeur issue d'un dépôt, jusqu'au champ
  source, au rang de repli utilisé, à sa date de fin d'exercice, sa date
  de dépôt et son numéro de dépôt — ou, pour un prix, sa date de
  cotation — et, pour une grandeur dérivée, jusqu'à la formule, ses
  entrées, la population de comparaison et la fenêtre retenue.
- **Fichiers** : `src/dashboard/app/detail_view.py`,
  `src/dashboard/calc/point_in_time.py` (fonction sœur additive
  `resolve_detail`), `tests/app/test_detail_view_traceability.py`.
- **Test** : `test_every_displayed_number_traceable` — pour Alpha, dont
  tous les indicateurs se résolvent au tag primaire, les quatre
  indicateurs issus de faits déposés (EV/EBIT, rendement FCF/EV, ROIC,
  dette nette/EBITDA) retournent le ou les tags, le rang de repli, `end`,
  `filed` et `accn` correspondants ; les deux percentiles retournent
  formule, entrées, population de comparaison et fenêtre plutôt qu'un
  tag. Se limite au cas où chaque bridge résout au niveau primaire — ne
  couvre pas la reconstruction du rang de repli sur un titre en repli.
- **Critères de la spec couverts** : #9, #27.
- **Terminée quand** : le test passe.
- **Dépend de** : T3, T45, T49, T51, T57.

### T62 — Ne jamais présenter l'écran comme une mesure d'un indice publié
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
- **Dépend de** : T57, T59.

## Vérification de couverture

### Critères de la spec

Union des critères couverts : #1 (T22), #2 (T59), #3 (T6, T23), #4 (T8,
T47), #5 (T5), #6 (T45), #7 (T57), #8 (T24), #9 (T61), #10 (T48), #11
(T46), #12 (T43), #13 (T44), #14 (T34), #15 (T52), #16 (T53), #17 (T54),
#18 (T56), #19 (T49), #20 (T51), #21 (T60), #22 (T55), #23 (T34), #24
(T36), #25 (T37, T58), #26 (T62), Invariant 10 (T13).

Les 26 critères d'acceptation de spec.md et l'invariant 10 sont couverts.
Aucun critère orphelin.

Invariant 9 (tests hors réseau par défaut, amendé au point de contrôle) :
le dispositif lui-même — marqueur `contact` déclaré et exclu par défaut,
un test de contact par source — est couvert par T19 (EDGAR) et T20
(EODHD). Ces deux tâches ne couvrent aucun critère numéroté de spec.md :
elles couvrent l'invariant en tant que tel.

### Modules et comportements de plan.md (contrôle élargi, cf. amendement
spec-tasks du point de contrôle)

Les 38 modules nommés dans `plan.md` sont chacun couverts par au moins une
tâche. T7 (comptage des faits rejetés par taxonomie) ne couvre pas un
nouveau module — il étend `ingestion.edgar_facts`, déjà couvert par T5 et
T6 — mais répond à une exigence de `plan.md` (comptage des rejets, R1 /
invariant 7) qui n'avait jusqu'ici aucune tâche.

Le trou de couverture relevé au point de contrôle mi-parcours est comblé :
les cinq fonctions `fetch_*` promises par la section « Couche réseau » de
plan.md pour `edgar_tickers`, `edgar_submissions`, `edgar_facts`,
`eodhd_prices` et `eodhd_actions` sont désormais couvertes respectivement
par T14, T15, T16, T17 et T18 — chacune testée avec un transport factice,
sans réseau réel.

Aucun module orphelin.

### Résultat du contrôle 4.3 (comportements promis par plan.md, hors noms
de module) — signalés, non traités

En appliquant le contrôle élargi aux comportements décrits dans les
contrats de module et la section « Risques » de plan.md, au-delà des seuls
noms de fichiers, trois comportements promis restent sans tâche :

1. **Seuil de cohérence prix veille/jour dans `calc.ratios`** — plan.md,
   section Risques, « Fractionnement non reflété à temps par la source de
   prix » : « `calc.ratios` compare le ratio de prix veille/jour à un seuil
   de cohérence et signale l'anomalie plutôt que de la laisser
   silencieusement fausser un indicateur. » Aucune tâche T38–T53 ne
   construit ni ne teste cette comparaison ; T47 ne teste que la
   séparation brut/ajusté, pas un seuil d'anomalie jour sur jour.
2. **Jointure point-in-time sur `sic_codes`/`ticker_cik` à la date
   effective** — plan.md, section Risques, « Changement de code SIC ou de
   ticker non reflété » : « toute jointure se fait à la date effective,
   jamais sur la valeur la plus récente sans égard à la date. » Les tâches
   existantes (T34, T50) testent un instantané à une seule date ; aucune
   ne teste qu'un changement de SIC ou de ticker dans le temps est
   résolu par `as_of` plutôt que par la valeur la plus récente.
3. **Conversion explicite en UTC de l'horodatage des dépôts SEC** —
   plan.md, section Risques, « Horodatage des dépôts SEC en heure de l'Est
   américain, pas en UTC » : « la conversion vers UTC est explicite et
   documentée au point d'ingestion, jamais laissée à la valeur telle que
   reçue. » Aucune tâche ne teste un cas de bord proche de minuit où une
   conversion manquante ferait basculer une comparaison `filed ≤ t`.

Note connexe, plus faible, non comptée ci-dessus : le contrat générique
des modules d'ingestion T2–T9 (« refusent de retourner une valeur par
défaut en cas d'échec — l'absence de mise à jour du jour est un état
visible, jamais comblé silencieusement par la veille ») n'est testé qu'au
niveau de `calc.universe` (T58, échec de `calc.universe` arrête le
traitement) ; aucune tâche ne teste explicitement qu'un échec de `fetch_*`
lui-même (T14–T18) empêche de la même façon toute réutilisation silencieuse
des données de la veille dans `pipeline.daily_run`.

Total : 62 tâches.
