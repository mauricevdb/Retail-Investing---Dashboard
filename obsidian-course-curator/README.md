# Course Curator — plug-in Obsidian

Range un vault de cours avec Claude. Le plug-in est pensé pour un master Data & Finance : un dossier par
cours, avec des PDF de cours et de TD, des notes en Markdown, des photos du tableau ou du cahier, des annales.

- **Premier passage** : il lit tout le vault, repère ce qui est déjà rangé et ce qui ne l'est pas, construit
  pour chaque cours un **skill tree en canvas** qui sert de dashboard, tranche sur les dashboards déjà
  présents (garder, reprendre, archiver) et propose un rangement du dossier.
- **Ensuite** : quand de nouveaux documents arrivent dans un cours (ou dans la boîte de réception
  `📥 Inbox`), il les lit, propose un plan d'agrégation, et l'exécute une fois le plan validé.

Rien ne bouge sans validation. Claude ne touche jamais au vault : il propose un plan en JSON, le plug-in
le vérifie, vous le validez opération par opération, puis le plug-in l'exécute. Tout est annulable.

## Fonctionnement

```
               ┌────────────── Claude (via Claude Code ou l'API) ──────────────┐
               │ 1. lecture : identifie chaque fichier (type, titre, notions,   │
               │    séance) et transcrit les photos                             │
               │ 2. structure : modules, prérequis, rangement, arbitrage des    │
               │    anciens dashboards → plan JSON                              │
               └──────────────▲──────────────────────────────┬─────────────────┘
                              │ lecture seule                 │ plan
 vault ──► scan ──► texte des PDF/notes extrait localement     ▼
                    (pdf.js), photos et scans envoyés     vérification (simulation du
                    à Claude                              vault, aucun écrasement)
                                                              ▼
                                                     fenêtre de validation
                                                     (cocher, décocher, modifier)
                                                              ▼
                     skill tree .canvas + index .md ◄── exécution journalisée
                     + _curator.json (carte du cours)    (liens mis à jour, annulable)
```

### Le pont vers Claude

Deux moteurs, au choix dans les réglages :

| | Claude Code (par défaut) | API Claude |
|---|---|---|
| Principe | le plug-in pilote le CLI `claude -p` installé sur l'ordinateur, comme [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) | appels directs à l'API avec une clé |
| Facturation | votre abonnement Claude (ou l'authentification configurée dans Claude Code) | à l'usage, sur la clé API |
| PDF et photos | Claude les lit lui-même dans le vault avec l'outil `Read`, en lecture seule | envoyés en pièces jointes (photos redimensionnées) |
| Plateformes | ordinateur (macOS, Windows, Linux) | ordinateur et mobile |

Avec Claude Code, le processus est lancé avec uniquement l'outil `Read`, sans les réglages, hooks ni
serveurs MCP de votre configuration, et sans session persistante : il ne peut rien écrire.

Par défaut, la structuration utilise `claude-opus-5-5` et la lecture des documents `claude-sonnet-5-5`
(plus rapide pour du volume). Les deux se changent dans les réglages.

### Le skill tree

Pour chaque cours, `‹Cours› — Skill tree.canvas` :

- une carte titre (résumé du cours, lien vers l'index et vers les dashboards conservés) ;
- un groupe par module avec ses notions clés et les liens vers ses documents, classés par rôle
  (📄 cours, 📝 notes, 📷 tableau, 📓 cahier, ✏️ exercices, ✅ corrigés, 🎯 annales…) ; les sous-chapitres
  sont empilés dans le groupe ;
- des flèches de prérequis : les modules sont disposés par niveau, un module n'apparaît qu'en dessous de
  ceux qu'il faut maîtriser avant lui ;
- un encart « Ressources transverses » (syllabus, annales, formulaires) et un encart « À classer ».

**Progression** : colorez un module dans le canvas, jaune = en cours, vert = maîtrisé. La couleur est
relue et conservée à chaque régénération, et reportée dans l'index.

**Vos modifications sont conservées** : nœuds déplacés ou redimensionnés, nœuds et flèches ajoutés à la
main. La commande « Réinitialiser la mise en page » redessine la disposition sans perdre les couleurs.

`‹Cours› — Index.md` est la version texte du même dashboard (pratique sur mobile, dans la recherche et les
backlinks). Le texte écrit en dehors des balises `course-curator` y est conservé.

`_curator.json` contient la carte du cours. Obsidian ne l'affiche pas dans l'explorateur ; c'est la source
à partir de laquelle le canvas et l'index sont régénérés.

### Rangement

La convention par défaut (modifiable dans les réglages) :

```
‹Cours›/
├── ‹Cours› — Skill tree.canvas
├── ‹Cours› — Index.md
├── 00 Admin/        syllabus, planning, modalités d'évaluation
├── 01 ‹Module›/     un dossier par module, numéroté dans l'ordre du cours
│   ├── Cours/  Exercices/  Notes/  Images/    (seulement à partir de 3 fichiers)
├── 90 Examens/      annales, partiels, corrigés
├── 95 Ressources/   formulaires, lectures
└── 99 Archive/      anciens dashboards, doublons
```

Trois niveaux d'intervention : **conservateur** (seulement le vrac et les erreurs manifestes),
**équilibré** (par défaut : garde les dossiers qui fonctionnent, aligne le reste) et **complet**.
Les fichiers au nom opaque (`IMG_2034.jpg`, `scan0001.pdf`) peuvent être renommés
(`S03 - Tableau - Black-Scholes.jpg`), et les photos de tableau ou de cahier transcrites dans une note
Markdown placée à côté (formules en LaTeX), deux options activées par défaut.

### Garanties

- **Rien n'est supprimé** : ce qui est jeté part dans `99 Archive/` du cours.
- **Aucun écrasement** : le plan est simulé avant d'être montré ; une opération qui écraserait un fichier,
  sortirait du cours ou porterait sur un fichier absent est signalée et ignorée.
- **Liens préservés** : les déplacements passent par Obsidian, qui met à jour les liens vers les fichiers
  déplacés.
- **Annulable** : chaque application est journalisée (« Annuler la dernière opération », 20 niveaux). Un
  fichier modifié depuis n'est pas écrasé par l'annulation.
- **Lectures en cache** : un document n'est relu par Claude que s'il a changé.

## Installation

```bash
cd obsidian-course-curator
npm install
npm run build
mkdir -p "<vault>/.obsidian/plugins/course-curator"
cp main.js manifest.json styles.css "<vault>/.obsidian/plugins/course-curator/"
```

Puis dans Obsidian : Réglages → Plug-ins communautaires → activer **Course Curator**.

Pour le moteur Claude Code : installez [Claude Code](https://code.claude.com) et connectez-vous une fois en
lançant `claude` dans un terminal. Le plug-in trouve l'exécutable tout seul (PATH du shell de connexion,
`~/.local/bin`, Homebrew…) ; sinon, indiquez son chemin dans les réglages. Sous Windows, préférez
l'installateur natif (`claude.exe`). « Tester la connexion » vérifie que tout répond.

## Utilisation

1. **Réglages** : « Dossier des cours » (vide si les cours sont à la racine du vault) et « Dossiers ignorés »
   (Templates, pièces jointes…).
2. **Premier rangement** : icône 🎓 → « Organiser N cours non organisés ». Pour chaque cours, le plug-in
   lit les documents, puis ouvre le plan : skill tree proposé, décision sur chaque ancien dashboard,
   opérations groupées par type. Décochez ce que vous refusez, corrigez une destination avec ✎, puis
   « Appliquer » (ou « Passer ce cours »).
3. **Au quotidien** : déposez vos documents dans le dossier du cours, n'importe où, ou dans `📥 Inbox` si
   vous ne savez pas où ils vont. La barre d'état affiche « 🎓 N nouveaux docs » ; « Agréger » propose de
   les classer, de les transcrire, de les relier aux notes existantes et de les ajouter au skill tree.

Commandes (palette) : ouvrir le panneau · organiser tous les cours · organiser / réorganiser un cours ·
agréger les nouveaux documents · régénérer les skill trees (sans Claude) · réinitialiser la mise en page
d'un skill tree · annuler la dernière opération · tester la connexion.

## Ce qui a changé par rapport à l'idée de départ

- **Claude propose, le plug-in exécute.** Laisser un agent déplacer des fichiers directement dans un vault
  de cours est risqué (fichiers écrasés, liens cassés). Ici Claude n'a qu'un accès en lecture ; toute
  écriture passe par la validation et par Obsidian.
- **Le canvas est généré à partir d'une carte du cours** (`_curator.json`) plutôt qu'écrit directement par
  Claude. C'est ce qui permet de le régénérer à chaque ajout sans perdre la mise en page ni la
  progression, et d'en tirer un index Markdown.
- **Lecture en deux temps** : un modèle rapide lit chaque document une fois (résultat en cache), le modèle de
  structuration ne voit que ces fiches. Le premier passage reste abordable même sur des centaines de
  fichiers, et les passages suivants ne relisent que les nouveautés.
- **« Jeter » veut dire archiver**, et les dashboards personnels qui ne sont pas remplaçables sont
  conservés et liés depuis le nouveau.
- Une **boîte de réception** pour les documents dont on ne connaît pas le cours.

## Limites

- Les fichiers Office (docx, pptx) et HEIC ne sont identifiés que par leur nom et leur emplacement.
- Le texte d'un PDF n'est extrait que sur ses premières pages (réglable) ; un PDF scanné est lu comme une
  image.
- Le premier passage sur un gros vault prend du temps (environ une minute par lot de six documents avec
  Claude Code) ; il peut être interrompu et reprend là où il s'était arrêté grâce au cache.
- Avec le moteur API, la clé est stockée en clair dans `.obsidian/plugins/course-curator/data.json`.

## Développement

```bash
npm run dev        # build en continu
npm test           # tests unitaires (dont le pipeline complet avec un Claude simulé)
npm run build      # vérification des types + build de production
# Essai réel avec Claude Code sur une copie de vault (toutes les opérations proposées sont acceptées) :
CURATOR_E2E=/chemin/vers/copie-du-vault npx vitest run tests/e2e.test.ts
```

```
src/
  core/        logique pure, testée : scan, plans (simulation, validation), canvas, index, carte du cours
  llm/         pont Claude Code, API Claude, prompts et schémas JSON
  engine.ts    orchestration : lecture → plan → application journalisée → dashboards → annulation
  obsidianIO.ts  accès au vault via Obsidian (déplacements avec mise à jour des liens, pdf.js)
  ui/          panneau latéral, fenêtre de validation, réglages
  main.ts      commandes, événements, barre d'état
```
