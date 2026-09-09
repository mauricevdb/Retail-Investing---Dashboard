# Research 0001 — sources, contraintes et décisions

Document factuel. Les faits d'abord, les arbitrages ensuite, chacun avec sa raison.

---

## Faits — SEC EDGAR (fondamentaux)

### Endpoints

- `data.sec.gov/api/xbrl/companyfacts/CIK##########.json` : tous les faits
  structurés jamais déposés par un émetteur, en un seul JSON.
- `data.sec.gov/api/xbrl/companyconcept/CIK##########/{taxonomie}/{tag}.json` :
  une seule série, plus léger quand le tag est connu.
- `data.sec.gov/submissions/CIK##########.json` : historique des dépôts, dates,
  numéros d'accession.
- `www.sec.gov/files/company_tickers.json` : correspondance ticker → CIK. Le CIK
  doit être converti en chaîne et complété à 10 chiffres par des zéros.
- Archives en masse : `companyfacts.zip` et `submissions.zip`.

### Contraintes

- Limite de 10 requêtes par seconde. User-Agent identifiant obligatoire,
  sinon réponse 403.
- Latence de mise à jour : moins d'une seconde pour les dépôts, moins d'une
  minute pour les API XBRL.
- Chaque fait porte sa date de dépôt (`filed`) et son numéro d'accession
  (`accn`), ce qui donne le point-in-time nativement.

### Couverture historique

Le dépôt en XBRL s'est fait par paliers :

| Palier | À partir des exercices clos le |
|---|---|
| Flottant mondial > 5 Md$ | 15 juin 2009 |
| Autres grands déposants accélérés en US GAAP | 15 juin 2010 |
| Tous les autres déposants US GAAP, et émetteurs étrangers en IFRS | 15 juin 2011 |

Avant 2011 la couverture est partielle, avant 2009 elle est nulle.

---

## Faits — EODHD (prix et actions sur titres)

### Offres

| Offre | Prix mensuel | Contenu |
|---|---|---|
| Gratuite | 0 € | 20 appels/jour, EOD et fondamentaux limités |
| EOD All World | 19,99 € | EOD historique longue profondeur, cotations différées |
| EOD + Intraday All World Extended | 29,99 € | ajoute l'intrajournalier et le temps réel |
| Fundamentals Data Feed | 59,99 € | fondamentaux (redondant avec EDGAR pour les États-Unis) |

Réduction étudiante de 50 % sur tous les abonnements, à demander au support.

### Caractéristiques utiles

- Endpoint bulk : télécharge une place entière pour une journée donnée, ce qui
  évite des milliers de requêtes quotidiennes. Fonctionne aussi pour les
  dividendes et les splits.
- Cotations différées disponibles en lot pour les valeurs américaines.
- Prix bruts et prix ajustés fournis séparément dans la réponse.
- Couverture des titres délistés, des changements de ticker, des dividendes
  et des splits.
- Historique intrajournalier (1 min, 5 min, 1 h) accessible sur l'offre à
  29,99 €, indépendamment de tout flux en direct.

---

## Décisions

### D1 — Profondeur d'historique : 2011 à aujourd'hui

Toute la profondeur qu'XBRL contient, ingérée via `companyfacts.zip`.

**Raison** : la borne est réglementaire et non discrétionnaire, la couverture
complète commençant à mi-2011. L'archive en masse rend l'ingestion large
presque aussi bon marché que l'ingestion étroite, et contourne la limite de
débit. La profondeur d'ingestion et la fenêtre d'analyse restent deux
décisions distinctes : tronquer plus tard au calcul est trivial, recharger un
historique non stocké ne l'est pas.

### D2 — Taxonomie : `us-gaap` seulement

Les émetteurs étrangers déposant en `ifrs-full` sont exclus de la tranche 0001.

**Raison** : les inclure n'ajouterait pas des lignes de même forme mais des
branches dans la logique de calcul. Les tags diffèrent et exigeraient une table
de correspondance dont chaque ligne est une hypothèse ; ces émetteurs déposent
un 20-F annuel et non des 10-Q, ce qui ferait bifurquer tout calcul sur douze
mois glissants ; et ils publient souvent dans une autre devise, ouvrant la
possibilité d'un ratio mêlant capitalisation en dollars et comptes en euros.
À reprendre dans une tranche dédiée.

### D3 — Retraitements : stocker les deux versions, afficher la dernière

Stockage bitemporel `(concept, end, filed, accn, value)`. L'écran de
valorisation utilise la dernière valeur connue.

**Raison** : asymétrie. Aujourd'hui les deux valeurs diffèrent rarement et
l'enjeu à l'écran est négligeable ; le jour où il faudra savoir ce qui était
publiquement connu à une date passée, la valeur telle que publiée sera la seule
utilisable et ne pourra pas être reconstruite si elle n'a pas été conservée.
Une option bon marché maintenant et irrécupérable plus tard se prend.

**Conséquence à ne pas manquer** : la même métrique apparaît plusieurs fois
pour un même exercice. Ce ne sont pas des doublons, et toute déduplication
détruit précisément ce que ce stockage cherche à conserver.

### D4 — Univers : environ 900 grandes et moyennes capitalisations américaines, définies par règle

Révisée par l'ADR 0002 : l'univers n'est plus l'appartenance au S&P 500 et au
S&P 400, mais une règle calculée en interne — les *N* premières sociétés
américaines par capitalisation boursière, après exclusion des codes SIC 6000
à 6799 et des fonds/ETF/véhicules assimilés. *N* reste de l'ordre de 900. La
capitalisation se dérive des actions en circulation (EDGAR) et du dernier
cours de clôture (EODHD) — aucune source supplémentaire.

**Raison de la taille de l'univers (inchangée)** : le coût en appels n'est
pas le critère, l'endpoint bulk rendant l'élargissement quasi gratuit. Ce qui
change est la nature de ce que le screen remonte. Sur l'ensemble du marché
américain, un screen value fait surtout remonter des coquilles vides, des
sociétés sans chiffre d'affaires et des titres trop illiquides ; la qualité
des données se dégrade également dans la queue de distribution, et chaque cas
particulier coûte des heures de débogage.

**Raison du passage à une règle plutôt qu'à un indice publié** : la
composition d'un indice comme le S&P 500 dépend en partie du jugement
discrétionnaire d'un comité, injustifiable dans notre propre écran ; une
source de constituants d'indice aurait par ailleurs nécessité une dépendance
externe supplémentaire (voir ADR 0002) pour un usage qui ne sert ici que de
filtre de taille et de liquidité, jamais de réplication d'indice.

**Argument contraire assumé** : les inefficiences de valorisation se logent
plutôt là où la couverture des analystes est faible, donc dans les petites
capitalisations. Il est juste, et justifie un élargissement ultérieur.
Élargir un univers est un changement de paramètre ; réparer un pipeline jamais
validé n'en est pas un.

**Note** : notre univers n'existe nulle part ailleurs sous cette forme — à la
différence des constituants d'un indice publié, il ne peut pas être
reconstitué après coup s'il n'est pas conservé. La table d'appartenance
quotidienne (spec, R8) en est donc la seule trace, y compris pour un usage
futur d'évaluation rétrospective d'une stratégie.

### D5 — Fraîcheur : traitement quotidien, cotations différées, aucun temps réel

Balayage quotidien de l'index EDGAR pour les CIK de l'univers. Prix de
screening après la clôture. Cotations différées pour le suivi de portefeuille.

**Raison** : la latence effective est dominée par l'exécution manuelle, qui se
compte en minutes ou en heures. Une latence de quinze minutes se compare à la
vitesse de décroissance du signal, non à son étiquette : sur un horizon de
détention de plusieurs jours, elle est négligeable. En deçà de ce seuil, la
concurrence ne porte plus sur la lecture des marchés mais sur l'infrastructure,
face à des acteurs colocalisés ; une stratégie dont l'avantage disparaît avec
un quart d'heure de retard est une stratégie dont l'avantage appartient à un
autre. Le vrai temps réel aura sa propre tranche le jour où des ordres seront
exécutés.

**Où porter l'effort à la place** : les signaux de retournement sont
extrêmement sensibles à la propreté des données. Un split non ajusté crée un
écart de 50 % par rapport à la moyenne et se présentera comme la meilleure
opportunité de la journée. C'est là que se perdent ces stratégies, jamais dans
la latence.

---

## Exclusions à reporter dans la spec

À écrire comme exclusions assumées, et non comme oublis, afin de pouvoir les
lever proprement plus tard : le temps réel, la taxonomie IFRS, les petites
capitalisations, l'exécution d'ordres.

## Non résolu

- Aucune source gratuite identifiée pour les fondamentaux point-in-time des
  émetteurs européens.
- La forward guidance n'est pas structurée dans XBRL : elle vit dans le texte
  des dépôts et des communiqués. Sujet d'une tranche ultérieure.
- Historique intrajournalier : disponible sur l'offre à 29,99 €, non souscrite
  à ce stade. À rouvrir si une tranche mean reversion le justifie.
