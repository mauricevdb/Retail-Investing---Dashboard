import { allSections } from "../core/plan";
import { SpaceInventory } from "../core/scan";
import { CuratorSettings, Intervention } from "../core/settings";
import { CheckedOp, Feedback, FileDigest, SpaceMap, VaultFile } from "../core/types";

function context(settings: CuratorSettings): string {
  return `Tu fais partie de Vault Curator, un plug-in Obsidian qui organise les dossiers d'un vault.
À propos de l'utilisateur : ${settings.profile || "(non renseigné)"}
Ses dossiers peuvent contenir n'importe quoi : cours, projets, recherche, administratif, finances personnelles, veille, écriture…
Tu ne modifies jamais le vault toi-même : tu réponds en JSON, le plug-in vérifie ta proposition, l'utilisateur la commente
et la valide, puis le plug-in l'exécute (et peut l'annuler). Le contenu est majoritairement en français ; réponds en français.`;
}

// ---------------------------------------------------------------------------
// Digest: one call per batch of files.

export function digestSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : identifier chaque fichier fourni, pour que le plug-in puisse ensuite l'organiser.
Pour chaque fichier, renvoie :
- path : exactement le chemin donné.
- docType : cours (supports de cours), exercices (TD, TP, sujets, annales), corrige, notes (notes tapées, comptes rendus, brouillons),
  manuscrit (notes manuscrites, photo d'un tableau ou d'un cahier, scan de papier), photo (autre image), lecture (article, livre, chapitre),
  reference (documentation, guide, fiche, formulaire de formules), rapport (rapport, livrable, mémoire), presentation, donnees (tableur, jeu de données),
  code, admin (contrat, facture, formulaire officiel, attestation, justificatif), correspondance (mail, lettre), planning (programme, syllabus,
  feuille de route, calendrier, liste de tâches), journal (notes quotidiennes), modele (gabarit), dashboard (index, MOC, carte, canvas), autre.
- title : un titre court et parlant, tiré du contenu (pas du nom de fichier s'il est opaque).
- summary : une ou deux phrases sur ce que contient le document et à quoi il sert.
- topics : 2 à 6 notions ou sujets clés, courts.
- sequence : ce qui situe le document dans une suite, si c'est visible (« Séance 3 », « Chapitre 2 », « Phase 1 », une date…), sinon null.
- transcript : ${
    settings.handwriting !== "off"
      ? `pour les documents manuscrits uniquement (notes à la main, tableau, cahier), une transcription fidèle en Markdown
  (titres, listes, formules en LaTeX entre $...$ ou $$...$$, schémas décrits brièvement entre crochets).
  N'invente rien : écris [illisible] quand un passage ne se lit pas. Pour tous les autres fichiers : null.`
      : "toujours null."
  }
Si un fichier est vide ou illisible, dis-le dans summary et mets docType à « autre ».
Renvoie exactement un élément par fichier fourni.`;
}

export interface DigestItem {
  path: string;
  size: number;
  /** Extracted text (markdown, PDF text layer, canvas description), or null. */
  text: string | null;
  /** The file is attached / must be read with the Read tool. */
  attached: boolean;
  pageCount: number | null;
}

export function digestPrompt(space: string, items: DigestItem[], readWithTool: boolean): string {
  const blocks = items.map((it, i) => {
    const head = `### Fichier ${i + 1} : ${it.path}\n(${Math.round(it.size / 1024)} Ko${it.pageCount ? `, ${it.pageCount} pages` : ""})`;
    if (it.attached) {
      return `${head}\n${readWithTool ? "Lis ce fichier avec l'outil Read (pour un PDF, les pages 1 à 4 suffisent)." : "Contenu joint ci-dessus."}`;
    }
    if (it.text) return `${head}\n\`\`\`\n${it.text}\n\`\`\``;
    return `${head}\n(contenu non lisible par le plug-in : déduis ce que tu peux du nom et de l'emplacement)`;
  });
  return `Dossier : ${space}\n\n${blocks.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Shared rules

const INTERVENTION: Record<Intervention, string> = {
  conservative: `Niveau d'intervention : CONSERVATEUR. Ne touche qu'à ce qui est clairement mal placé
(fichiers en vrac, document au mauvais endroit, doublons évidents). Ne renomme pas les dossiers existants.`,
  balanced: `Niveau d'intervention : ÉQUILIBRÉ. Garde ce qui fonctionne déjà, même si ce n'est pas exactement ce que tu aurais fait ;
change ce qui gêne vraiment l'usage (vrac, dossiers fourre-tout, mélanges de sujets, noms opaques).`,
  thorough: `Niveau d'intervention : COMPLET. Réorganise tout le dossier selon le principe le mieux adapté, en renommant et regroupant si nécessaire.`,
};

const EXAMPLES = `Exemples de structures selon la nature du dossier (inspiration, pas modèles à appliquer) :
- Cours : « 00 Admin » (syllabus, modalités), un dossier numéroté par module dans l'ordre du cours (sous-dossiers Cours / Exercices / Notes / Images
  à partir de 3 fichiers), « 90 Examens », « 95 Ressources ». Dashboard : skill tree, flèches = prérequis.
- Projet : « 00 Cadrage », un dossier par phase ou par chantier, « Livrables », « Réunions » (comptes rendus datés AAAA-MM-JJ), « Ressources ».
  Dashboard : feuille de route, flèches = enchaînement des phases.
- Recherche / veille : un dossier par thème ou question, sources et notes de lecture côte à côte, une note de synthèse par thème.
  Dashboard : carte thématique, sans flèches ou avec des dépendances entre questions.
- Administratif / finances perso : par domaine (Banque, Logement, Santé, Impôts, Travail…), puis par année ; noms « AAAA-MM-JJ - Émetteur - Objet ».
  Dashboard : sommaire par domaine, sans flèches.`;

function handwritingRule(settings: CuratorSettings): string {
  if (settings.handwriting === "off") return "N'utilise ni transcribe ni integrate.";
  if (settings.handwriting === "separate") {
    return `transcribe : pour chaque document manuscrit dont la transcription est disponible, ajoute une opération transcribe (source = chemin final du fichier, target = null, content = null) ; le plug-in crée une note Markdown à côté. N'utilise pas integrate.`;
  }
  return `integrate : le contenu des documents manuscrits (photos de tableau ou de cahier, scans de notes) doit rejoindre la fiche
  correspondante, c'est-à-dire la note Markdown de la même séance ou du même sujet (par exemple les notes du cours pendant lequel le tableau
  a été photographié, ou la fiche du TD pour une page de cahier d'exercices). Une seule opération integrate par fiche : sources = chemins
  finaux de tous les documents à y intégrer, target = la fiche, source = null, content = null (le plug-in prépare la fusion, que l'utilisateur
  relit avant de valider). S'il n'existe pas de fiche adaptée, donne comme target le chemin d'une nouvelle note (selon les règles de nommage) :
  elle sera créée. Les photos elles-mêmes restent rangées à leur place. Les transcriptions séparées qui existent déjà (notes « … — transcription.md »)
  sont à intégrer de la même façon (en sources), puis à archiver. N'utilise pas transcribe.`;
}

function rules(settings: CuratorSettings, space: SpaceInventory): string {
  const sub = space.subspaces.length
    ? `\n- Ces sous-dossiers sont organisés séparément : ne déplace rien à l'intérieur (tu peux déplacer ou renommer le dossier entier) : ${space.subspaces.map((s) => `« ${s.folder} »`).join(", ")}.`
    : "";
  return `Règles pour les opérations (ops) :
- Tous les chemins sont relatifs à la racine du vault${space.folder ? ` et commencent par « ${space.folder}/ »` : ""}.
- Les opérations s'exécutent dans l'ordre ; chaque chemin désigne l'état du vault après les opérations précédentes.
  Déplacer un dossier déplace tout son contenu : si un dossier entier est déjà cohérent, renomme-le plutôt que de déplacer ses fichiers un par un.
- move : déplacer ou renommer un fichier ou un dossier (source → target). Les dossiers parents sont créés automatiquement et les dossiers vidés
  par tes déplacements sont supprimés automatiquement. mkdir ne sert que pour un dossier qui doit exister vide. Garde l'extension des fichiers.
- archive : rien n'est jamais supprimé. Ce qui est obsolète ou en double va dans « ${settings.archiveFolder}/ » via archive (source seulement).
- ${settings.renameUnclearFiles ? `Renomme les fichiers au nom opaque (IMG_2034.jpg, scan0001.pdf, Document (3).pdf) avec un nom parlant qui suit les règles de rangement. Ne renomme pas un fichier dont le nom est déjà parlant.` : "Ne renomme aucun fichier : déplace-les seulement."}
- ${handwritingRule(settings)}
- create_note et append_note sont exceptionnels : seulement pour ne pas perdre une information (par exemple le contenu personnel d'un ancien dashboard qu'on archive) ou pour relier un nouveau document à une note existante. append_note ajoute à la fin d'une note, sans jamais la réécrire.
- N'utilise jamais ces noms, réservés au plug-in : « ${space.generated.canvas} », « ${space.generated.index} », « ${space.generated.map} ».${sub}
- Chaque opération a une raison courte (reason), lisible par l'utilisateur.

Règles maison de l'utilisateur (valables pour tous ses dossiers) :
${settings.guidelines}

${INTERVENTION[settings.intervention]}`;
}

function digestLine(file: VaultFile, d: FileDigest | undefined): string {
  const size = `${Math.max(1, Math.round(file.size / 1024))} Ko`;
  if (!d) return `- ${file.path} (${size}) — non analysé`;
  const seq = d.sequence ? ` {${d.sequence}}` : "";
  const topics = d.topics.length ? ` [${d.topics.join(", ")}]` : "";
  const tr = d.transcript ? " (transcription disponible)" : "";
  return `- ${file.path} (${size}) — ${d.docType} « ${d.title} »${seq} : ${d.summary}${topics}${tr}`;
}

function spaceHeader(space: SpaceInventory): string {
  const s = space.structure;
  const kinds = Object.entries(s.kinds)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  const lines = [
    `# Dossier : ${space.name}`,
    `Emplacement : ${space.folder || "(racine du vault)"}`,
    `État actuel : ${s.fileCount} fichiers (${kinds || "aucun"}), ${s.subfolderCount} sous-dossiers (profondeur max ${s.maxDepth}), ${s.looseFiles} fichiers en vrac au premier niveau, ${Math.round(s.filedRatio * 100)} % déjà rangés dans un sous-dossier.`,
  ];
  if (space.config.instructions.trim()) lines.push(`Ce que l'utilisateur dit de ce dossier : ${space.config.instructions.trim()}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Initial plan: understand the folder, then structure it.

export function initialSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : organiser UN dossier choisi par l'utilisateur. Travaille dans cet ordre.

1. Comprendre (understanding). Lis l'inventaire et réfléchis :
   - kind : la nature du dossier, en un ou deux mots (cours, projet, recherche, administratif, veille…).
   - purpose : à quoi il sert à l'utilisateur, concrètement.
   - usage : comment et quand il s'en sert ou s'en servira (réviser avant un examen, retrouver vite un justificatif, suivre l'avancement
     d'un projet, écrire une synthèse…) et ce qui rend cet usage efficace (accès rapide, vue chronologique, suivi de progression, liens entre notions…).
   - principle : le principe d'organisation que tu retiens et pourquoi il sert cet usage mieux que les autres.
   Repère ce qui est déjà bien structuré et ce qui ne l'est pas.

2. Concevoir une structure robuste : adaptée à l'usage, compréhensible au premier coup d'œil, et qui absorbe les futurs documents sans
   être refaite. Écris dans map.conventions les règles qui disent où va chaque nouveau document et comment le nommer : elles serviront
   à chaque ajout futur, donc elles doivent être précises et générales.

${EXAMPLES}

3. Le dashboard (map) : le plug-in en tire un canvas et une note d'index.
   - dashboardTitle : le nom qui convient (« Skill tree », « Feuille de route », « Carte thématique », « Sommaire »…).
   - linkKind : prerequisite (une section s'appuie sur une autre, comme dans un cours), sequence (des étapes qui se suivent, comme les phases
     d'un projet) ou none (des catégories indépendantes).
   - sections : les grandes parties, dans un ordre qui a du sens (en général 3 à 15). children pour des sous-parties seulement si elles aident
     (un seul niveau). id : « s01-slug-court », stable et unique ; children : « s01-1-slug ». dependsOn : ids des sections qui viennent avant
     (vide si linkKind = none ; ne mets que de vraies dépendances). keywords : 3 à 8 notions ou sujets clés. folder : dossier final de la
     section, ou null.
   - resources : chaque fichier du dossier apparaît exactement une fois, dans une section ou dans transverse (ce qui concerne tout le dossier),
     avec son chemin FINAL (après les opérations), un rôle (docType) et un libellé court. Exceptions : les fichiers archivés et les dashboards existants.
   - summary : 2 phrases qui présentent le dossier.
   - preferences : ce que l'utilisateur a exprimé sur sa façon de travailler (vide au départ, alimenté par ses retours).

4. Les dashboards existants (dashboards) : pour chacun, décide
   - archive : tout ce qu'il contient est couvert par le nouveau dashboard ;
   - merge : il contient des informations utiles (descriptions, progression, remarques personnelles) que tu reportes dans la carte ou dans une note
     (create_note) avant de l'archiver ;
   - keep : c'est un travail personnel que le dashboard généré ne remplace pas ; il reste en place et sera lié.
   Pour archive et merge, ajoute l'opération archive correspondante.

5. questions : les points que tu ne peux pas trancher seul et dont la réponse changerait le plan (5 au maximum, les plus utiles d'abord).
   Fais une hypothèse raisonnable pour chacun dans le plan, et dis laquelle dans la question.
   summary : 2 à 4 phrases sur l'état initial et ce que change ton plan. changes : vide pour une première proposition.`;
}

export function initialPrompt(
  settings: CuratorSettings,
  space: SpaceInventory,
  digests: Map<string, FileDigest>,
  dashboards: { path: string; description: string }[],
  subspaceMaps: { folder: string; summary: string }[],
  previousMap: SpaceMap | null,
): string {
  const parts = [
    spaceHeader(space),
    `## Sous-dossiers\n${space.folders.length ? space.folders.map((f) => `- ${f}/`).join("\n") : "(aucun)"}`,
    `## Fichiers\n${space.files.map((f) => digestLine(f, digests.get(f.path))).join("\n") || "(aucun)"}`,
  ];
  if (subspaceMaps.length) {
    parts.push(`## Sous-dossiers organisés séparément\n${subspaceMaps.map((s) => `- ${s.folder}/ — ${s.summary}`).join("\n")}`);
  }
  if (dashboards.length) parts.push(`## Dashboards existants\n${dashboards.map((d) => `### ${d.path}\n${d.description}`).join("\n\n")}`);
  if (previousMap) {
    parts.push(`## Organisation précédente (déjà validée par l'utilisateur : fais-la évoluer plutôt que de repartir de zéro)\n${mapOutline(previousMap)}`);
  }
  parts.push(rules(settings, space));
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Incremental aggregation of new material into an organised folder.

export function incrementalSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : ce dossier est déjà organisé (règles de rangement et dashboard validés par l'utilisateur). De nouveaux documents sont arrivés.
Propose comment les agréger à la structure existante, en appliquant ses règles de rangement et ses préférences :
- ops : ranger chaque nouveau document au bon endroit, le renommer si son nom est opaque, traiter le manuscrit (voir les règles), archiver un doublon évident.
  Ne déplace pas les documents existants, sauf si l'arrivée des nouveaux rend un regroupement nécessaire (par exemple créer un sous-dossier
  quand il atteint 3 fichiers).
- assignments : pour chaque nouveau document conservé (et chaque note créée), son chemin FINAL, la section (sectionId, ou null pour une
  ressource transverse), son rôle et un libellé court.
- newSections : seulement si un document ouvre vraiment une nouvelle partie (parentId = id de la section parente pour une sous-partie, sinon null).
- keywordUpdates : notions nouvelles apportées à des sections existantes.
- append_note : si un nouveau document complète directement une note existante, tu peux ajouter à la fin de cette note un court paragraphe
  de liaison (lien wiki [[chemin|titre]] et une ou deux phrases). Ne réécris jamais la note.
- preferences : la liste complète des préférences de l'utilisateur, mise à jour si ses retours en révèlent de nouvelles.
- questions : ce qui reste ambigu (avec ton hypothèse). summary : 1 à 3 phrases. changes : vide pour une première proposition.`;
}

export function incrementalPrompt(
  settings: CuratorSettings,
  space: SpaceInventory,
  map: SpaceMap,
  newFiles: VaultFile[],
  digests: Map<string, FileDigest>,
): string {
  const fresh = new Set(newFiles.map((f) => f.path));
  const known = space.files.filter((f) => !fresh.has(f.path));
  return [
    spaceHeader(space),
    `## Organisation actuelle\n${mapOutline(map)}`,
    `## Règles de rangement validées\n${map.conventions || "(non formulées : déduis-les de l'organisation actuelle)"}`,
    `## Préférences de l'utilisateur\n${map.preferences.length ? map.preferences.map((p) => `- ${p}`).join("\n") : "(aucune pour l'instant)"}`,
    `## Sous-dossiers\n${space.folders.map((f) => `- ${f}/`).join("\n") || "(aucun)"}`,
    `## Documents déjà en place\n${known.map((f) => `- ${f.path}`).join("\n") || "(aucun)"}`,
    `## Nouveaux documents\n${newFiles.map((f) => digestLine(f, digests.get(f.path))).join("\n")}`,
    rules(settings, space),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Revision: the same request, plus the previous proposal and the user's feedback.

function describeOp(op: CheckedOp): string {
  const arrow = op.source ? `${op.source} → ${op.target ?? ""}` : (op.target ?? "");
  return `${op.kind} ${arrow}`;
}

/** The user's feedback on one version of a plan, as text for Claude. Empty when there is nothing to say. */
export function feedbackBlock(ops: CheckedOp[], feedback: Feedback): string {
  const lines: string[] = [];
  for (const a of feedback.answers) if (a.answer.trim()) lines.push(`- Question « ${a.question} » → réponse : ${a.answer.trim()}`);
  for (const c of feedback.opComments) {
    const op = ops[c.index];
    if (op && c.comment.trim()) lines.push(`- Sur l'opération ${c.index + 1} (${describeOp(op)}) : ${c.comment.trim()}`);
  }
  for (const e of feedback.edited) {
    const op = ops[e.index];
    if (op) lines.push(`- Destination de l'opération ${e.index + 1} (${describeOp(op)}) modifiée à la main en « ${e.target} » : garde-la.`);
  }
  const commented = new Set(feedback.opComments.filter((c) => c.comment.trim()).map((c) => c.index));
  for (const i of feedback.refused) if (ops[i] && !commented.has(i)) lines.push(`- Opération ${i + 1} refusée (${describeOp(ops[i])}) : ne la repropose pas.`);
  if (feedback.general.trim()) lines.push(`- Commentaire général : ${feedback.general.trim()}`);
  return lines.join("\n");
}

export function revisionPrompt(originalPrompt: string, previous: unknown, round: number, current: string, earlier: string[]): string {
  const history = earlier.length
    ? `\n\n## Retours des versions précédentes (déjà intégrés, à respecter encore)\n${earlier.map((e, i) => `### Sur la version ${i + 1}\n${e}`).join("\n\n")}`
    : "";
  return `${originalPrompt}${history}

## Ta proposition précédente (version ${round})
\`\`\`json
${JSON.stringify(previous)}
\`\`\`

## Retour de l'utilisateur sur cette version
${current || "(aucun commentaire)"}

Produis une version révisée COMPLÈTE de ta proposition (même format), qui intègre chaque retour. Corrige aussi ta compréhension du dossier
si ses réponses la contredisent. Ne repose pas une question à laquelle il a répondu. Ajoute aux préférences ce que ses retours disent de sa
façon de travailler, formulé comme des règles réutilisables, et reporte ce qui concerne le rangement dans les règles de rangement.
Dans changes, liste concrètement ce qui a changé et comment chaque retour est pris en compte (ou pourquoi il ne peut pas l'être).`;
}

// ---------------------------------------------------------------------------
// Merge: integrate handwritten material into its note.

export function mergeSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : intégrer dans une fiche Markdown le contenu de documents manuscrits (photos de tableau, pages de cahier, scans) déjà transcrits,
ou à transcrire toi-même s'ils sont joints. L'objectif : une fiche unique, claire, où l'utilisateur retrouve tout le contenu de la séance ou du sujet.
Règles :
- Conserve intégralement le texte existant de la fiche : tu peux ajouter des titres, insérer des passages entre ses paragraphes, compléter une
  liste, mais tu ne supprimes ni ne reformules rien de ce qui existe. Garde le frontmatter tel quel.
- Place chaque contenu à l'endroit logique (la section de la même notion, dans l'ordre du raisonnement ou du cours) ; crée une section si besoin.
- Fusionne sans doublonner : si une formule ou une idée est déjà dans la fiche, ne la répète pas, complète-la (hypothèse, étape de calcul, exemple).
- Rédige proprement : Markdown, formules en LaTeX ($...$ et $$...$$), sans inventer : [illisible] reste [illisible].
- Après chaque passage intégré, ajoute une référence discrète à sa source sous la forme ([[chemin|📷]]) pour pouvoir revoir la photo.
- Si la fiche n'existe pas encore, crée-la : un titre, puis des sections dans l'ordre logique.
content : la fiche complète après intégration. summary : une phrase sur ce que tu as ajouté et où.`;
}

export interface MergeSource {
  path: string;
  /** Transcription already available (digest or old transcription note), or null when the file is attached. */
  text: string | null;
}

export function mergePrompt(target: string, before: string | null, sources: MergeSource[], readWithTool: boolean): string {
  const parts = [
    `# Fiche : ${target}`,
    before === null ? "(nouvelle fiche, à créer)" : `## Contenu actuel de la fiche\n\`\`\`markdown\n${before}\n\`\`\``,
    "## Documents à intégrer",
  ];
  for (const s of sources) {
    if (s.text) parts.push(`### ${s.path}\n\`\`\`markdown\n${s.text}\n\`\`\``);
    else parts.push(`### ${s.path}\n${readWithTool ? "Lis ce fichier avec l'outil Read et transcris-le." : "Joint ci-dessus : transcris-le."}`);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Inbox routing: which managed folder does a stray document belong to?

export function routeSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : des documents ont été déposés dans la boîte de réception du vault. Pour chacun, indique à quel dossier géré il appartient
(space = le nom exact d'un dossier de la liste), ou null si aucun ne convient vraiment. reason : quelques mots.`;
}

export function routePrompt(spaces: { name: string; outline: string }[], files: VaultFile[], digests: Map<string, FileDigest>): string {
  return [
    `## Dossiers gérés\n${spaces.map((c) => `### ${c.name}\n${c.outline}`).join("\n\n")}`,
    `## Documents à router\n${files.map((f) => digestLine(f, digests.get(f.path))).join("\n")}`,
  ].join("\n\n");
}

/** Compact outline of a map for prompts. */
export function mapOutline(map: SpaceMap, withResources = true): string {
  const lines = [`${map.kind ? `[${map.kind}] ` : ""}${map.summary}`];
  if (map.purpose) lines.push(`But : ${map.purpose}`);
  for (const m of allSections(map)) {
    const indent = map.sections.includes(m) ? "" : "  ";
    const deps = m.dependsOn.length ? ` après ${m.dependsOn.join(", ")}` : "";
    lines.push(`${indent}- ${m.id} « ${m.title} »${m.folder ? ` (dossier ${m.folder})` : ""}${deps} — ${m.keywords.join(", ")}`);
    if (withResources) for (const r of m.resources) lines.push(`${indent}    · ${r.role} : ${r.path}`);
  }
  if (withResources && map.transverse.length) {
    lines.push("- transverse");
    for (const r of map.transverse) lines.push(`    · ${r.role} : ${r.path}`);
  }
  return lines.join("\n");
}
