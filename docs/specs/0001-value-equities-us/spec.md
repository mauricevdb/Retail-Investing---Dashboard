# Spec 0001 — Repérage de sous-valorisation sur actions américaines

## Intention

L'utilisateur veut repérer, parmi les grandes et moyennes capitalisations
américaines, les titres que le marché semble sous-évaluer au regard de ce
que leurs dépôts financiers indiquent. Il doit pouvoir porter ce jugement
avec les seules informations qui étaient réellement publiques à la date
d'observation, sans que des retraitements ultérieurs ou des données pas
encore déposées ne faussent son analyse a posteriori. Sans cet écran, il
doit reconstituer manuellement, titre par titre, des chiffres dispersés
dans des centaines de dépôts réglementaires, ce qui rend impraticable le
suivi régulier d'un univers de cette taille.

## Périmètre

### Inclus

- Un univers d'environ 900 grandes et moyennes capitalisations américaines,
  défini par une règle que nous écrivons nous-mêmes — les *N* premières
  sociétés par capitalisation boursière — plutôt que par l'appartenance à un
  indice publié (ADR 0002). L'univers exclut la finance, l'assurance et
  l'immobilier, ainsi que les fonds, ETF et véhicules assimilés ; il ne
  retient que des sociétés opérationnelles déposant en `us-gaap`. Sa
  composition reste stable au voisinage du rang de coupure : elle ne varie
  pas au simple bruit quotidien des cours.
- Six indicateurs, ni plus ni moins, affichés en première lecture pour
  chaque titre de l'univers filtré :
  1. EV/EBIT — multiple de valorisation opérationnelle, indicateur primaire.
  2. Rendement du free cash flow sur valeur d'entreprise.
  3. ROIC — dimension qualité, pour ne pas ne remonter que des sociétés bon
     marché à juste titre.
  4. Dette nette / EBITDA — dimension solvabilité.
  5. Percentile du multiple primaire face à sa propre histoire depuis 2011.
  6. Percentile du multiple primaire au sein de son groupe sectoriel.
  Le niveau absolu du multiple primaire est affiché à côté des deux
  percentiles. Les données brutes qui alimentent ces indicateurs (chiffre
  d'affaires, résultat, dette, flux de trésorerie) restent accessibles en
  second niveau, jamais en première lecture.
- Un filtrage à seuils suivi d'un classement des titres retenus, plafonné à
  25 titres affichés. Le nombre de titres ayant passé les filtres est
  affiché en permanence, y compris lorsqu'il vaut zéro.
- Un enregistrement quotidien du résultat du screen (une ligne par titre
  par jour : ratios, rang, résultat des filtres), qui rend visible depuis
  combien de temps un titre est repéré comme bon marché.
- Un enregistrement quotidien de la composition de l'univers de screening
  (une ligne par titre par jour), jamais élagué, distinct du screen
  lui-même.
- Un écran consultable quotidiennement, après la clôture du marché
  américain, présentant l'état du jour pour l'ensemble de l'univers filtré.
- La possibilité de retrouver, pour tout nombre affiché, le champ source et
  sa date de dépôt.
- Une mention explicite, visible sur l'écran, que l'univers est défini par
  nous et non par un indice publié : aucune statistique produite n'est
  présentée comme une mesure du S&P 500 ou du S&P 400.

### Explicitement exclu

- Temps réel et flux en direct : l'écran travaille sur cotations différées
  et sur un traitement quotidien (décision D5).
- Émetteurs déposant en IFRS et émetteurs étrangers : la taxonomie retenue
  est `us-gaap` seule (décision D2).
- Petites capitalisations hors de l'univers défini par règle, environ 900
  sociétés (décision D4, ADR 0002).
- L'appartenance à un indice publié (S&P 500, S&P 400 ou autre) comme
  source de définition de l'univers : remplacée par une règle interne de
  capitalisation, pour ne pas dépendre d'un jugement discrétionnaire de
  comité ni d'une source externe supplémentaire (ADR 0002).
- Finance, assurance et immobilier (codes SIC 6000 à 6799) : ces secteurs
  exigent des ratios propres, dont certains non fiablement calculables
  depuis EDGAR ; ce serait une branche de calcul, pas une extension de
  périmètre.
- Commentaires qualitatifs issus de news ou de sources alternatives :
  l'écran reste fondé sur les dépôts réglementaires structurés.
- Annotations utilisateur en texte libre sur les titres suivis.
- L'analyse des flux sectoriels et leur interprétation causale : seuls des
  percentiles descriptifs sont produits.
- L'exécution d'ordres et toute connexion à un courtier.
- Toute recommandation d'achat ou de vente, ou notation du type
  « acheter / vendre » : l'écran affiche des mesures, pas un avis.
- L'évaluation rétrospective de cette stratégie de repérage, sous toutes
  ses formes : elle utiliserait l'univers historique et ses propres
  garde-fous, et ferait l'objet d'une spec dédiée. Le fait que l'univers
  historique de composition soit constitué dès cette tranche ne préjuge pas
  de son exploitation.
- La rubrique « momentum / accumulation institutionnelle » évoquée dans la
  vision : non spécifiable tant que ses critères ne sont pas falsifiables.
- Tout marché autre que les actions américaines (devises, matières
  premières, crypto, actions non américaines).

## Utilisateur et usage

Le propriétaire du dépôt est le seul utilisateur. Il consulte l'écran
typiquement une fois par jour, après la clôture du marché américain, pour
deux usages : repérer de nouveaux titres candidats à une recherche plus
approfondie, et vérifier si des titres déjà repérés restent dans une zone
de sous-valorisation apparente. Il ne prend aucune décision d'achat
directement depuis l'écran ; celui-ci alimente une réflexion, pas une
exécution.

## Données requises

- **Identité et appartenance à l'univers** — ticker courant, identifiant
  SEC (CIK), statut d'appartenance à l'univers défini par règle (dans les
  *N* premières capitalisations, hors exclusions). Granularité : un état
  par titre, à jour quotidiennement.
- **Nature de l'émetteur** — de quoi distinguer une société opérationnelle
  d'un fonds, d'un ETF ou d'un véhicule assimilé, dérivé des dépôts
  eux-mêmes plutôt que d'une liste tierce. Nécessaire pour exclure ces
  véhicules de l'univers.
- **Capitalisation boursière** — dérivée des actions en circulation et du
  dernier cours de clôture, utilisée pour classer les titres et définir
  l'univers. Même exigence de point-in-time que les autres fondamentaux.
- **Classification sectorielle** — code SIC de l'émetteur, source :
  endpoint des dépôts (submissions) d'EDGAR. Sert à la fois à exclure la
  finance, l'assurance et l'immobilier, et à regrouper les titres restants
  en une dizaine de catégories grossières pour la comparaison sectorielle.
- **Fondamentaux** — postes du compte de résultat, du bilan et des flux de
  trésorerie nécessaires pour calculer les six indicateurs, chacun
  accompagné de sa date de fin d'exercice, de sa date de dépôt et de son
  numéro de dépôt. Profondeur : depuis 2011, limite de la couverture XBRL
  exhaustive. Fraîcheur exigée : disponible dès le jour ouvré suivant son
  dépôt auprès du régulateur.
- **Prix** — cours de clôture quotidien, en version brute et en version
  ajustée des opérations sur titres, tenues séparées. Profondeur : depuis
  2011, bornée par la profondeur des fondamentaux, pour permettre le calcul
  du percentile historique du multiple primaire. Fraîcheur exigée :
  différée, disponible après la clôture du jour même.
- **Opérations sur titres** — fractionnements et dividendes, nécessaires
  pour produire des prix ajustés fiables et éviter qu'un fractionnement non
  reflété ne se présente comme une opportunité de valorisation. Granularité :
  un événement par titre et par date d'effet.
- **Actions en circulation** — nécessaires pour rapporter les fondamentaux
  à la valeur de marché de l'entreprise. Même exigence de point-in-time que
  les autres fondamentaux : la valeur utilisée est celle connue à la date
  d'observation.
- **Historique du screen** — un enregistrement quotidien par titre :
  valeur de chaque indicateur, rang, résultat des filtres. Jamais réécrit
  ni supprimé.
- **Historique d'appartenance à l'univers** — un enregistrement quotidien
  par titre indiquant s'il fait partie de l'univers défini par règle ce
  jour-là. Cette composition n'existe nulle part ailleurs : contrairement à
  un indice publié, elle ne peut pas être reconstituée après coup si elle
  n'est pas conservée. Jamais élagué.
- **Devise** — dollar américain pour l'ensemble des champs de cette
  tranche, portée explicitement par chaque donnée plutôt que supposée.

## Critères d'acceptation

1. Étant donné une date d'observation `t` et un concept fondamental ayant
   plusieurs dépôts, quand l'écran calcule un indicateur pour `t`, alors
   seules les valeurs dont la date de dépôt est antérieure ou égale à `t`
   sont utilisées.
2. Étant donné un titre qui ne fait plus partie de l'univers défini par
   règle, quand l'écran de screening est régénéré, alors ce titre n'apparaît
   pas dans le résultat du jour.
3. Étant donné un exercice pour lequel un émetteur a déposé un retraitement
   après le dépôt initial, quand l'écran affiche la valeur d'un concept
   pour cet exercice à la date d'observation `t`, alors il affiche la
   dernière valeur dont la date de dépôt est antérieure ou égale à `t`, et
   les valeurs antérieures restent individuellement retrouvables.
4. Étant donné un titre ayant subi un fractionnement, quand l'écran
   calcule une variation ou une moyenne de prix sur une période qui
   chevauche l'événement, alors seule la série de prix ajustés est
   utilisée, jamais un mélange avec la série de prix bruts.
5. Étant donné un émetteur déposant en taxonomie `ifrs-full`, quand
   l'univers du jour est constitué, alors cet émetteur en est absent.
6. Étant donné un titre pour lequel une donnée fondamentale requise par le
   calcul est absente à la date d'observation, quand l'écran est généré,
   alors ce titre est signalé comme incomplet, jamais masqué silencieusement
   ni complété par une valeur par défaut.
7. Étant donné un jour de bourse américain, quand le traitement quotidien
   s'exécute après la clôture, alors l'écran reflète les cours de clôture
   de ce jour et les dépôts SEC connus jusqu'à cette date.
8. Étant donné un jour non ouvré pour le marché américain, quand
   l'utilisateur consulte l'écran, alors la date de référence affichée est
   celle de la dernière séance de bourse effective, jamais la date du jour
   calendaire.
9. Étant donné un nombre quelconque affiché à l'écran, quand l'utilisateur
   veut en vérifier l'origine, alors il peut remonter jusqu'au champ
   source, à sa date de fin d'exercice, à sa date de dépôt et à son numéro
   de dépôt — ou, pour un prix, jusqu'à sa date de cotation.
10. Étant donné deux titres quelconques de l'univers, quand ils sont
    comparés à l'écran, alors leurs valeurs fondamentales et leurs prix
    sont exprimés dans la même devise, sans conversion implicite.
11. Étant donné un indicateur dont une composante fondamentale n'est pas
    calculable pour un titre à la date d'observation, quand l'écran est
    généré, alors ce titre est signalé comme « non calculable » pour cet
    indicateur, et le pipeline rapporte un taux de couverture par
    indicateur (nombre de titres pour lesquels il est calculable, sur le
    nombre total de titres de l'univers).
12. Étant donné les fondamentaux d'un titre disponibles à une date
    d'observation, quand l'écran calcule un indicateur en primaire, alors
    il utilise la somme des quatre derniers trimestres connus (TTM), et
    affiche séparément la médiane du même indicateur sur les cinq dernières
    années.
13. Étant donné un titre dont l'indicateur TTM et l'indicateur normalisé
    sur cinq ans s'écartent au-delà du seuil défini en configuration, quand
    l'écran est généré, alors ce titre est signalé explicitement comme
    divergent.
14. Étant donné un émetteur dont le code SIC est compris entre 6000 et
    6799, quand l'univers du jour est constitué, alors cet émetteur en est
    exclu.
15. Étant donné l'univers du jour après application des filtres, quand
    l'écran est généré, alors il affiche le nombre de titres ayant passé
    les filtres, y compris lorsque ce nombre est zéro.
16. Étant donné un ensemble de titres filtrés, quand l'écran les classe,
    alors il n'en affiche jamais plus de vingt-cinq.
17. Étant donné une date de traitement quotidien, quand le screen est
    calculé, alors une ligne est enregistrée pour chaque titre de l'univers
    du jour, portant au minimum la date, le ticker, la valeur de chaque
    indicateur, le rang et le résultat des filtres ; ces lignes ne sont
    jamais réécrites ni supprimées.
18. Étant donné un titre présent dans l'historique du screen sur plusieurs
    jours consécutifs en ayant passé les filtres, quand l'utilisateur
    consulte l'écran, alors il peut voir depuis combien de jours ce titre
    les passe sans interruption.
19. Étant donné le multiple primaire actuel d'un titre, quand l'écran
    calcule son percentile face à sa propre histoire, alors ce calcul porte
    sur les données disponibles depuis 2011 pour ce titre, et le nombre
    d'années réellement disponibles est affiché à côté du percentile.
20. Étant donné un groupe sectoriel grossier comptant moins de dix titres,
    quand l'écran calcule le percentile sectoriel d'un titre de ce groupe,
    alors ce percentile n'est pas calculé, le niveau absolu du multiple est
    utilisé à la place, et l'écran signale que le percentile sectoriel est
    indisponible pour ce titre.
21. Étant donné un titre sorti de l'univers défini par règle, quand l'écran
    de screening est régénéré, alors ce titre en est absent, mais ses
    fondamentaux et son historique de screen restent intacts et
    consultables dans l'univers historique.
22. Étant donné un jour de traitement, quand la table d'appartenance à
    l'univers est mise à jour, alors une ligne est ajoutée pour ce jour
    recensant les membres de l'univers défini par règle, sans jamais
    modifier ni supprimer les lignes des jours précédents.
23. Étant donné un émetteur identifié comme fonds, ETF ou véhicule
    assimilé, quand l'univers du jour est constitué, alors cet émetteur en
    est exclu.
24. Étant donné deux calculs consécutifs de l'univers dont le classement par
    capitalisation place des titres à proximité du rang de coupure, quand
    l'univers est régénéré, alors sa composition ne varie pas au simple
    bruit quotidien des cours, selon le mécanisme de stabilité défini dans
    le plan.
25. Étant donné le calcul quotidien de l'univers, quand il échoue ou
    renvoie un nombre de titres hors d'une plage plausible définie en
    configuration, alors le traitement s'arrête et l'écran ne s'affiche pas
    pour ce jour, plutôt que d'afficher un résultat partiel sans le
    signaler.
26. Étant donné l'écran ou toute statistique qu'il produit, quand ils sont
    présentés à l'utilisateur, alors ils ne sont jamais désignés comme une
    mesure du S&P 500 ou du S&P 400.

## Critères liés aux invariants

1. **Aucun look-ahead** — couvert par le critère d'acceptation 1.
2. **Point-in-time** — le stockage doit permettre de répondre, pour tout
   concept et toute date `t`, à la question « quelle était la dernière
   valeur connue à `t` » sans que les valeurs antérieures ne soient
   écrasées ; couvert par le critère d'acceptation 3.
3. **Deux univers distincts** — l'écran de screening n'affiche jamais un
   titre sorti de l'univers du jour (critère 2), mais ses données et
   l'historique de composition de l'univers sont conservés indéfiniment
   dans l'univers historique (critères 21 et 22). Cet historique est
   d'autant plus critique que l'univers est désormais défini par nous
   (ADR 0002) : il n'existe, contrairement à un indice publié, dans aucune
   autre source.
4. **Actions sur titres** — prix bruts et prix ajustés ne sont jamais
   mélangés dans un même calcul ; couvert par le critère d'acceptation 4.
5. **Temps** — étant donné un instant quelconque, quand une donnée est
   horodatée, alors l'horodatage est en UTC ; couvert pour les jours de
   marché par le critère d'acceptation 8.
6. **Devise** — couvert par le critère d'acceptation 10.
7. **Pas de repli silencieux** — couvert par les critères d'acceptation 6
   et 11 (une donnée ou un indicateur non calculable est signalé comme tel,
   jamais masqué ni remplacé par une valeur inventée) et par le critère 25
   (un calcul d'univers en échec arrête le traitement au lieu d'afficher un
   résultat partiel silencieux).
8. **Traçabilité** — couvert par le critère d'acceptation 9.
9. **Tests hors réseau** — chacun des critères ci-dessus doit rester
   vérifiable sur des instantanés figés, sans appel à SEC EDGAR ni à EODHD
   pendant l'exécution des tests.
10. **Secrets** — étant donné une clé d'API de fournisseur de données,
    quand l'écran, ses journaux ou ses messages d'erreur sont produits,
    alors cette clé n'y apparaît jamais.

## Hors-tests

- La pertinence économique du signal de sous-valorisation — qu'un titre
  signalé soit réellement une opportunité reste un jugement humain, non
  automatisable.
- L'ergonomie et la lisibilité de l'interface.
- Le temps de calcul du traitement quotidien, tant qu'il reste compatible
  avec une consultation une fois par jour.
- La disponibilité réelle de SEC EDGAR et d'EODHD : les tests tournent sur
  des instantanés figés, jamais contre les services en direct.
- Le choix numérique des seuils de filtrage initiaux et du seuil de
  divergence TTM / normalisé : proposés et justifiés dans le plan comme
  paramètres de configuration, leur pertinence économique n'est pas
  vérifiable par un test automatique.
- La composition exacte des catégories sectorielles grossières
  (regroupement de codes SIC) : choix de plan documenté, vérifiable comme
  cohérent, pas comme « correct » dans l'absolu.
- La valeur exacte de *N*, la fréquence de recalcul de l'univers et le
  mécanisme précis assurant la stabilité de sa composition au rang de
  coupure : décidés et justifiés dans le plan (ADR 0002), pas dans cette
  spec.

## Questions ouvertes

Aucune à ce stade. Les huit questions soulevées à la relecture précédente
ont été tranchées et appliquées dans les sections ci-dessus ; l'invariant 3
de CLAUDE.md a été corrigé en conséquence.
