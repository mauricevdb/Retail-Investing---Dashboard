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
- **Statut** : bug réel trouvé en ingestion manuelle (T75, premier essai
  contre le vrai EDGAR, hors suite automatisée) : `reportDate` est une
  chaîne vide pour tout dépôt sans période de rapport (8-K, proxy,
  déclaration d'initié...) — l'API SEC renvoie `''`, jamais un champ
  absent, ce que la fixture synthétique T1 ne reproduisait pas.
  `parse_filings` plantait (`ValueError: Invalid isoformat string: ''`)
  sur pratiquement tout émetteur réel. Corrigé : `period_of_report` reste
  explicitement `None` pour ce dépôt, jamais une date devinée (invariant
  7). Test étendu avec un cas mixte (10-K daté, 8-K sans période).
- **Deuxième bug réel trouvé en ingestion manuelle** (T75, test sur
  JPMorgan Chase, choisie pour son volume de dépôts) :
  `pl.DataFrame(rows)` n'infère le type d'une colonne que sur un
  échantillon limité de lignes (100 par défaut). Un émetteur qui dépose
  beaucoup (8-K, Form 4...) a souvent plus de 100 dépôts sans période de
  rapport avant le premier dépôt périodique dans l'historique « recent » —
  Polars échoue alors en rencontrant la première vraie date plus loin
  (`ComputeError: could not append value ... to the builder`), invisible
  sur la fixture synthétique T1 (2 dépôts seulement). Corrigé : schéma de
  colonnes déclaré explicitement plutôt qu'inféré. Nouveau test :
  `test_edgar_submissions_filings_beyond_schema_inference_sample` (150
  dépôts, dont 148 sans période avant les deux dépôts périodiques).

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
- **Statut** : le parseur lui-même n'a jamais été en cause. Ses assertions
  sur Alpha/Gamma vérifiaient une valeur `entity_type` fictive
  (`"operating company"`), corrigée en `"operating"` (la vraie valeur SEC)
  en même temps que le bug qu'elle cachait, trouvé et corrigé en T34.

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
- **Statut** : contrat corrigé après le test de contact réel (T20) :
  `get_json` n'envoyait que `api_token`, jamais `fmt=json`. Contre un
  transport factice (qui renvoie toujours du JSON déjà prêt), cette
  omission était invisible ; contre le vrai endpoint bulk EODHD, qui
  renvoie du CSV par défaut, elle faisait échouer tout appel réel à la
  désérialisation. `fmt=json` est désormais systématiquement envoyé,
  vérifié par `test_eodhd_client_authenticates_and_raises_on_failure`
  (étendu) et par T20 contre le vrai service.

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
- **Statut** : d'abord trouvée non implémentée (découvert en écrivant T19 :
  aucune fonction `fetch_*` n'existait dans le dépôt malgré la mention
  « couche réseau comblée » en section Vérification de couverture, écart
  non détecté par les quatre passages de `/spec-verify`). Écrite. **Faite.**

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
- **Statut** : même constat qu'à T14 (jamais implémentée malgré la
  mention de couverture). Écrite. **Faite.**

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
- **Statut** : même constat qu'à T14 (jamais implémentée malgré la
  mention de couverture). Écrite ; URL réelle
  `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`
  (le préfixe `/api/xbrl/` de l'API XBRL, implicite dans l'énoncé
  d'origine). **Faite.**

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
- **Statut** : même constat qu'à T14 (jamais implémentée malgré la
  mention de couverture). Écrite ; URL réelle
  `https://eodhd.com/api/eod-bulk-last-day/US?date=AAAA-MM-JJ` (paramètre
  `date` explicite, `api_token`/`fmt=json` ajoutés par `EodhdClient`
  lui-même, T12). **Faite.**

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
- **Statut** : même constat qu'à T14 (jamais implémentée malgré la
  mention de couverture). Écrite ; URL réelle
  `https://eodhd.com/api/eod-bulk-last-day/US?type=splits&date=AAAA-MM-JJ`
  — même endpoint bulk que T17, distingué par `type=splits`. **Faite.**

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
- **Statut** : d'abord trouvée non implémentée (ni `tests/contact/` ni
  `test_edgar_contact.py` n'existaient malgré la séquence 1-74 et la
  mention de couverture de l'invariant 9). Écrite et vérifiée contre le
  vrai `www.sec.gov` (User-Agent lu depuis `.env`, transport réel en
  `urllib.request` local au test) : `test_edgar_contact_company_tickers_reachable`
  passe en exécution manuelle (`uv run pytest -m contact`) et reste exclu
  de la suite par défaut (61 passed, 1 deselected). **Faite.**

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
- **Statut** : d'abord trouvée non implémentée (même constat qu'à T19).
  Écrite, puis échouée contre le vrai service avec
  `EodhdClientError: Expecting value: line 1 column 1 (char 0)` — ni la
  clé, ni le User-Agent, ni l'URL en cause : l'endpoint bulk EODHD renvoie
  du CSV par défaut (`Content-Type: text/html`), et `EodhdClient.get_json`
  ne demandait jamais `fmt=json`. Diagnostiqué par inspection de la
  réponse brute (statut 200, clé acceptée, corps CSV), jamais en affichant
  la clé. Corrigé dans T12 ; `test_eodhd_contact_bulk_endpoint_reachable`
  passe désormais contre le vrai `eodhd.com` (clé absente de toute sortie
  de test, vérifié par comparaison directe avant affichage). **Faite.**

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
- **Statut** : deux bugs réels trouvés en ingestion manuelle (T75, deuxième
  essai contre le vrai EDGAR) :
  1. `apply_exclusions` comparait `entity_type` à `"operating company"` —
     une valeur qui n'existe nulle part dans l'API réelle. Vérifié sur
     trois émetteurs réels : Apple (`entityType='operating'`,
     `sic='3571'`), JPMorgan Chase (`'operating'`, `sic='6021'`, une
     banque exclue par le SIC, pas par entity_type), SPDR S&P 500 ETF
     Trust / SPY (`'other'`, `sic=''`). Résultat avant correction :
     **tout émetteur réel était exclu**, y compris les éligibles. Corrigé :
     comparaison à `"operating"`.
  2. Un fonds réglementé réel (Prospect Capital, une BDC) a
     `entityType='operating'` comme n'importe quelle société — seul son
     SIC est vide (`''`), jamais un code numérique. `entity_type` seul ne
     suffit donc pas à exclure les fonds/BDC (critère 23) : un SIC absent
     doit être traité comme un signal d'exclusion, jamais ignoré
     (invariant 7). `apply_exclusions` caste désormais `sic` en entier
     sans erreur (`strict=False`) ; un SIC non numérique devient absent,
     ce qui exclut la ligne par la logique à trois valeurs de Polars,
     jamais un plantage ni une inclusion par défaut. Nouveau test :
     `test_universe_exclusions_missing_sic_treated_as_non_operating`.
     Fixtures `edgar_submissions_0000000001/02/03/06.json` corrigées
     (`"operating company"` → `"operating"`) ; Delta/Epsilon
     (`"investment company"`) laissées inchangées -- toujours exclues (la
     valeur ne correspond à aucun cas réel identifié, mais reste un
     sentinel valide pour ce test).

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
- **Statut** : bug réel trouvé en ingestion manuelle (T75, troisième essai) :
  `rank()` triait tous les titres retenus par `ev_ebit` sans exclure ceux
  dont cet indicateur est `None` — `apply_filters` ne l'exclut que si
  `ev_ebit` fait partie des seuils fournis, ce qui n'est pas garanti
  (`thresholds={}` est un choix légitime : « aucun filtre »). Résultat :
  `sorted()` plantait (`TypeError: '<' not supported between instances of
  'NoneType' and 'float'`) dès qu'un titre réel avait un indicateur de tri
  non calculable. Corrigé : un titre non calculable sur l'indicateur de tri
  est exclu du classement, jamais comparé (invariant 7). Nouveau test :
  `test_ranking_excludes_non_calculable_primary_indicator`.

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

### T63 — Assembler `pipeline.daily_run` de bout en bout
- **Objectif** : énoncé corrigé après audit (`/spec-verify`) — la première
  version de cette tâche assemblait univers, indicateurs fondés sur des
  faits, filtres, classement et persistance, mais excluait les
  percentiles ; un test qui ne prouve que ce sous-ensemble n'est pas un
  test de bout en bout, seulement un test unitaire de plus sous un autre
  nom. `pipeline.daily_run.run_daily` enchaîne, pour un jour de
  traitement donné, sur les instantanés figés : calcul de l'univers (non
  vide), indicateurs fondés sur des faits **et** percentiles (propre
  histoire, sectoriel avec repli si groupe < 10) pour chaque titre
  membre, filtrage, classement et plafonnement à 25, écriture d'une ligne
  par titre retenu dans `screen_results.parquet`, et production d'un
  texte de vue affichable (`app.screen_view.render_screen_text`)
  reflétant le résultat du jour — sans réécrire la logique d'aucune des
  briques déjà construites et testées isolément.
- **Fichiers** : `src/dashboard/pipeline/daily_run.py`,
  `tests/pipeline/test_daily_run_end_to_end.py` (remplace le test
  existant, dont la portée ne couvrait pas les percentiles).
- **Test** : `test_daily_run_end_to_end` — sur une fixture d'univers
  plausible avec plusieurs titres membres et un historique suffisant pour
  les deux percentiles, un appel à `run_daily` produit : un univers non
  vide, au moins une ligne dans `screen_results.parquet` portant les six
  indicateurs (les deux percentiles calculés ou explicitement signalés
  indisponibles, jamais silencieusement absents), un classement cohérent
  avec ce que `calc.ratios.indicator_status`, `calc.percentiles`,
  `calc.filters.apply_filters` et `calc.ranking.rank` produiraient
  appelés directement sur les mêmes données, et un texte de vue non vide
  mentionnant le compteur de titres retenus.
- **Explicitement hors périmètre** : la divergence TTM/normalisé (critère
  13) et le streak (critère 18) restent hors périmètre — ils supposent un
  historique de `screen_results` accumulé sur plusieurs jours réels, que
  cette tâche ne construit pas. Les percentiles, eux, n'ont plus cette
  excuse : `calc.percentiles` n'a besoin que d'une série déjà résolue,
  constructible dans la fixture du test lui-même, sans historique réel
  accumulé — c'est pourquoi ils entrent désormais dans le périmètre alors
  que divergence et streak en restent exclus.
- **Critères de la spec couverts** : aucun nouveau directement — referme
  la boucle d'orchestration pour des critères déjà couverts
  individuellement (#2, #6, #7, #11, #15, #16, #17, #19, #20, #25, #26),
  jusqu'ici jamais exercés ensemble dans un seul appel.
- **Terminée quand** : le test passe.
- **Dépend de** : T45, T49, T51, T52, T53, T54, T58, T62.
- **Statut** : bug réel trouvé en ingestion manuelle (T75, quatrième
  essai) : `run_daily` transmettait `membership` à
  `storage.universe_history.append` sans jamais lui ajouter de colonne
  `"date"` — `calc.universe.universe()` n'en produit aucune. Invisible
  tant qu'un seul appel écrivait dans un fichier neuf (aucun test
  n'appelait `run_daily` deux fois sur le même chemin, contrairement à
  `screen_history`, pour laquelle `run_daily` ajoute bien `"date": t`
  explicitement). Un deuxième appel réel plantait
  (`ColumnNotFoundError: "date"`, colonne exigée par le garde anti-doublon
  de T68) au lieu d'ajouter une deuxième ligne, comme l'exige le critère
  22. Corrigé : `"date"` ajoutée avant l'appel, symétriquement à
  `screen_rows`. Nouveaux tests :
  `test_daily_run_repeated_calls_write_distinct_dates` et
  `test_daily_run_repeated_call_same_date_rejected` (ce dernier n'avait
  jamais exercé le garde de T68 via `run_daily`, seulement via le
  stockage isolé).

### T64 — Traçabilité des replis
- **Objectif** : découverte au sondage numérique de `/spec-verify`, sur un
  titre réel (Gamma, CIK 3) : `app.detail_view.trace_indicator` n'interroge
  que les tags primaires codés en dur dans `_INDICATOR_CONCEPTS` ; sur
  Gamma, dont l'EBIT est résolu par reconstruction (T26, pas le tag
  primaire `OperatingIncomeLoss`), la trace d'EV/EBIT et de dette
  nette/EBITDA revient vide, sans erreur ni explication. `trace_indicator`
  doit interroger la chaîne de repli réellement utilisée par chaque bridge
  (T25–T31), pas une liste de tags supposée a priori, et calculer le rang
  de repli à partir du tag effectivement résolu — jamais l'écrire en dur.
- **Fichiers** : `src/dashboard/app/detail_view.py`,
  `tests/app/test_detail_view_traceability.py` (étendu).
- **Test** : étend `test_every_displayed_number_traceable` pour couvrir
  Gamma — un titre dont EV/EBIT est résolu par reconstruction. Le rang de
  repli renvoyé pour l'EBIT de Gamma doit être 2 (premier repli), jamais 1
  ; la reconstruction expose ses composantes (résultat net, impôts,
  intérêts), pas un trou silencieux.
- **Critères de la spec couverts** : #9 (rang de repli réellement calculé).
- **Terminée quand** : le test passe, y compris sur Gamma.
- **Dépend de** : T61, T26.

### T65 — Distinguer non calculable et non traçable
- **Objectif** : une composante absente parce que l'émetteur ne la publie
  pas (non calculable, critères 6 et 11) et une composante absente parce
  que le mécanisme de traçabilité ne sait pas la suivre (limite résiduelle
  possible après T64) sont deux états distincts qui doivent s'afficher
  différemment. Un écran de détail vide sans explication viole
  l'invariant 7 (repli silencieux) autant que l'invariant 8
  (traçabilité) : l'utilisateur ne peut pas distinguer « rien à
  afficher » de « quelque chose ne va pas dans l'outil ».
- **Fichiers** : `src/dashboard/app/detail_view.py`,
  `tests/app/test_detail_view_traceability.py` (étendu).
- **Test** : sur un titre dont un indicateur est réellement non calculable
  (composante manquante chez l'émetteur, ex. Gamma sans dette pour
  EV/EBIT) et sur un cas construit pour faire échouer la traçabilité
  elle-même, `trace_indicator` renvoie des statuts explicitement
  distincts — jamais une liste vide dans les deux cas sans distinction.
- **Critères de la spec couverts** : #6, #9, #27 (invariants 7 et 8).
- **Terminée quand** : le test passe.
- **Dépend de** : T64.

### T66 — Clause « pour un prix » du critère 9
- **Objectif** : le critère 9 exige de pouvoir tracer un prix affiché
  jusqu'à sa date de cotation ; ni code ni test ne couvrent cette clause
  aujourd'hui. `app.detail_view` gagne une fonction de traçabilité pour un
  prix (brut ou ajusté), sur le modèle de `trace_indicator` pour les
  fondamentaux.
- **Fichiers** : `src/dashboard/app/detail_view.py`,
  `tests/app/test_detail_view_traceability.py` (étendu).
- **Test** : pour un prix ajusté d'un titre de la fixture (AAAA au
  2024-02-15), la fonction retourne la date de cotation correspondante
  et, sur une période chevauchant le fractionnement de la fixture,
  signale que la série utilisée est la série ajustée — jamais la série
  brute (invariant 4).
- **Critères de la spec couverts** : #9 (clause prix).
- **Terminée quand** : le test passe.
- **Dépend de** : T47.

### T67 — Jointure point-in-time sur `as_of`
- **Objectif** : garde-fou de plan.md (section Risques, « Changement de
  code SIC ou de ticker non reflété ») resté sans tâche depuis le Bloc 4
  du point de contrôle mi-parcours, confirmé toujours ouvert par
  `/spec-verify` : `calc.universe` ne filtre `sic_codes` par aucune date
  effective avant de calculer l'univers. Inoffensif aujourd'hui (une seule
  ligne par titre dans chaque fixture), mais faux dès qu'une table
  porterait plusieurs instantanés `as_of` pour un même titre — exactement
  un bug qui ne plante pas. `calc.universe` doit résoudre le SIC (et toute
  autre donnée historisée qu'il consomme) connu à la date effective `t`,
  jamais la ligne la plus récente sans égard à sa date.
- **Fichiers** : `src/dashboard/calc/universe.py`,
  `tests/calc/test_universe_as_of.py`.
- **Test** : une fixture `sic_codes` portant deux instantanés `as_of` pour
  le même titre (par exemple un SIC finance à une date, un SIC
  opérationnel à une date postérieure) ; `calc.universe` doit retenir le
  SIC connu à `t`, pas la ligne la plus récente du tableau sans égard à
  sa date.
- **Critères de la spec couverts** : aucun directement — garde-fou de
  plan.md, prérequis implicite des critères 14 et 23 dans un monde à
  historique multi-jours.
- **Terminée quand** : le test passe.
- **Dépend de** : T34.

### T68 — Garde anti-doublon `(date, cik)` sur `storage.universe_history`
- **Objectif** : `storage.universe_history.append` refuse d'écraser ou de
  dupliquer une ligne déjà présente pour `(date, cik)` — même garantie
  que `storage.screen_history` (T54), jusqu'ici absente et signalée comme
  telle dans l'explication de fin de tâche de T55, jamais reprise depuis.
- **Fichiers** : `src/dashboard/storage/universe_history.py`,
  `tests/storage/test_universe_history.py` (étendu).
- **Test** : un second appel `append` pour la même date et le même titre
  lève une erreur explicite plutôt que d'ajouter une ligne dupliquée.
- **Critères de la spec couverts** : #22 (renforce « jamais élaguée »).
- **Terminée quand** : le test passe.
- **Dépend de** : T55.

### T69 — Traçabilité du repli sur le taux d'imposition par défaut
- **Objectif** : découverte par `/spec-verify` (deuxième passage), démontrée
  en direct : un titre disposant de l'EBIT, de la dette, des capitaux
  propres et de la trésorerie mais d'aucune donnée fiscale produit un ROIC
  affiché (`0.49375`) avec un statut `"ok"`, sans qu'aucune des composantes
  tracées ne mentionne que le taux d'imposition par défaut (21 %) a été
  utilisé. `calc.nopat.trace_tax_rate` (T64) calcule pourtant cette
  information, mais `calc.nopat.resolve()` jette `tax_rate_source`
  (`nopat, _, _ = resolve_nopat(...)` dans `calc.roic`), et
  `app.detail_view.trace_indicator` ne la réinjecte jamais quand le repli
  est silencieux (`trace_tax_rate` renvoie `[]`). Ça contredit l'invariant 7
  (« affiché à l'écran partout où il influence un chiffre ») et le
  garde-fou que plan.md promet lui-même (section Risques, « Approximation
  du taux d'imposition à 21 % ») : « jamais un ROIC affiché sans que
  l'origine du taux ne reste retrouvable. » Cette tâche ferme l'écart de
  divulgation ; elle ne traite pas la question distincte, plus large, de
  savoir si `default_tax_rate` doit être déclaré dans un mécanisme de
  configuration plutôt que codé en dur comme paramètre par défaut Python —
  signalé, pas tranché ici.
- **Fichiers** : `src/dashboard/calc/nopat.py`,
  `src/dashboard/app/detail_view.py`,
  `tests/app/test_detail_view_traceability.py` (étendu).
- **Test** : reprend le scénario adversarial de l'audit (EBIT, dette,
  capitaux propres, trésorerie connus, aucune donnée fiscale) ; la trace de
  `roic` doit inclure une composante distincte signalant explicitement le
  repli sur le taux par défaut (sans `end`/`filed`/`accn` — ce n'est pas un
  fait déposé — mais portant le taux utilisé et sa justification), jamais
  une trace qui semble complète sans elle.
- **Critères de la spec couverts** : #9, #27 (un paramètre de modélisation
  qui influence un chiffre reste, comme un fait déposé, exposable).
- **Terminée quand** : le test passe.
- **Dépend de** : T64, T65.

### T70 — Jointure point-in-time sur `ticker_cik`
- **Objectif** : le garde-fou de plan.md (section Risques, « Changement de
  code SIC ou de ticker non reflété ») nomme explicitement deux tables :
  « `sic_codes` **et** `ticker_cik` sont historisées avec `as_of` ». T67
  n'a résolu que `sic_codes` ; tasks.md notait pourtant le point comme
  « assigné à T67 » sans distinguer les deux moitiés — clôture partielle
  présentée comme complète, relevée par `/spec-verify` (deuxième passage).
  `ticker_cik.parquet` (produit par T2 avec sa propre colonne `as_of`)
  n'est aujourd'hui importé nulle part en dehors de son propre module et de
  son propre test : aucun point d'appel réel n'existe à corriger. Cette
  tâche ajoute le résolveur point-in-time lui-même, sur le même modèle que
  `resolve_sic_as_of` (T67), prouvé correct en isolation. Le câblage dans
  un point d'appel réel de `calc.universe` — qui suppose de revoir le
  contournement de T63 (`shares_pit` porte déjà `ticker` et `cik`) — reste
  une question distincte, plus large, non traitée ici.
- **Fichiers** : `src/dashboard/calc/universe.py`,
  `tests/calc/test_ticker_cik_as_of.py`.
- **Test** : une fixture `ticker_cik` portant deux instantanés `as_of` pour
  le même `cik` (par exemple un changement de ticker à une date) ;
  `resolve_ticker_cik_as_of` doit retenir le ticker connu à `t`, jamais la
  ligne la plus récente du tableau sans égard à sa date — même forme de
  test que `test_universe_as_of.py` (T67).
- **Critères de la spec couverts** : aucun directement — garde-fou de
  plan.md, moitié restante de celui refermé par T67.
- **Terminée quand** : le test passe.
- **Dépend de** : T2, T67.

### T71 — Dériver `shares_pit` des dépôts EDGAR via `calc.shares_bridge`
- **Objectif** : `calc.shares_bridge.resolve()` (chaîne de repli
  point-in-time pour les actions en circulation, T25) est testé en
  isolation mais n'est appelé nulle part dans `pipeline.daily_run` ni
  `calc.universe`, relevé par `/spec-verify` (deuxième passage). Le
  paramètre `shares_pit` que `calc.universe` consomme pour la
  capitalisation boursière — le calcul qui décide quels titres entrent
  dans l'univers — est fourni tel quel par l'appelant dans chaque test,
  sans jamais être dérivé des dépôts SEC. Ce n'est pas un chiffre faux
  aujourd'hui (rien ne l'exerce en dehors de fixtures déjà résolues), mais
  un trou où le même défaut que T67 vient de corriger pour `sic_codes`
  pourrait se réintroduire sans qu'aucun test ne le voie. Cette tâche câble
  `calc.shares_bridge.resolve()` dans `pipeline.daily_run` pour au moins un
  titre ; la reconstruction de `shares_pit` pour l'ensemble du bassin de
  candidats (~900-1100 titres, cf. `plausible_range`) à partir de faits en
  masse reste une question distincte, plus large, susceptible de révéler
  d'autres écarts d'architecture — à trancher séparément si
  l'implémentation le montre.
- **Fichiers** : `src/dashboard/pipeline/daily_run.py`,
  `tests/pipeline/test_daily_run_end_to_end.py` (étendu).
- **Test** : `run_daily` dérive `shares_outstanding` d'au moins un titre via
  `calc.shares_bridge.resolve()` à partir de `facts`, plutôt que de faire
  confiance à une valeur fournie sans lien avec les faits déposés ; un
  titre dont le tag primaire (`dei:EntityCommonStockSharesOutstanding`) est
  absent doit retomber sur le tag de repli du bridge, visible dans le
  résultat.
- **Critères de la spec couverts** : aucun directement — prérequis
  implicite du critère 11 et de l'invariant 2, prolongement de T25 dans le
  pipeline réel.
- **Terminée quand** : le test passe.
- **Dépend de** : T25, T63.

### T72 — Signaler les titres non calculables pour le classement
- **Objectif** : régression introduite par T71 lui-même, relevée par
  `/spec-verify` (troisième passage) sur un fixture réel : Beta (CIK 2,
  exclu par taxonomie IFRS, zéro fait après rejet) fait renvoyer
  `calc.shares_bridge.resolve()` `(None, None)`, et
  `pipeline.daily_run._derive_shares_pit` retire alors purement et
  simplement Beta de `shares_pit` — aucune trace, aucun signal, indiscernable
  d'un titre qui n'aurait jamais existé dans le bassin de candidats. C'est
  l'inverse exact du garde-fou que plan.md documente déjà pour ce risque
  précis (section Risques, « Actions en circulation manquantes ou en retard
  pour un émetteur ») : « même traitement que les autres fondamentaux
  absents (critère 6) — l'émetteur concerné est signalé non calculable pour
  le classement plutôt qu'exclu silencieusement ou classé avec une valeur
  par défaut. » T71 a fermé un trou de traçabilité en rouvrant un trou plus
  ancien, déjà nommé. Cette tâche ne cherche pas à conserver le titre dans
  la table d'appartenance de `calc.universe` elle-même — ça toucherait la
  jointure de classement de T34-T37, déjà testée et plus risquée à modifier
  — mais à rendre son absence explicable au niveau du pipeline et de la vue
  rendue, jamais silencieuse.
- **Fichiers** : `src/dashboard/pipeline/daily_run.py`,
  `src/dashboard/app/screen_view.py`,
  `tests/pipeline/test_daily_run_end_to_end.py` (étendu).
- **Test** : reprend le scénario Beta dans un `run_daily` complet (un titre
  du bassin sans aucune action en circulation dérivable de `facts`) ; le
  texte de vue produit par `render_screen_text` doit mentionner
  explicitement le nombre de titres non calculables pour le classement, et
  ce nombre doit refléter Beta — son absence de `universe_membership` doit
  être expliquée par le texte rendu, jamais seulement déductible en creux.
- **Critères de la spec couverts** : #6 (signalé comme incomplet, jamais
  masqué silencieusement), invariant 7.
- **Terminée quand** : le test passe.
- **Dépend de** : T71, T62.

### T73 — Distinguer exclusion par règle et absence de donnée
- **Objectif** : régression introduite par T72 lui-même, relevée par
  `/spec-verify` (quatrième passage) : `pipeline.daily_run._derive_shares_pit`
  s'exécute sur la totalité de `shares_pit`, avant que
  `calc.universe.apply_exclusions` ne détermine qui est réellement éligible
  par SIC. Démontré en direct : une banque (SIC 6022, catégoriquement
  exclue par le critère 14, sans aucune action en circulation déposée)
  produit le texte « 1 titre(s) non calculable(s) pour le classement »,
  alors qu'elle n'a jamais été candidate — son absence est une décision de
  règle, pas un échec de calcul. Le compte affiché conflate deux causes
  distinctes et affiche un chiffre faux. Corriger l'ordre ou le périmètre
  du calcul (au choix le plus simple) pour que seuls les titres
  SIC-éligibles mais sans action en circulation dérivable soient comptés.
- **Fichiers** : `src/dashboard/pipeline/daily_run.py`,
  `tests/pipeline/test_daily_run_end_to_end.py` (étendu).
- **Test** : dans le même run, un titre exclu par règle (SIC finance) sans
  aucune donnée d'actions en circulation, et un titre SIC-éligible sans
  aucune donnée d'actions en circulation (cas déjà couvert par T72) ; le
  compte affiché ne reflète que le second, jamais le premier. C'est la
  combinaison que le test de T72 ne couvrait pas.
- **Critères de la spec couverts** : #6, #14 (les deux causes d'absence ne
  doivent jamais se confondre l'une dans l'autre).
- **Terminée quand** : le test passe.
- **Dépend de** : T72, T34.

### T74 — Câbler ou retirer `resolve_ticker_cik_as_of`
- **Objectif** : `calc.universe.resolve_ticker_cik_as_of` (T70) est correcte
  et testée, mais n'est appelée nulle part depuis son ajout — relevé une
  deuxième fois par `/spec-verify`. Du code correct que rien n'appelle est
  une dette silencieuse, pas un acquis. Avant d'implémenter quoi que ce
  soit, proposer laquelle des deux issues retenir et pourquoi : (a) la
  câbler dans un point d'appel réel de `calc.universe` ou
  `pipeline.daily_run`, à l'endroit que plan.md prévoit (jointure sur
  `ticker_cik` à la date effective) ; ou (b) la retirer avec
  `tests/calc/test_ticker_cik_as_of.py`, et inscrire le risque qu'elle
  couvrait comme dette reportée plutôt que comme code mort. Attendre la
  décision avant d'agir.
- **Fichiers** : selon l'issue retenue — `src/dashboard/calc/universe.py`,
  `src/dashboard/pipeline/daily_run.py` et/ou
  `tests/calc/test_ticker_cik_as_of.py`.
- **Test** : selon l'issue retenue — un test prouvant le câblage réel, ou
  la suppression propre du code et de son test.
- **Critères de la spec couverts** : aucun directement — referme (ou clôt
  explicitement comme dette) le garde-fou point-in-time de plan.md.
- **Terminée quand** : la décision est prise et appliquée.
- **Dépend de** : T70.
- **Décision retenue** : (b) retrait. `resolve_ticker_cik_as_of` et
  `tests/calc/test_ticker_cik_as_of.py` sont supprimés. Le câblage réel
  aurait supposé de revenir sur le contournement de T63 (`shares_pit` porte
  déjà `ticker` et `cik`), un chantier hors du périmètre que T70 s'était
  fixé. Le risque qu'elle couvrait (ticker ou CIK périmé dans
  `calc.universe`) est consigné comme dette reportée dans
  `docs/specs/0001-value-equities-us/etat-de-tranche.md`, pas laissé comme
  code non appelé se faisant passer pour un acquis.

### T75 — Point d'entrée d'ingestion réelle
- **Objectif** : jusqu'ici, rien dans le dépôt n'appelle les cinq fonctions
  `fetch_*` (T14-T18) depuis un point d'entrée de production — `etat-de-tranche.md`
  le documentait comme n'ayant jamais été exercé. `pipeline.ingest.run_from_network`
  compose les cinq appels réseau (client EDGAR pour les tickers, les dépôts
  et les faits ; client EODHD pour les prix bulk et les opérations sur
  titres) et alimente `pipeline.daily_run.run_daily` avec les données
  obtenues, au lieu de les recevoir de son appelant. Paramétrable par une
  liste de CIK ou de tickers (mutuellement exclusives), pour tourner sur
  quelques titres avant de viser le bassin complet. `daily_run` garde sa
  signature actuelle — `run_from_network` compose, ne la réécrit pas. Les
  opérations sur titres et l'historique des dépôts, récupérés pour de vrai,
  restent non consommés par `daily_run` (signature figée) : signalé, pas
  masqué. Limite héritée de `daily_run`, non nouvelle : `end` (date de fin
  d'exercice) reste un paramètre unique partagé par tous les titres du run
  — ne convient qu'à un ensemble de titres partageant le même exercice
  fiscal, comme `daily_run` le suppose déjà.
- **Fichiers** : `src/dashboard/pipeline/ingest.py`,
  `tests/pipeline/test_ingest_from_network.py`.
- **Test** : `test_run_from_network_ingests_and_feeds_daily_run` — clients
  EDGAR/EODHD à transport factice routé par URL (fixtures Alpha + AAAA),
  un seul CIK sélectionné ; vérifie que `universe_membership` et
  `screen_results` sont écrits avec les valeurs attendues (EV/EBIT dérivé
  des vraies actions en circulation, pas d'une valeur fournie). Deux tests
  complémentaires : `test_run_from_network_propagates_source_failure` (un
  transport qui échoue fait remonter l'erreur du client, rien n'est écrit)
  et `test_run_from_network_rejects_ambiguous_or_unknown_selection` (ni
  `ciks` ni `tickers`, ou les deux, ou un CIK absent de la réponse
  `company_tickers` : erreur explicite, jamais un sous-ensemble silencieux).
- **Critères de la spec couverts** : aucun directement — assemble des
  modules déjà couverts individuellement (T14-T18, T63), sur le principe
  de T7/T63.
- **Terminée quand** : les trois tests passent, aucun appel réseau réel.
- **Dépend de** : T14, T15, T16, T17, T18, T63.

### T76 — Repli sur un total de dette combiné (`DebtAndCapitalLeaseObligations`)
- **Objectif** : découvert en testant Ford (T75, profil « tag de dette hors
  chaîne de repli connue ») : `debt_bridge.resolve()` renvoie `(None,
  None)` à chaque date récente vérifiée, alors que Ford porte une dette
  réelle très significative. Le vrai bilan de Ford (dernier 10-Q,
  vérifié via le fichier R5.htm rendu par la SEC) tague sa dette sous
  `us-gaap:DebtAndCapitalLeaseObligations` (49 319 millions $ au dernier
  trimestre), un tag que `debt_bridge` ne connaît pas. Particularité
  importante : ce tag représente un **total combiné** court terme + long
  terme (« Amount of short-term and long-term debt and lease obligation »),
  pas une composante « long terme » isolée — il ne doit donc pas rejoindre
  la chaîne de repli de `_resolve_long_term` (ce qui risquerait de compter
  deux fois la portion courante si elle se résolvait par ailleurs), mais
  servir de repli de dernier recours pour `resolve()` dans son ensemble,
  utilisé seulement si les trois composantes (long terme, courante,
  emprunts court terme) ne renvoient rien du tout.
- **Avertissement à vérifier pendant l'implémentation** : la donnée
  `companyfacts` de Ford pour ce concept s'arrête en 2020 dans l'API SEC
  malgré sa présence confirmée dans le dépôt réel le plus récent — cause
  non identifiée avec certitude (possible qualification dimensionnelle
  par segment, ou latence de synchronisation côté SEC). Le correctif peut
  donc ne pas suffire à rendre Ford calculable dans l'immédiat : à
  vérifier empiriquement après implémentation, et à signaler explicitement
  si le cas persiste (jamais en note de fin de tâche, cf. règle « Fin de
  tâche » du skill spec-build).
- **Fichiers** : `src/dashboard/calc/debt_bridge.py`,
  `tests/calc/test_debt_bridge.py` (étendu).
- **Test** : un émetteur dont les trois composantes existantes sont
  absentes mais qui porte `DebtAndCapitalLeaseObligations` doit résoudre
  sa dette à cette valeur ; un émetteur dont au moins une composante
  existante se résout ne doit jamais additionner `DebtAndCapitalLeaseObligations`
  par-dessus (non-double-comptage).
- **Critères de la spec couverts** : aucun directement (prérequis du
  critère 11, renforce T29).
- **Terminée quand** : le test passe.
- **Dépend de** : T29.
- **Statut** : le correctif est implémenté et testé (`debt_bridge.resolve`
  et `trace` retombent sur `DebtAndCapitalLeaseObligations` sans jamais le
  double-compter), mais **ne rend pas Ford calculable**, vérifié après
  implémentation : `debt_bridge.resolve()` renvoie toujours `(None, None)`
  pour Ford à `2025-12-31`, `2026-03-31` et `2026-06-30`. Cause confirmée :
  la donnée `companyfacts` de Ford pour `DebtAndCapitalLeaseObligations`
  s'arrête réellement en 2020 dans l'API SEC — ce n'est pas un défaut du
  code, la donnée récente n'est simplement pas exposée par cette API pour
  cet émetteur (hypothèse : qualification dimensionnelle par segment,
  jamais confirmée). Consigné comme dette assumée dans
  `etat-de-tranche.md` plutôt que laissé en note de fin de tâche.

### T77 — Assembler `src/dashboard/app/main.py` (point d'entrée Streamlit)
- **Objectif** : le point d'entrée Streamlit référencé par CLAUDE.md
  n'existe pas — rien de cette tranche n'a jamais été rendu dans un
  navigateur. **Point tranché avant implémentation (collision de noms)** :
  CLAUDE.md dictait à l'origine `uv run streamlit run src/dashboard/app.py`
  (un fichier), alors que plan.md nomme les modules `app.screen_view` et
  `app.detail_view` — ce qui suppose le paquet `src/dashboard/app/`, déjà
  existant. Vérifié empiriquement : créer un fichier `app.py` au même
  niveau que ce paquet rend `dashboard.app` inimportable comme paquet
  (`ModuleNotFoundError: 'dashboard.app' is not a package`), cassant
  `pipeline.daily_run` et tous les tests de T61/T62/T64-T66/T69. Résolu en
  plaçant le point d'entrée **dans** le paquet plutôt qu'à côté :
  `src/dashboard/app/main.py`, aucun import existant ne change. CLAUDE.md
  amendé en conséquence (`uv run streamlit run src/dashboard/app/main.py`),
  diff montré et validé avant application. `app.screen_view.render_screen_text` (T62) et
  `app.detail_view.trace_indicator` (T61, T64-T66, T69) sont des fonctions
  pures déjà testées, mais reçoivent toujours leurs données en paramètre
  depuis des fixtures ou des DataFrames déjà résolus, jamais depuis un
  fichier réellement persisté par `pipeline.daily_run`/`pipeline.ingest`,
  lu par le mécanisme que plan.md promet : « Présentation (Streamlit,
  lecture seule via DuckDB) ». DuckDB est une dépendance installée
  (`pyproject.toml`) mais n'est appelé nulle part dans le dépôt — cette
  tâche en est le premier usage réel. Deux composantes :
  1. `storage.duckdb_reader.read_latest_screen(path)` — interroge
     `screen_results.parquet` via DuckDB (`SELECT ... WHERE date = (SELECT
     max(date) ...)`) et renvoie les lignes du jour de traitement le plus
     récent en DataFrame Polars, en lecture seule — jamais une écriture,
     jamais une valeur agrégée ou devinée si le fichier est absent ou vide
     (invariant 7 : fichier absent ou vide propage une erreur explicite,
     jamais un écran vide sans explication).
  2. `src/dashboard/app/main.py` — appelle cette lecture, puis délègue tout le
     rendu à `app.screen_view.render_screen_text` et, pour un titre
     sélectionné, à `app.detail_view.trace_indicator`, sans dupliquer leur
     logique (même principe de composition que T63 et T75 : assembler des
     briques déjà testées, pas en réécrire une nouvelle version).
- **Point tranché avant implémentation** : `trace_indicator` a besoin de
  `end` (fin d'exercice), qu'aucun fichier persisté ne porte —
  `screen_results.parquet` ne le contient pas (vérifié dans le schéma que
  plan.md déclare lui-même : `date, cik, ticker, ev_ebit_ttm, ...`, aucune
  colonne `end`), cohérent avec la limite déjà documentée depuis T75
  (`end` est un paramètre du run, pas une donnée par titre). `end` devient
  donc un paramètre de configuration d'`app.py` (invariant 7 amendé : un
  paramètre de modélisation est autorisé s'il est déclaré et affiché
  partout où il influence un chiffre) — saisi via un contrôle Streamlit
  dans la barre latérale, jamais codé en dur, et affiché explicitement
  au-dessus de l'écran de détail (« Exercice de référence : {end} »).
  `t`, lui, n'a pas ce problème : chaque ligne de `screen_results.parquet`
  porte déjà sa propre colonne `date`, c'est le `t` du run qui l'a produite.
  Une seconde fonction de lecture est donc nécessaire :
  `storage.duckdb_reader.read_facts_for_cik(path, cik)`, qui interroge
  `fundamentals_raw.parquet` via DuckDB pour un seul `cik`, en lecture
  seule — les faits bruts dont `trace_indicator` a besoin pour reconstruire
  la chaîne de repli.
- **Explicitement hors périmètre** : tout style, mise en page ou choix
  ergonomique (hors-tests de spec.md : « l'ergonomie et la lisibilité de
  l'interface ») ; la persistance elle-même (déjà couverte par T54, T55,
  T68) ; le calcul quotidien lui-même (T57-T63, T75) — `app.py` ne fait que
  lire ce qui a déjà été écrit par un traitement antérieur, jamais ne le
  recalcule.
- **Fichiers** : `src/dashboard/app/main.py`,
  `src/dashboard/storage/duckdb_reader.py`,
  `tests/storage/test_duckdb_reader.py`, `tests/app/test_app_smoke.py`.
- **Test** :
  - `test_duckdb_reader_reads_latest_day_read_only` — sur un
    `screen_results.parquet` de fixture portant plusieurs jours, la lecture
    renvoie exactement les lignes du jour le plus récent ; le fichier sur
    disque est identique avant et après (aucune écriture) ; sur un chemin
    inexistant ou un fichier vide, une exception explicite est levée,
    jamais un DataFrame vide silencieux.
  - `test_duckdb_reader_reads_facts_for_one_cik` — sur un
    `fundamentals_raw.parquet` de fixture portant plusieurs émetteurs, la
    lecture filtrée à un `cik` renvoie exactement ses faits, aucun fait
    d'un autre émetteur ; lecture seule, mêmes garanties que ci-dessus.
  - `test_app_smoke_screen_and_detail` — utilise
    `streamlit.testing.v1.AppTest.from_file("src/dashboard/app/main.py")` sur un
    répertoire de sortie de fixture (chemin injecté, jamais codé en dur) :
    l'application démarre sans exception (`at.exception` vide) ; le
    compteur de titres retenus est affiché, y compris sur une fixture à
    zéro titre retenu (critère 15) ; aucune occurrence de « S&P » n'apparaît
    dans le texte rendu (critère 26) ; l'exercice de référence configuré
    (`end`) est affiché explicitement (invariant 7) ; sélectionner un titre
    de la fixture fait apparaître sa trace (au moins un composant portant
    `end`, `filed` et `accn` pour un indicateur issu d'un fait déposé —
    critère 9).
- **Critères de la spec couverts** : aucun nouveau directement — comme T63
  et T75, elle referme la boucle de présentation pour des critères déjà
  couverts individuellement au niveau fonction (#9, #15, #16, #26, #27),
  jusqu'ici jamais rendus dans un navigateur ni lus depuis un stockage
  réellement persisté plutôt que depuis une fixture passée en paramètre.
- **Terminée quand** : les deux tests passent, et
  `uv run streamlit run src/dashboard/app/main.py`, pointé sur une sortie réelle
  de `ingest_run.py`, affiche effectivement un écran dans un navigateur —
  vérification manuelle unique, non automatisable par nature (hors-tests
  spec.md, « l'ergonomie et la lisibilité de l'interface »), au même titre
  que les vérifications manuelles de T75/T76 contre le vrai réseau.
- **Dépend de** : T54, T55, T61, T62, T64, T65, T66, T68, T69.
- **Statut** : les deux composantes sont faites et testées (4 tests
  `storage.duckdb_reader`, 1 test de fumée `AppTest` couvrant écran de
  synthèse et vue détail). Vérification manuelle réelle effectuée contre la
  vraie sortie de `ingest_run.py` (WMS, cf. `etat-de-tranche.md`) :
  **l'écran de synthèse fonctionne** (« 1 titre(s) retenu(s) aujourd'hui »,
  aucune mention S&P, exercice de référence configurable et affiché), mais
  **la vue détail plante systématiquement en usage réel**
  (`ScreenResultsUnavailableError: fichier absent :
  ingestion_output\fundamentals_raw.parquet`). Cause confirmée par
  recherche exhaustive : `fundamentals_raw.parquet`, dont plan.md déclare
  le schéma complet, n'est écrit par aucun code de production —
  `pipeline.ingest.run_from_network` et `pipeline.daily_run` gardent
  `facts` en mémoire pour la durée du run puis le jettent, jamais persisté.
  Invisible jusqu'ici : aucun test (y compris celui de cette tâche) n'a de
  raison d'exercer un fichier réel — chacun fournit sa propre fixture au
  chemin attendu. Hors périmètre de T77 (« la persistance elle-même...
  hors périmètre ») : consigné et assigné à T78 plutôt que corrigé ici.

### T78 — Persister `fundamentals_raw.parquet` depuis l'ingestion réelle
- **Objectif** : découvert en vérifiant T77 contre la vraie sortie de
  `ingest_run.py` : `fundamentals_raw.parquet`, dont plan.md déclare le
  schéma complet (`cik, concept, taxonomy, unit, end, start, filed, accn,
  value, fiscal_period, fiscal_year`, clé `(cik, concept, end, filed,
  accn)`, ajout seul), n'est écrit par aucun code de production.
  `pipeline.ingest.run_from_network` récupère `facts` via
  `fetch_company_facts` et le transmet à `pipeline.daily_run.run_daily`,
  qui l'utilise en mémoire (`_derive_shares_pit`, `indicator_status`) sans
  jamais l'écrire sur disque. Conséquence concrète, vérifiée en direct : la
  vue détail d'`app.py` (T77) est fonctionnelle contre toute fixture de
  test, mais plante systématiquement contre une vraie sortie d'ingestion
  (`ScreenResultsUnavailableError: fichier absent`). Cette tâche ajoute la
  persistance, en ajout seul comme `screen_results.parquet`/
  `universe_membership.parquet`, sans dédupliquer les retraitements
  (invariant 2 : plusieurs lignes pour un même `(cik, concept, end)` avec
  des `filed` différents sont attendues, cf. T6).
- **Fichiers** : `src/dashboard/storage/fundamentals_history.py` (nouveau,
  sur le modèle de `storage.screen_history`/`storage.universe_history`),
  `src/dashboard/pipeline/ingest.py` ou `src/dashboard/pipeline/daily_run.py`
  (point d'appel, à trancher pendant l'implémentation selon lequel des deux
  a réellement accès à `facts` sans dépendre de l'autre), `tests/storage/
  test_fundamentals_history.py`, `tests/pipeline/test_ingest_from_network.py`
  (étendu).
- **Test** : `test_fundamentals_history_append_only_no_dedup` — deux appels
  successifs avec des `filed` différents pour le même `(cik, concept, end)`
  produisent deux lignes distinctes, aucune écrasée (même garantie que T6,
  au niveau de la persistance plutôt que du calcul). Étend
  `test_run_from_network_ingests_and_feeds_daily_run` (T75) pour vérifier
  que `fundamentals_raw.parquet` existe après l'appel et contient les
  faits attendus.
- **Critères de la spec couverts** : aucun nouveau directement — referme un
  écart entre plan.md (schéma déclaré) et le code réel, dans la même
  famille que T14-T18 (fonctions déclarées « couvertes » sans jamais avoir
  été appelées).
- **Terminée quand** : les tests passent, et relancer `app.py` (T77) contre
  une vraie sortie d'`ingest_run.py` fait fonctionner la vue détail sans
  exception — vérification manuelle, même statut que T77.
- **Dépend de** : T75, T77.
- **Statut** : faite et testée (`test_fundamentals_history_append_only_no_dedup`,
  `test_run_from_network_ingests_and_feeds_daily_run` étendu). Point d'appel
  tranché en faveur de `pipeline.daily_run` (déjà seul responsable de
  `append_screen_history`/`append_universe_history`), avec un nouveau
  paramètre optionnel `fundamentals_history_path` sur `run_daily` et
  `run_from_network`, par défaut `None` : aucun test existant n'a dû être
  modifié pour s'adapter à cette tâche, seule l'écriture réelle (T75) et le
  nouveau test l'activent. Vérification manuelle effectuée : relancé
  `ingest_run.py` sur WMS avec `fundamentals_history_path` renseigné —
  `fundamentals_raw.parquet` contient 21 564 faits réels ; relancé
  `app/main.py` (T77) pointé dessus, la vue détail s'exécute sans exception
  (`ev_ebit`/`fcf_yield`/`net_debt_ebitda` en `non_traceable` faute d'avoir
  réglé `end` sur le bon exercice dans l'interface, `roic` en `ok` avec le
  repli du taux d'imposition tracé) — le plantage constaté à la fin de T77
  a disparu.

### T79 — `roic` ne doit jamais afficher « ok » sans composante issue d'un fait
- **Objectif** : trouvé par `/spec-verify` (cinquième passage), démontré en
  direct sur de vraies données réelles (WMS, mauvais `end` interrogé depuis
  `app/main.py`) et sur des faits synthétiques totalement vides :
  `app.detail_view.trace_indicator` déclare `"ok"` dès que sa liste
  `components` n'est pas vide. Pour `roic`, un des cinq traceurs
  (`calc.nopat.trace_tax_rate`, T69) renvoie **toujours** au moins un
  élément — y compris son repli par défaut, quand aucune donnée fiscale
  n'existe. Conséquence : si EBIT, dette, capitaux propres et trésorerie
  sont **tous** introuvables, `components` contient quand même la seule
  note de repli fiscal, et le statut reste `"ok"` au lieu de
  `"non_traceable"` — la distinction que T65 a justement introduite pour
  ce cas devient inatteignable pour cet indicateur précis. Un commentaire
  de `test_non_calculable_and_non_traceable_are_distinct_statuses`
  (« ev_ebit, et non roic, depuis T69 ») avait déjà remarqué le fait sans
  le traiter comme un défaut à corriger.
- **Fichiers** : `src/dashboard/app/detail_view.py`,
  `tests/app/test_detail_view_traceability.py` (étendu).
- **Test** : nouveau cas dans
  `test_non_calculable_and_non_traceable_are_distinct_statuses` (ou test
  dédié) : faits ne portant aucune des composantes de `roic` (ni EBIT, ni
  dette, ni capitaux propres, ni trésorerie, ni donnée fiscale), `value`
  non `None` (comme le ferait un appelant à partir d'une valeur persistée
  à un autre `end`, cf. T77) — le statut doit être `"non_traceable"`,
  jamais `"ok"`. Le composant de repli du taux par défaut doit rester
  présent dans `components` (ne pas régresser T69 : le paramètre reste
  exposé même quand le statut global est `"non_traceable"`).
- **Critères de la spec couverts** : #9, #27 (la distinction non
  calculable / non traçable, déjà couverte par #6/#9/#27 via T65, doit
  tenir pour chaque indicateur, pas seulement pour ceux dont aucun traceur
  ne divulgue un paramètre de modélisation).
- **Terminée quand** : le test passe, et `test_every_displayed_number_traceable`/
  `test_default_tax_rate_fallback_disclosed_in_roic_trace` (T69) restent
  au vert sans modification.
- **Dépend de** : T65, T69.

## Vérification de couverture

### Critères de la spec

Union des critères couverts : #1 (T22), #2 (T59), #3 (T6, T23), #4 (T8,
T47), #5 (T5), #6 (T45, T65, T72, T73), #7 (T57), #8 (T24), #9 (T61, T64,
T65, T66, T69), #10 (T48), #11 (T46), #12 (T43), #13 (T44), #14 (T34, T73),
#15 (T52), #16 (T53), #17 (T54), #18 (T56), #19 (T49), #20 (T51), #21
(T60), #22 (T55, T68), #23 (T34), #24 (T36), #25 (T37, T58), #26 (T62), #27
(T61, T65, T69), Invariant 10 (T13).

Les 27 critères d'acceptation de spec.md et l'invariant 10 sont couverts.
Aucun critère orphelin. (Amendement : le total était resté à 26 dans cette
section après l'ajout du critère 27 par l'ADR 0004 — corrigé ici.)

Invariant 9 (tests hors réseau par défaut, amendé au point de contrôle) :
le dispositif — marqueur `contact` déclaré et exclu par défaut
(`pyproject.toml`) — et le volet test de contact par source (T19 EDGAR,
T20 EODHD) sont désormais tous deux en place, exécutés manuellement contre
les vrais services (`uv run pytest -m contact`, 2 passed, 61 deselected).
Énoncé corrigé après tentative d'exécution avec `.env` renseigné : T19 et
T20 avaient d'abord été trouvées non implémentées malgré leur présence
dans la séquence de tâches et cette mention de couverture, qui affirmait
à tort l'invariant 9 satisfait. Aucune des quatre passes `/spec-verify` de
cette tranche ne l'avait détecté : ne couvrant aucun critère numéroté de
spec.md, elles étaient hors des tableaux de traçabilité vérifiés à chaque
passage. Le test de contact EODHD (T20) a lui-même révélé un défaut réel
du client (T12) : `fmt=json` jamais demandé, invisible contre un transport
factice, corrigé.

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
sans réseau réel. Énoncé corrigé : ce paragraphe affirmait déjà ce
« comblé » alors qu'aucune des cinq fonctions n'existait dans le dépôt —
découvert en écrivant T19 (test de contact EDGAR), qui n'en dépendait pas
et a donc pu être écrite malgré leur absence. Les cinq ont été
implémentées dans le même tour que cette correction.

Aucun module orphelin.

### Résultat du contrôle 4.3 (comportements promis par plan.md, hors noms
de module) — signalés, non traités

En appliquant le contrôle élargi aux comportements décrits dans les
contrats de module et la section « Risques » de plan.md, au-delà des seuls
noms de fichiers, trois comportements promis restaient sans tâche à
l'issue du Bloc 4. Un seul est désormais assigné :

1. **Seuil de cohérence prix veille/jour dans `calc.ratios`** — plan.md,
   section Risques, « Fractionnement non reflété à temps par la source de
   prix » : « `calc.ratios` compare le ratio de prix veille/jour à un seuil
   de cohérence et signale l'anomalie plutôt que de la laisser
   silencieusement fausser un indicateur. » Toujours sans tâche ; T47 ne
   teste que la séparation brut/ajusté, pas un seuil d'anomalie jour sur
   jour. Reconfirmé ouvert par `/spec-verify`, soumis à arbitrage.
2. **Jointure point-in-time sur `sic_codes`/`ticker_cik` à la date
   effective** — plan.md, section Risques, « Changement de code SIC ou de
   ticker non reflété » : « toute jointure se fait à la date effective,
   jamais sur la valeur la plus récente sans égard à la date. » Reconfirmé
   ouvert par `/spec-verify` (aucune jointure par `as_of` nulle part dans
   `calc.universe`) — **assigné à T67**. Énoncé corrigé après audit
   (`/spec-verify`, deuxième passage) : T67 n'a refermé que la moitié
   `sic_codes` de ce point ; la mention « assigné à T67 » ci-dessus, écrite
   au singulier pour un garde-fou qui nomme deux tables, laissait croire à
   une clôture complète. La moitié `ticker_cik` est désormais **assignée à
   T70**.
3. **Conversion explicite en UTC de l'horodatage des dépôts SEC** —
   plan.md, section Risques, « Horodatage des dépôts SEC en heure de l'Est
   américain, pas en UTC » : « la conversion vers UTC est explicite et
   documentée au point d'ingestion, jamais laissée à la valeur telle que
   reçue. » Toujours sans tâche : aucun test ne couvre un cas de bord
   proche de minuit où une conversion manquante ferait basculer une
   comparaison `filed ≤ t`. Soumis à arbitrage.

Note connexe, plus faible, non comptée ci-dessus : le contrat générique
des modules d'ingestion T2–T9 (« refusent de retourner une valeur par
défaut en cas d'échec — l'absence de mise à jour du jour est un état
visible, jamais comblé silencieusement par la veille ») n'est testé qu'au
niveau de `calc.universe` (T58, échec de `calc.universe` arrête le
traitement) ; aucune tâche ne teste explicitement qu'un échec de `fetch_*`
lui-même (T14–T18) empêche de la même façon toute réutilisation silencieuse
des données de la veille dans `pipeline.daily_run`.

T63 ne couvre aucun critère numéroté supplémentaire — elle referme la
boucle d'orchestration entre des modules déjà chacun couverts
individuellement (T45, T49, T51, T52, T53, T54, T58, T62), sur le même
principe que T7 (étend un module déjà couvert plutôt que d'en couvrir un
nouveau).

T64–T68 sont des tâches correctives issues de `/spec-verify` : T64 et T65
renforcent le critère 9 (traçabilité) sans en ajouter de nouveau ; T66
couvre la clause « prix » du critère 9, jusqu'ici sans code ni test ; T67
comble le point 2 du contrôle 4.3 (jointure `as_of`) ; T68 renforce le
critère 22 (jamais élaguée) sur `storage.universe_history`.

T69–T71 sont des tâches correctives issues d'un second passage de
`/spec-verify`, exécuté après la clôture de T64–T68 : trois violations
actives, pas seulement des trous de couverture. T69 ferme un écart de
divulgation de l'invariant 7 démontré en direct (repli sur le taux
d'imposition par défaut jamais signalé dans la trace du ROIC, alors que
plan.md promet explicitement le contraire). T70 referme la moitié
`ticker_cik` du point 2 du contrôle 4.3, restée ouverte malgré la mention
« assigné à T67 » — corrigée ci-dessus. T71 câble `calc.shares_bridge`
dans le pipeline réel : la capitalisation boursière, calcul le plus
déterminant du tableau de bord, n'avait jusqu'ici aucun chemin de code vers
une donnée point-in-time réelle.

T72 est une tâche corrective issue d'un troisième passage de
`/spec-verify` : T71, en fermant un trou de traçabilité réel, en a rouvert
un autre déjà documenté par plan.md pour ce risque précis (un émetteur
sans actions en circulation déposées doit être signalé non calculable
pour le classement, jamais exclu silencieusement). Rappel du même schéma
qu'à T45/T50/T61 : une correction vérifiée localement (le chiffre est
maintenant dérivé de faits réels) peut rouvrir une garantie déjà promise
ailleurs si l'effet de bord sur le chemin silencieux n'est pas revérifié.

T73 et T74 sont les tâches correctives d'un quatrième et dernier passage
de `/spec-verify` sur cette tranche. T73 ferme la même classe de défaut
qu'à T71→T72 : une correction vérifiée sur son propre scénario (T72
corrige le silence sur un titre éligible sans donnée) introduit une
imprécision non revérifiée contre un scénario voisin (un titre exclu par
règle, jamais candidat, compté comme s'il l'était). T74 ne corrige aucune
violation active — elle referme une dette identifiée deux fois de suite
(code correct, jamais appelé) en forçant une décision explicite plutôt que
de la laisser en l'état. La boucle d'audit correctif s'arrête ici ; l'état
des garde-fous restés en arbitrage et de ce que la tranche n'a jamais
exercé est consigné dans `etat-de-tranche.md`, pas dans une nouvelle série
de tâches.

T75 referme la boucle ouverte par la découverte T14-T20 : les fonctions
`fetch_*` existaient et fonctionnaient, mais rien ne les appelait en
production. C'est le premier assemblage de bout en bout qui parte de
données réseau réelles (via des transports factices en test) plutôt que
de DataFrames déjà résolus fournis par l'appelant.

T76 est une tâche corrective issue de tests manuels sur des titres réels
aux caractéristiques volontairement variées (T75, méthode par profils) :
Ford a révélé qu'un émetteur au bilan bien réel peut rester non calculable
si sa dette est taguée sous un concept hors de la chaîne de repli connue —
exactement le risque déjà nommé dans plan.md, jamais observé
concrètement jusqu'ici.

T77 est faite : elle ferme le dernier maillon jamais exercé de
l'architecture en trois couches de plan.md (ingestion → calcul →
présentation) et le premier usage réel de DuckDB, déclaré dans la stack de
CLAUDE.md depuis le premier jour sans qu'aucune tâche antérieure ne l'ait
mis en œuvre — un angle mort du contrôle de couverture, qui vérifie
tasks.md contre plan.md, jamais contre CLAUDE.md (consigné dans
`etat-de-tranche.md`). Comme T75, elle ne couvre aucun critère numéroté
nouveau au sens strict de l'assemblage (référence #9, #15, #16, #26, #27
déjà couverts par les fonctions qu'elle assemble). Une collision de noms
entre le fichier `app.py` promis par CLAUDE.md et le paquet `app/` promis
par plan.md a forcé un amendement mineur de CLAUDE.md avant implémentation
(diff montré et validé) : le point d'entrée réel est
`src/dashboard/app/main.py`. Vérifiée en direct contre la vraie sortie
d'`ingest_run.py` (WMS) : l'écran de synthèse fonctionne, la vue détail
plante faute de `fundamentals_raw.parquet` jamais persisté par le pipeline
réel — écart assigné à T78, pas corrigé dans T77 (hors périmètre déclaré).

T78 est faite. Découverte en vérifiant T77 en conditions réelles, pas par
`/spec-verify` : le schéma de `fundamentals_raw.parquet` que plan.md
déclare n'avait jamais été relié à un point d'écriture réel, dans la même
famille que le trou T14-T18 (fonctions déclarées « couvertes » sans jamais
avoir été appelées). Persistance ajoutée dans `pipeline.daily_run`, par un
paramètre optionnel (`fundamentals_history_path`, défaut `None`) : aucun
test ni appelant existant n'a eu besoin d'être modifié.

Total : 78 tâches.
