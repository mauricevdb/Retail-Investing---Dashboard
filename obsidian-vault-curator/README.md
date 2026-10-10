# Vault Curator — plug-in Obsidian

Organise n'importe quel dossier d'un vault Obsidian avec Claude : un cours, un projet de mémoire, des
papiers administratifs, une veille, le vault entier…

1. **Comprendre.** Claude lit le contenu du dossier choisi et se fait une idée de ce qu'il est, de son
   utilité pour toi et de la façon dont tu t'en sers (réviser avant un examen, retrouver vite un
   justificatif, suivre l'avancement d'un projet…).
2. **Proposer.** Il en déduit un principe d'organisation et un plan de structuration : rangement des
   fichiers, règles pour les futurs documents, dashboard en canvas, sort des anciens dashboards.
3. **Discuter.** Tu réponds à ses questions, commentes les opérations une par une, corriges sa
   compréhension, décoches ce que tu refuses… et il révise le plan. Autant de tours que nécessaire.
4. **Appliquer.** Quand tu valides pour de bon, le plug-in exécute le plan (et peut l'annuler).
5. **Agréger.** À chaque lancement d'Obsidian, il repère le nouveau matériau arrivé dans les dossiers
   gérés (ou dans la boîte de réception `📥 Inbox`) et propose un plan pour l'intégrer à la structure
   existante, en appliquant les règles et préférences retenues lors des discussions précédentes. Même
   boucle : discussion, validation, exécution.

Claude ne touche jamais au vault : il propose un plan en JSON, le plug-in le vérifie, tu le discutes et le
valides, puis le plug-in l'exécute. Tout est annulable.

## Fonctionnement

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
2. **Organiser un dossier** : clic droit sur le dossier → « Vault Curator : organiser ce dossier », ou
   depuis le panneau ✨. Le plan s'ouvre : compréhension du dossier, questions, dashboard proposé, règles
   de rangement, opérations groupées par type.
   - réponds aux questions dans les champs prévus ;
   - 💬 pour commenter une opération, ✎ pour corriger une destination, décoche ce que tu refuses ;
   - « Autre chose à dire ? » pour corriger sa compréhension ou exprimer une préférence ;
   - **Réviser avec mes retours** → Claude renvoie une version révisée, avec la liste de ce qui a changé ;
   - **Valider et appliquer** quand le plan te convient.
3. **Au quotidien** : dépose tes documents dans un dossier géré, n'importe où, ou dans `📥 Inbox`. Au
   lancement d'Obsidian (ou via « Agréger »), le plug-in propose de les intégrer.

Commandes : ouvrir le panneau · organiser un dossier · réorganiser un dossier géré · agréger les nouveaux
documents · régénérer les dashboards (sans Claude) · réinitialiser la mise en page d'un dashboard · annuler
la dernière opération · tester la connexion.

## Limites

- Les fichiers Office (docx, pptx, xlsx) et HEIC ne sont identifiés que par leur nom et leur emplacement.
- Le texte d'un PDF n'est extrait que sur ses premières pages (réglable) ; un PDF scanné est lu comme une image.
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
```

```
src/
  core/          logique pure, testée : scan des dossiers gérés, plans (simulation, validation),
                 canvas, index, carte du dossier, migration 0.1 → 0.2
  llm/           pont Claude Code, API Claude, prompts (compréhension, plan, révision, agrégation)
  engine.ts      orchestration : lecture → plan → révisions → application journalisée → dashboards
  obsidianIO.ts  accès au vault via Obsidian (déplacements avec mise à jour des liens, pdf.js)
  ui/            panneau, fenêtre du plan (discussion), ajout de dossier, réglages
  main.ts        commandes, menu contextuel, détection au lancement
```
