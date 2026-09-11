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

## Garde-fous en arbitrage (jamais assignés à une tâche)

- **Seuil de cohérence prix veille/jour dans `calc.ratios`** — le garde-fou
  que plan.md promet contre un fractionnement non reflété à temps par la
  source de prix n'a pas de test dédié ; T47 ne couvre que la séparation
  brut/ajusté, pas un seuil d'anomalie jour sur jour.
- **Conversion explicite en UTC de l'horodatage des dépôts SEC** — aucun
  test ne couvre un cas de bord proche de minuit où une conversion
  manquante ferait basculer une comparaison `filed ≤ t`.

## Ce que la tranche n'a jamais exercé

- **Aucune exécution contre des données réelles.** Les 61 tests de la
  suite tournent sur des fixtures synthétiques de 1 à 13 lignes. Ni EDGAR
  ni EODHD n'ont jamais été interrogés par ce code, y compris en lecture
  seule.
- **Aucun test de contact.** Le marqueur pytest `contact` (invariant 9)
  est déclaré et exclu par défaut, mais aucun test portant ce marqueur
  n'existe : `ingestion.edgar_client` et `ingestion.eodhd_client` n'ont
  jamais été appelés hors d'un transport factice.
- **Aucun test à l'échelle du bassin réel.** `calc.universe` cible un
  univers de l'ordre de 900 à 1100 titres ; toutes les fixtures en
  comptent au plus une dizaine. Le coût de `pipeline.daily_run._derive_shares_pit`
  (un appel Python par titre, non vectorisé) n'a jamais été mesuré à
  cette échelle.
- **Pas d'écran.** `src/dashboard/app.py`, référencé par la commande
  `uv run streamlit run` de CLAUDE.md, n'existe pas. Rien de cette tranche
  n'a jamais été rendu dans un navigateur.
- **`calc.divergence` et `calc.streak` ne sont appelés par aucun code de
  production.** Testés isolément sur des séries construites pour
  l'occasion ; `pipeline.daily_run` ne les invoque jamais, faute d'un
  historique `screen_results` réellement accumulé sur plusieurs jours.
- **`calc.ttm` et `calc.normalized_5y` ne sont appelés par aucun code de
  production** non plus, pour la même raison — testés isolément, jamais
  depuis le pipeline.
- **Le calcul réel du percentile sectoriel (groupe ≥ 10 titres) n'a jamais
  été exercé.** Seul le repli (groupe < 10, critère 20) est testé, dans
  `calc.percentiles` comme dans le test de bout en bout de
  `pipeline.daily_run` — dont la fixture compte délibérément moins de 10
  titres par division sectorielle.
- **Aucun historique multi-jours réel.** Chaque test de `storage.screen_history`
  et `storage.universe_history` écrit au plus quelques jours construits à
  la main ; aucun test n'accumule un historique sur une période
  comparable à un usage réel.
