# Vault Curator — plug-in Obsidian

Organise les dossiers d'un vault Obsidian avec Claude. Chaque dossier géré a un mode :

- **Cours / apprentissage** : les documents bruts d'une séance (slides, feuilles d'exercices, photos du
  tableau et du cahier, notes tapées) deviennent des **fiches de révision** reliées par un **skill tree**.
  Les documents bruts sont ensuite archivés, une fois entièrement transcrits et intégrés.
- **Documents** : un projet, des papiers administratifs, une veille… Les fichiers sont rangés et
  renommés selon un plan discuté avec toi, avec un dashboard (voir plus bas).

Claude ne touche jamais au vault : il propose, tu discutes et valides, le plug-in exécute. Tout est annulable.

## Cours : le pipeline de synthèse

```
 séance (dossier, sélection ou nouveaux fichiers)
   │
   ▼ 1. LECTURE INTÉGRALE                       (mise en cache, jamais refaite)
   │   PDF / slides : toutes les pages, transcrites page par page (formules en LaTeX)
   │   photos : vue d'ensemble + 4 vues zoomées, transcription par le modèle le plus capable,
   │            puis 2e lecture de vérification contre la photo
   │   photos collées dans une note (« Photos CM » = ![[IMG_….jpg]]…) : retrouvées où Obsidian
   │            les range (dossier de pièces jointes compris) et transcrites comme les autres
   │   notes : telles quelles, avec l'emplacement de chaque photo marqué
   │   notebooks : cellules et sorties texte · données : premières lignes · PDF très longs : survolés
   ▼ 2. ANALYSE ET PLAN
   │   ce que chaque document apporte et ce qu'il devient : à intégrer puis archiver, ou à garder
   │   en place (manuel, syllabus, annales, notebook, données — reliés au skill tree),
   │   notions et prérequis (y compris avec les fiches existantes),
   │   problèmes repérés (contradictions, énoncé sans corrigé, passages illisibles),
   │   fiches proposées : une par notion (20-40 min de travail) + une fiche d'exercices corrigés,
   │   leur plan, leurs sources, leur place dans le skill tree, le module du cours
   ▼ 3. DISCUSSION                                 ◄─── autant de tours que tu veux
   │   tu relis et corriges les transcriptions (photo à côté), réponds aux questions,
   │   commentes chaque fiche → « Réviser avec mes retours »
   ▼ 4. RÉDACTION                                  (« Valider et rédiger »)
   │   une fiche à la fois, à partir du contenu intégral de ses sources, selon ton gabarit
   ▼ 5. CONTRÔLE DE COUVERTURE
   │   chaque élément de chaque source (formule, exemple, remarque, exercice…) est-il dans une fiche ?
   │   les manques sont ajoutés à la bonne fiche, puis nouveau contrôle
   ▼ 6. RELECTURE
   │   fiches rendues (LaTeX compris), rapport de couverture ; « Réécrire cette fiche » avec un commentaire
   ▼ 7. APPLICATION                                (« Appliquer », annulable)
       fiches → <séance>/Fiches · sources → <séance>/Sources (+ « Transcriptions ») ·
       skill tree du cours remodelé et complété
```

**Organisation d'un cours** :

```
Machine Learning I/
├── 02 Nearest Neighbors/                  une séance (le nom du dossier est gardé)
│   ├── Fiches/                            SORTIES — ce que tu révises
│   │   ├── 01 - Distances and norms.md       numérotées dans l'ordre d'apprentissage
│   │   ├── 02 - k-NN principle.md
│   │   └── 05 - Worked exercises PC2.md
│   └── Sources/                           ENTRÉES — slides, énoncés, photos, notebook,
│       └── Transcriptions — ….md             + toutes les transcriptions
├── 00 Skill tree — Machine Learning I.canvas   LE skill tree : toutes les fiches de toutes les séances
└── Syllabus.pdf                           référence du cours
```

Un seul skill tree par cours : un groupe par séance, une carte par fiche avec le lien vers la fiche rangée
dans sa séance, des flèches de prérequis y compris d'une séance à l'autre. Synthétiser une séance écrit ses
fiches dans la séance, puis **remodèle** le skill tree du cours : place de la séance dans l'ordre du cours,
prérequis et résumés des fiches et modules existants revus à la lumière du nouveau contenu. Ces changements
sont montrés dans le plan (« Skill tree du cours ») et se discutent comme le reste. Ce qui n'a pas pu être
entièrement intégré reste à la racine de la séance et apparaît dans « À classer » sur le skill tree.

**Langue** : les fiches sont écrites dans la langue du cours (slides, professeur) — en anglais pour un cours
en anglais —, les explications ajoutées et tes remarques pouvant rester en français. Réglable.

**Un cours ou tout le master** : un dossier en mode apprentissage est soit *un cours*, soit *plusieurs
cours* (un sous-dossier par cours, comme « DDDF »). Dans le second cas, chaque cours a son propre skill
tree, sa carte et son index, créés au premier passage ; le dossier du master sert de conteneur. Les
consignes données au niveau du master valent pour tous les cours.

**Lancer une synthèse** : clic droit sur le dossier d'une séance (« Semaine 2 ») → *synthétiser ce
dossier en fiches* ; ou sélectionne des fichiers → *synthétiser ces documents* ; ou « Synthétiser un
dossier… » dans le panneau. Les nouveaux documents déposés dans un cours sont proposés à la synthèse au
lancement d'Obsidian (un lot par dossier). « Synthétiser tout le cours » traite chaque sous-dossier à tour
de rôle.

**Le skill tree du cours** se lit comme un livre : une bande par séance, les séances de haut en bas.
Dans une bande, la carte de la séance à gauche (résumé, transcriptions, slides, notebooks), puis ses fiches
en colonnes de gauche à droite, chaque colonne ne demandant que les précédentes, avec des flèches vers les
fiches qui en dépendent. Les fiches sont numérotées (2.3 = 3ᵉ fiche de la séance 2) ; un prérequis pris dans
une autre séance est écrit sur la carte (« ↖ après Gauss–Markov (1.6) ») plutôt que tiré en longue flèche,
et une seule flèche relie les deux séances. Colore une carte pour suivre ta progression : jaune = en
cours, vert = maîtrisée. Ce que tu déplaces reste en place tant qu'aucune fiche n'est ajoutée ; après un
ajout, l'arbre est remis en ordre (les couleurs et tes propres cartes sont gardées).

**Les fiches** suivent ton gabarit (réglages) : objectif et prérequis, intuition, définitions, résultats et
formules, méthode, exemples du tableau rédigés pas à pas, pièges, à retenir, liens vers les exercices,
sources. Les questions de tes notes trouvent leur réponse quand les sources la donnent ; les
contradictions entre sources sont signalées, les passages incertains gardent leur [?].

**Les sources** : un document ne rejoint `Sources/` que si le contrôle de couverture confirme que tout son
contenu est dans les fiches ; sinon il reste à la racine de la séance, signalé. Le document « Transcriptions »
garde chaque photo ou PDF d'origine avec sa transcription intégrale. Les notebooks gardent leur
arborescence avec leurs données (les chemins relatifs continuent de marcher).

**Reprendre ce qu'ont produit les versions précédentes** : synthétise le dossier concerné. Les notes
fusionnées, les transcriptions séparées et les photos renommées deviennent des sources comme les autres ;
les notes de photos rangées dans un « 99 Archive » local sans avoir été intégrées sont reprises ; une
ancienne transcription « <photo> — transcription.md » sert de brouillon à vérifier contre la photo ; les
dossiers « Semaine N » gérés à part sont rattachés au cours, leur ancien dashboard et index rangés dans
`Sources/Anciens tableaux de bord` ; une fiche écrite par la 0.5 à la racine de la séance rejoint `Fiches/`
quand la nouvelle synthèse la complète.

**Garde-fous** : une note de photos n'est archivée qu'avec toutes ses photos, et une photo seulement si
sa transcription est entièrement dans les fiches ; un document illisible n'est jamais archivé.

## Dossiers en mode documents

1. **Comprendre.** Claude lit le contenu du dossier choisi et se fait une idée de ce qu'il est, de son
   utilité pour toi et de la façon dont tu t'en sers.
2. **Proposer.** Il en déduit un principe d'organisation et un plan : rangement des fichiers, règles pour
   les futurs documents, dashboard en canvas, sort des anciens dashboards.
3. **Discuter.** Tu réponds à ses questions, commentes les opérations une par une, corriges sa
   compréhension, décoches ce que tu refuses… et il révise le plan.
4. **Appliquer.** Quand tu valides pour de bon, le plug-in exécute le plan (et peut l'annuler).
5. **Agréger.** À chaque lancement d'Obsidian, il repère le nouveau matériau et propose de l'intégrer à
   la structure existante, avec les règles et préférences retenues.

### Fonctionnement

```
 dossier choisi ─► scan ─► lecture de chaque document (une fois, mise en cache)
                                     │
                                     ▼
              Claude : compréhension + principe + plan + dashboard + questions
                                     │
                  ┌──────────────────┴──────────────────┐
                  ▼                                     │
     fenêtre du plan : réponses, commentaires,   révision par Claude
     opérations décochées ou modifiées  ──────────────► (version 2, 3…)
                  │
                  ▼  « Valider et appliquer »
     exécution journalisée (liens mis à jour, annulable)
                  │
                  ▼
     dashboard .canvas + index .md + _curator.json (carte, règles, préférences)
                  │
                  ▼  au prochain lancement
     nouveaux documents ─► plan d'agrégation ─► même discussion ─► exécution
```

### Les dossiers gérés

N'importe quel dossier peut être géré : depuis le panneau (icône ✨), la palette (« Organiser un
dossier… ») ou un clic droit dans l'explorateur. En l'ajoutant, tu peux dire en une phrase à quoi il sert ;
c'est facultatif, Claude le déduit sinon du contenu, et ta réponse reste modifiable (« Consignes »).

Les dossiers gérés peuvent s'imbriquer : si `Master/` et `Master/Finance de marché/` sont gérés tous les
deux, le premier traite le second comme un bloc (il peut le déplacer, jamais toucher à son contenu) et son
dashboard renvoie vers celui du cours.

### Le dashboard

Pour chaque dossier, `‹Dossier› — Dashboard.canvas`. Claude choisit sa forme selon la nature du dossier :

- **skill tree** pour un cours (flèches = prérequis) ;
- **feuille de route** pour un projet (flèches = enchaînement des étapes) ;
- **carte thématique** ou **sommaire** pour une veille ou des papiers (sections indépendantes, en grille).

Chaque section liste ses documents par rôle (📄 cours, 📝 notes, 📓 manuscrit, 📑 rapport, 📊 données,
🗂️ administratif, ✉️ correspondance…). Colore une section pour suivre l'avancement : jaune = en cours,
vert = terminé ou maîtrisé ; la couleur est conservée à chaque régénération, comme tes déplacements de
nœuds et tout ce que tu ajoutes à la main.

`‹Dossier› — Index.md` est la version texte du dashboard, avec un **mode d'emploi** du dossier : à quoi il
sert, comment s'en servir, règles de rangement, préférences retenues. Le texte écrit hors des balises
`course-curator` y est conservé. `_curator.json` contient la carte ; c'est elle que relit Claude à chaque
agrégation.

### Photos et notes manuscrites (mode documents)

Dans un cours, les photos passent par le pipeline de synthèse ci-dessus. Dans un dossier en mode documents,
le réglage « Photos et notes manuscrites » s'applique :

- **Transcrire et intégrer dans la fiche correspondante** (par défaut). Les photos de tableau, pages de
  cahier et scans sont transcrits (formules en LaTeX), puis leur contenu est fusionné dans la note de la
  même séance ou du même sujet. Par exemple, le tableau photographié pendant le CM1 va dans les notes du CM1,
  à l'endroit de la notion concernée, sans doublonner ce qui y est déjà ; une page de cahier de PC va dans la
  fiche de la PC, créée si elle n'existe pas. Chaque passage ajouté renvoie à sa photo (lien 📷), et les photos
  restent rangées à leur place.
- **Transcrire dans une note à part**, à côté de la photo (comportement de la version 0.2).
- **Ne pas transcrire.**

La fusion ne fait qu'ajouter : le texte existant de la fiche est conservé. Le plan en montre un aperçu (ajouts
en vert). Si une ligne de la fiche actuelle disparaît, l'opération arrive décochée avec un avertissement. Les
transcriptions séparées créées par la version 0.2 sont intégrées de la même façon, puis archivées, lors de la
prochaine réorganisation du dossier (« Réorganiser »).

### Ce que Claude retient

- les **règles de rangement** du dossier (où va chaque type de document, comment le nommer) ;
- tes **préférences**, tirées de tes réponses et commentaires (« les TD vont avec le module qu'ils
  entraînent », « classer par année »…) ;
- tes **règles maison**, communes à tous les dossiers (réglages : numérotation, profondeur, nommage…).

### Le pont vers Claude

| | Claude Code (par défaut) | API Claude |
|---|---|---|
| Principe | le plug-in pilote le CLI `claude -p` installé sur l'ordinateur, comme [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) | appels directs à l'API avec une clé |
| Facturation | ton abonnement Claude | à l'usage, sur la clé API |
| PDF et photos | Claude les lit lui-même dans le vault avec l'outil `Read`, en lecture seule | envoyés en pièces jointes (photos redimensionnées) |
| Plateformes | ordinateur | ordinateur et mobile |

Avec Claude Code, le processus n'a que l'outil `Read` et ne charge ni tes réglages, ni tes hooks, ni tes
serveurs MCP : il ne peut rien écrire. Modèles par défaut : `claude-opus-5-5` pour comprendre et planifier,
`claude-sonnet-5-5` pour lire les documents.

### Garanties

- **Rien n'est supprimé** : ce qui est jeté part dans `99 Archive/` du dossier.
- **Aucun écrasement** : chaque plan est simulé avant d'être montré ; une opération qui écraserait un
  fichier, sortirait du dossier, entrerait dans un sous-dossier géré à part ou porterait sur un fichier
  absent est signalée et ignorée.
- **Liens préservés** : les déplacements passent par Obsidian, qui met à jour les liens.
- **Annulable** : « Annuler la dernière opération » (20 niveaux) ; un fichier modifié depuis n'est pas écrasé.
- **Renommages suivis** : si tu déplaces ou renommes un dossier géré à la main, le plug-in suit.

## Installation

Le dossier `dist/` contient le plug-in compilé. Sous Windows, dans PowerShell (remplacer `C:\Obsidian` par
le dossier du vault) :

```powershell
$dest = "C:\Obsidian\.obsidian\plugins\course-curator"
$base = "https://raw.githubusercontent.com/mauricevdb/Retail-Investing---Dashboard/claude/inspiring-wright-epqm8b/obsidian-vault-curator/dist"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($f in "main.js", "manifest.json", "styles.css") { Invoke-WebRequest "$base/$f" -OutFile (Join-Path $dest $f) -UseBasicParsing }
```

(L'identifiant du plug-in reste `course-curator` pour que la mise à jour depuis la version 0.1 garde tes
données : les cours déjà organisés sont repris automatiquement comme dossiers gérés.)

Depuis les sources :

```bash
cd obsidian-vault-curator
npm install
npm run dist        # build + copie dans dist/
```

Puis dans Obsidian : Réglages → Plug-ins communautaires → activer **Vault Curator**. Pour le moteur
Claude Code : installe [Claude Code](https://code.claude.com) (`irm https://claude.ai/install.ps1 | iex`
sous Windows) et connecte-toi une fois avec `claude`. « Tester la connexion » vérifie que tout répond.

## Utilisation

1. **Réglages** : « À propos de toi » (une phrase), « Règles maison », « Dossiers ignorés ».
2. **Ajouter un dossier** : clic droit → « Vault Curator : gérer ce dossier », choisis son type (cours ou
   documents). Pour un cours, voir « Lancer une synthèse » plus haut. Pour un dossier de documents : Le plan s'ouvre : compréhension du dossier, questions, dashboard proposé, règles
   de rangement, opérations groupées par type.
   - réponds aux questions dans les champs prévus ;
   - 💬 pour commenter une opération, ✎ pour corriger une destination, décoche ce que tu refuses ;
   - « Autre chose à dire ? » pour corriger sa compréhension ou exprimer une préférence ;
   - **Réviser avec mes retours** → Claude renvoie une version révisée, avec la liste de ce qui a changé ;
   - **Valider et appliquer** quand le plan te convient.
3. **Au quotidien** : dépose tes documents dans un dossier géré, n'importe où, ou dans `📥 Inbox`. Au
   lancement d'Obsidian (ou via « Agréger »), le plug-in propose de les intégrer.

Commandes : ouvrir le panneau · organiser un dossier · synthétiser un dossier de cours en fiches ·
réorganiser un dossier géré · agréger les nouveaux documents · régénérer les dashboards (sans Claude) · réinitialiser la mise en page d'un dashboard · annuler
la dernière opération · tester la connexion.

## Limites

- Les fichiers Office (docx, pptx, xlsx) et HEIC ne sont pas lus : dans un cours, ils restent en place et
  sont signalés comme non intégrés (exporte les slides en PDF).
- Une synthèse coûte du temps : compter 4 à 6 minutes pour une séance d'une dizaine de documents
  (deux lectures par photo, une rédaction par fiche, un contrôle de couverture). Les lectures sont mises en
  cache : une révision du plan ne relit rien.
- Les PDF de plus de 80 pages (réglable) ne sont lus qu'en partie ; c'est signalé dans le plan.
- Chaque révision renvoie à Claude tout le contexte du dossier : sur un très gros dossier, un tour prend
  une à deux minutes.
- Avec le moteur API, la clé est stockée en clair dans `.obsidian/plugins/course-curator/data.json`.

## Développement

```bash
npm run dev        # build en continu
npm test           # tests unitaires (dont le pipeline complet avec un Claude simulé)
npm run dist       # vérification des types + build + copie dans dist/
# Essai réel avec Claude Code sur une copie de vault (toutes les opérations proposées sont acceptées,
# le premier dossier passe par un tour de révision) :
CURATOR_E2E=/chemin/vers/copie CURATOR_SPACES="Administratif,Mémoire" npx vitest run tests/e2e.test.ts
# Synthèse réelle d'une séance (rapport détaillé écrit à côté du vault : synthesis-report.md) :
CURATOR_E2E_SYN=/chemin/vers/copie CURATOR_SPACE="Machine Learning I" CURATOR_LOT="Machine Learning I/Semaine 2" \
  npx vitest run tests/e2e-synthesis.test.ts
```

```
src/
  core/          logique pure, testée : scan des dossiers gérés, plans (simulation, validation),
                 canvas, index, carte du dossier, migration 0.1 → 0.2
  learn/         pipeline de synthèse des cours : lecture intégrale, plan, rédaction, couverture, archive
  llm/           pont Claude Code, API Claude, prompts (compréhension, plan, révision, agrégation)
  engine.ts      orchestration : lecture → plan → révisions → application journalisée → dashboards
  obsidianIO.ts  accès au vault via Obsidian (déplacements avec mise à jour des liens, pdf.js)
  ui/            panneau, fenêtres de plan et de relecture, ajout de dossier, réglages
  main.ts        commandes, menu contextuel, détection au lancement
```
