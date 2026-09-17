# État de la tranche 0001 — value investing sur actions américaines

Note d'état, pas de plan. Elle liste ce qui reste ouvert et pourquoi, à
l'issue de 74 tâches et de quatre passages de `/spec-verify`. Aucune
recommandation ni priorisation n'y figure : ce sont des faits sur l'état
du code et de la documentation à cette date, à consulter avant toute
décision sur la suite.

## Dette reportée

### Garde-fou contre un ticker ou un CIK périmé dans `calc.universe`

Le garde-fou n'est pas en place. `plan.md` (section Risques, « Changement
de code SIC ou de ticker non reflété ») promet : « `sic_codes` et
`ticker_cik` sont historisées avec `as_of`, toute jointure se fait à la
date effective, jamais sur la valeur la plus récente sans égard à la
date. » Seule la moitié `sic_codes` est tenue (`calc.universe.resolve_sic_as_of`,
T67). La moitié `ticker_cik` ne l'est pas : c'est un écart connu entre le
plan et le code, pas un oubli — il a été relevé deux fois par
`/spec-verify` avant d'être tranché.

`calc.universe.resolve_ticker_cik_as_of` (T70) avait été ajoutée pour
combler ce point ; elle était correcte et testée, mais n'était appelée
nulle part. La câbler aurait supposé de revenir sur le contournement
introduit en T63, où `shares_pit` porte déjà les colonnes `ticker` et
`cik` pour éviter d'avoir à résoudre l'un à partir de l'autre —
c'est-à-dire de redéfinir comment `calc.universe` circule entre ces deux
identités, un chantier plus large que celui que T70 s'était fixé. La
fonction et son test ont été retirés (T74) plutôt que laissés comme du
code non appelé se faisant passer pour un acquis.

La décision de rouvrir ce chantier est reportée à la première ingestion
réelle contre EDGAR, qui donnera la fréquence effective des changements de
ticker dans l'univers suivi et permettra de juger si le garde-fou est
nécessaire dans les faits, ou si le risque documenté par plan.md est plus
théorique que réel à l'échelle où la tranche opère.

## Dette assumée (documentée dans plan.md, acceptée en l'état)

- **Taux d'imposition à 21 % par défaut** en l'absence de résultat avant
  impôt positif ou de donnée fiscale exploitable. Le taux utilisé est
  divulgué dans la trace du ROIC depuis T69 ; le paramètre lui-même reste
  une valeur par défaut codée en dur (`nopat.py`), pas une valeur lue
  depuis un mécanisme de configuration déclaré.
- **`calc.shares_bridge` ne retient que la classe du ticker principal**
  pour les émetteurs à plusieurs classes d'actions, pas la somme des
  classes — sous-estime la capitalisation par construction.
- **Trésorerie hors placements à court terme** — sous-estime la trésorerie
  réelle des émetteurs riches en titres négociables.
- **Une dizaine de bridges de repli pour six indicateurs** — surface
  d'erreur de correspondance de tags plus large qu'un calcul à source
  unique ; chaque bridge est testé isolément et trace le tag utilisé.
- **Ford reste non calculable pour la dette malgré T76.** Son bilan réel
  tague la dette sous `us-gaap:DebtAndCapitalLeaseObligations`, ajoutée en
  repli de dernier recours dans `debt_bridge` (T76, vérifié par test). Mais
  la donnée `companyfacts` de Ford pour ce concept s'arrête réellement en
  2020 dans l'API SEC, alors que le dépôt le plus récent l'utilise bien
  (vérifié en inspectant le fichier de rendu de la SEC elle-même,
  `R5.htm`) : ce n'est pas un défaut du code, la donnée récente n'est
  simplement pas exposée par cette API pour cet émetteur — hypothèse non
  confirmée d'une qualification dimensionnelle par segment
  (Ford Credit / reste du groupe) que la vue plate de `companyfacts`
  n'expose pas. D'autres émetteurs à filiale de financement captive
  (constructeurs automobiles, équipementiers) pourraient présenter la même
  lacune.

## Méthodologie de test par profils réels (clôturée)

Huit caractéristiques distinctives ont été testées manuellement contre le
vrai réseau via `pipeline.ingest.run_from_network` (T75), chacune choisie
pour exercer une hypothèse différente sur la disponibilité ou la forme
réelle des données :

1. **Bilan complet** (Caterpillar) — cas de base, tous les tags primaires
   présents. Recoupé chiffre par chiffre contre le 10-K/DEF-14A réel.
2. **Exclusion SIC finance** (JPMorgan Chase) — a révélé le bug
   `entity_type` (T34).
3. **Fonds réglementé, SIC vide** (Prospect Capital) — a révélé le
   traitement du SIC absent comme signal d'exclusion (T34).
4. **Émetteur IFRS pur** (BP) — exclusion par taxonomie, sans bug trouvé.
5. **Exercice fiscal non calendaire** (Apple) — sans bug trouvé.
6. **Double classe d'actions** (Alphabet) — a confirmé la sous-estimation
   documentée de `calc.shares_bridge` (ci-dessus), sans bug nouveau.
7. **Tag de dette hors chaîne de repli connue** (Ford) — a mené à T76 ;
   Ford reste non calculable pour une raison distincte, documentée
   ci-dessus.
8. **Vrai retraitement 10-K/A** (Advanced Drainage Systems / WMS) —
   confirme, pour la première fois sur une donnée réelle et non une
   fixture synthétique, que le point-in-time (invariant 2) fonctionne :
   `OperatingIncomeLoss` pour l'exercice clos au 2016-03-31 est passé de
   84 593 000 $ (10-K du 2016-09-15) à 94 334 000 $ (10-K/A du
   2017-01-10, +11,5 %) ; `ev_ebit` calculé par `run_from_network` bascule
   exactement à la date attendue, vérifié par `verify_ingest.py`. En
   cherchant ce cas, un candidat réel écarté (Electronics For Imaging,
   délisté depuis 2019) a révélé que `run_from_network` ne peut
   sélectionner aucun émetteur absent de `company_tickers.json`, même par
   CIK direct — limite distincte du ticker/CIK périmé déjà documenté plus
   haut (celui-ci porte sur une absence totale, pas une correspondance
   obsolète).

Quatre bugs réels trouvés et corrigés au total sur ces huit profils (listés
plus haut, section « Ce que la tranche n'a jamais exercé »).

**Caractéristiques distinctives connues mais non testées** — des cas
identifiés pendant cette méthodologie, jamais exercés faute de candidat
trouvé ou de temps, pas des cas dont l'existence serait ignorée :

- **Dépôt tardif** (`NT 10-K`, prorogation Rule 12b-25) — un émetteur qui
  dépose son 10-K après l'échéance réglementaire normale. Testerait si le
  pipeline gère correctement une fenêtre `filed` inhabituellement longue
  après `end`, jamais recherché.
- **Introduction récente en bourse, sans historique depuis 2011** — un
  émetteur dont le premier dépôt est postérieur à 2011 testerait
  concrètement `calc.percentiles`/`test_own_history_percentile_and_years`
  (critère 19) sur une vraie profondeur d'historique courte, pas seulement
  sur la fixture synthétique d'Alpha-like construite pour T49.
- **Titre délisté en cours de route** — un émetteur présent dans l'univers
  à un `t` donné puis radié (rachat, faillite, retrait volontaire) entre
  deux traitements quotidiens réels. Contrairement au cas d'Electronics
  For Imaging ci-dessus (jamais entré dans aucun run, absent de
  `company_tickers.json` dès le départ), ce cas testerait le critère 21
  (« ses fondamentaux et son historique de screen restent intacts ») sur
  une vraie sortie d'univers survenue en cours d'usage réel, jamais
  seulement sur la fixture synthétique de T60.

## Garde-fous en arbitrage (jamais assignés à une tâche)

- **Seuil de cohérence prix veille/jour dans `calc.ratios`** — le garde-fou
  que plan.md promet contre un fractionnement non reflété à temps par la
  source de prix n'a pas de test dédié ; T47 ne couvre que la séparation
  brut/ajusté, pas un seuil d'anomalie jour sur jour.
- **Conversion explicite en UTC de l'horodatage des dépôts SEC** — aucun
  test ne couvre un cas de bord proche de minuit où une conversion
  manquante ferait basculer une comparaison `filed ≤ t`.

## Ce que la tranche n'a jamais exercé

- **`pipeline.ingest.run_from_network` (T75) n'est toujours exécuté contre
  le vrai réseau que manuellement, jamais par la suite automatisée**
  (invariant 9 : le vrai réseau reste réservé aux tests de contact et à
  l'exécution manuelle). Depuis T75, il a été lancé à la main sur plusieurs
  titres réels aux caractéristiques volontairement variées : Caterpillar
  (bilan complet), JPMorgan Chase (exclusion SIC finance), Prospect Capital
  (fonds réglementé, SIC vide), BP (émetteur IFRS pur), Apple (exercice
  fiscal non calendaire), Alphabet (double classe d'actions), Ford
  (tag de dette hors chaîne de repli connue, T76), Advanced Drainage
  Systems / WMS (vrai retraitement 10-K/A). Quatre bugs réels trouvés et
  corrigés en chemin (`entity_type`, `rank()` sur indicateur non
  calculable, colonne `date` manquante avant l'écriture dans
  `universe_history`, inférence de schéma Polars sur un historique de
  dépôts volumineux). Ça reste un usage manuel, ponctuel, sur un titre à
  la fois — jamais plusieurs titres dans le même run, jamais à l'échelle
  du bassin réel.
- **Le point-in-time (invariant 2) a été vérifié sur un vrai retraitement
  réel, pas seulement sur des fixtures synthétiques.** Advanced Drainage
  Systems (CIK 1604028, ticker WMS) a déposé un 10-K/A le 2017-01-10 qui
  retraite réellement `OperatingIncomeLoss` pour l'exercice clos au
  2016-03-31 : 84 593 000 $ dans le 10-K original (déposé 2016-09-15) vs
  94 334 000 $ dans le 10-K/A (+11,5 %, vérifié en comparant les faits
  XBRL des deux dépôts sur `(concept, start, end)` identiques — 45
  concepts diffèrent réellement, dont le résultat net et le BPA). En
  exécutant `run_from_network` avec le même `end` et deux `t` différents
  (avant et après le 2017-01-10), `ev_ebit` bascule exactement de la
  valeur originale à la valeur retraitée, avec le `filed` attendu dans
  chaque cas — confirmé par `verify_ingest.py`. Point notable en chemin :
  un candidat de retraitement écarté (Electronics For Imaging, CIK
  867374) est un vrai cas réel mais est délisté depuis 2019 et n'apparaît
  plus dans `company_tickers.json` ; `run_from_network` ne peut sélectionner
  aucun émetteur qui en est absent, même par CIK direct, ce qui exclut
  structurellement tout émetteur radié du marché — une limite distincte
  du ticker_cik périmé déjà documenté plus haut (celui-ci porte sur une
  correspondance obsolète, pas sur une absence totale).
- **4 tests de contact existent** (`test_edgar_contact_company_tickers_reachable`,
  `test_eodhd_contact_bulk_endpoint_reachable`,
  `test_eodhd_bulk_prices_honors_requested_date`,
  `test_eodhd_bulk_actions_type_splits_returns_known_split`), marqués
  `contact` et exclus par défaut (invariant 9), exécutés manuellement avec
  succès contre les vrais services. Ça ne couvre qu'un seul CIK/ticker
  (Alpha/AAAA) et une poignée de dates ; aucune volumétrie réaliste.
- **Test à l'échelle du bassin réel fait (T81), mais en fixture synthétique,
  jamais en vrai réseau.** `calc.universe`/`pipeline.daily_run` ont été
  exercés une première fois avec les valeurs par défaut de production
  (`n=900, buffer=100, plausible_range=(700, 1100)`) sur ~1000 titres
  synthétiques : aucun défaut trouvé, hystérésis et percentile sectoriel
  réel (groupe ≥ 10, jusqu'ici seul le repli était testé) corrects.
  `_derive_shares_pit` (un appel Python par titre, non vectorisé) prend
  concrètement ~20 secondes à cette échelle, en mémoire pure — compatible
  avec un usage quotidien, mais confirme le coût jusqu'ici seulement
  théorique. Effet de bord observé en exécutant la suite complète après
  l'ajout de cette fixture, plus lourde : `tests/app/test_app_smoke.py`
  (T77/T80) dépassait occasionnellement le délai fixe de 3 s qu'`AppTest`
  s'accorde par défaut (jamais en isolation) — corrigé par T82 (délai
  explicite de 15 s).
- **Découverte automatique du bassin construite, câblée et confirmée en
  conditions réelles (T83-T88, ADR 0005), y compris à l'échelle cible.**
  `pipeline.ingest.run_from_network` classe un bassin par capitalisation
  approchée (API frames de SEC EDGAR + bulk EODHD, un appel chacun plutôt
  qu'un par candidat) et n'ingère réellement que les candidats retenus
  après coupure. Premier lancement réel à petite échelle
  (`frame_period=CY2025Q4I`, `n=3, buffer=2`, 5 candidats réels classés) :
  **Apple découverte automatiquement comme premier rang par capitalisation
  réelle** (~4,84 T$, cohérent), indicateurs réels calculés une fois `end`
  corrigé sur son vrai exercice non calendaire (2025-12-27, pas une date
  calendaire supposée) — EV/EBIT ≈ 95,9, ROIC ≈ 31,9 %, dette nette/EBITDA
  ≈ 0,80.

  Lancement à l'échelle cible (`n=900, buffer=100`) tenté quatre fois,
  chaque échec diagnostiqué et corrigé avant de retenter — jamais une
  hypothèse non vérifiée : (1) univers à 560 titres, cause identifiée et
  corrigée (T86, jointure `rank_candidates` non dédupliquée par CIK — un
  émetteur à plusieurs classes d'actions consommait plusieurs places à la
  coupure) ; (2-3) deux pannes réseau transitoires différentes ont
  interrompu la boucle de ~2000 appels sans rien persister, corrigées par
  un retry borné (T87) ; (4) univers encore à 673-674, cause identifiée et
  corrigée (T88, un second point de démultiplication par CIK dans
  `pipeline.ingest` lui-même — Freddie Mac et ses séries d'actions
  préférentielles apparaissaient 625 fois dans `sic_codes`). Après ces
  quatre correctifs, un cinquième lancement donne un univers à **618**,
  exactement le chiffre qu'un diagnostic indépendant avait calculé sans le
  défaut — confirmant qu'aucun artefact ne reste. Le solde (618 < 700)
  n'était plus un défaut : l'attrition réelle par exclusion SIC
  (finance/assurance/immobilier, fonds — mesurée à ~38 % des 1000
  candidats retenus par la coupure) dépassait la marge de découverte
  d'alors (`n + buffer = 1000`), confondue avec la marge d'hystérésis de
  l'univers final.

  **T89** sépare ces deux marges (`discovery_buffer`, distinct de
  `buffer`) ; un sixième lancement réel, avec `discovery_buffer=800`
  (~1700 candidats réels ingérés), donne un univers à **800 titres** —
  dans la plage plausible par défaut (700-1100), exactement `n - buffer`
  attendu pour un démarrage à froid. Premier lancement complet et correct
  de bout en bout à l'échelle de production réelle : 25 titres classés
  (plafond du critère 16) sur des émetteurs réels plausibles (Fiserv,
  Western Union, APA Corp, Herbalife, Nabors, Constellium, Lear,
  Ingredion, PulteGroup...), multiples EV/EBIT cohérents (4,6 à 7,0). Le
  chantier de découverte automatique du bassin, ouvert après T81, est
  refermé.

  Deux limites assumées, documentées dans l'ADR : l'API frames ne porte
  aucune date de dépôt, donc un garde-fou de 120 jours entre la fin de
  période et `t` approxime la sécurité point-in-time (jamais une garantie
  absolue par émetteur) ; les données de frames ne servent jamais à un
  chiffre affiché, seulement au classement.
- **Écran rendu depuis T77/T78, mais seulement vérifié à la main sur un
  seul titre.** `src/dashboard/app/main.py` existe désormais (le point
  d'entrée a dû être placé dans le paquet `app/`, pas à côté sous
  `app.py`, à cause d'une collision de noms avec `app.screen_view`/
  `app.detail_view` — CLAUDE.md amendé en conséquence). Vérifié en
  navigateur réel contre la vraie sortie d'`ingest_run.py` (WMS) : l'écran
  de synthèse et la vue détail s'exécutent tous deux sans exception une
  fois `fundamentals_raw.parquet` persisté (T78). Reste non exercé : un
  usage à l'échelle du bassin réel (~900-1100 titres), la navigation entre
  plusieurs titres dans la même session, et tout ce que « l'ergonomie et
  la lisibilité de l'interface » couvrirait (explicitement hors-tests de
  spec.md).
- **DuckDB et `fundamentals_raw.parquet` sont désormais utilisés
  réellement (T77, T78)**, comblant l'écart qui existait entre la stack
  déclarée par CLAUDE.md et le schéma déclaré par plan.md d'une part, et
  le code réel de l'autre. Ce genre d'écart — un module ou un fichier
  déclaré mais jamais relié à un point d'exécution réel — a maintenant été
  vu quatre fois sur cette tranche (T14-T18, T71, T77, T78) : le contrôle
  de couverture de tasks.md ne le détecte que lorsqu'un module de plan.md
  ne trouve aucune tâche, jamais quand une tâche existe mais que sa
  promesse de bout en bout (fichier réellement écrit, fonction réellement
  appelée en production) n'a jamais été vérifiée contre autre chose qu'une
  fixture.
- **`calc.divergence` et `calc.streak` ne sont appelés par aucun code de
  production.** Testés isolément sur des séries construites pour
  l'occasion ; `pipeline.daily_run` ne les invoque jamais, faute d'un
  historique `screen_results` réellement accumulé sur plusieurs jours.
- **`calc.ttm` est désormais appelé en production (T91)**, mais seulement
  pour EV/EBIT (critère 12, décidé additif avec l'utilisateur) — ROIC et
  dette nette/EBITDA gardent leur EBIT point-in-time, `calc.ttm` reste
  inappelé pour eux. Repli explicite sur le point-in-time quand moins de
  quatre trimestres sont connus (raison différente de `divergence`/`streak`
  ci-dessus : `calc.ttm` n'a jamais eu besoin d'un historique `screen_results`
  accumulé, seulement des trimestres déjà présents dans `facts` — la
  raison précédemment donnée dans cette note était fausse pour `calc.ttm`,
  corrigée ici, cf. /spec-verify sixième passage). `calc.normalized_5y`
  reste totalement inappelé : il calcule la médiane d'un concept brut, pas
  celle du ratio EV/EBIT que le critère 12 exige littéralement — une
  refonte, pas un simple câblage, non traitée.
- **Le calcul réel du percentile sectoriel (groupe ≥ 10 titres) n'a jamais
  été exercé.** Seul le repli (groupe < 10, critère 20) est testé, dans
  `calc.percentiles` comme dans le test de bout en bout de
  `pipeline.daily_run` — dont la fixture compte délibérément moins de 10
  titres par division sectorielle.
- **Aucun historique multi-jours réel.** Chaque test de `storage.screen_history`
  et `storage.universe_history` écrit au plus quelques jours construits à
  la main ; aucun test n'accumule un historique sur une période
  comparable à un usage réel.
