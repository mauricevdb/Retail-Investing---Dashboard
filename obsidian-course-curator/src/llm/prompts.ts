import { CourseInventory } from "../core/scan";
import { CuratorSettings, Intervention } from "../core/settings";
import { allModules } from "../core/plan";
import { CourseMap, FileDigest, VaultFile } from "../core/types";

const CONTEXT = `Tu fais partie de Course Curator, un plug-in Obsidian qui range le vault d'un étudiant en master Data & Finance.
Le vault contient un dossier par cours. On y trouve des PDF de cours et d'exercices, des notes en Markdown,
des photos du tableau ou de cahiers, des annales, et parfois des dashboards faits main (canvas, notes « index »).
Tu ne modifies jamais le vault toi-même : tu réponds en JSON, le plug-in vérifie ta proposition,
l'étudiant la valide opération par opération, puis le plug-in l'exécute (et peut l'annuler).
Le contenu est majoritairement en français ; réponds en français.`;

// ---------------------------------------------------------------------------
// Digest: one call per batch of files.

export function digestSystem(settings: CuratorSettings): string {
  return `${CONTEXT}

Ta tâche ici : identifier chaque fichier fourni, pour que le plug-in puisse ensuite le classer.
Pour chaque fichier, renvoie :
- path : exactement le chemin donné.
- docType : cours (slides, polycopié), exercices (TD/TP/énoncés), corrige, notes (prise de notes tapée),
  tableau (photo du tableau), cahier (photo ou scan de notes manuscrites), annale (sujet d'examen passé),
  syllabus (plan de cours, planning, modalités), formulaire (fiche de formules), lecture (article, chapitre de livre),
  dashboard (index, MOC, carte du cours, skill tree), autre.
- title : un titre court et parlant, tiré du contenu (pas du nom de fichier s'il est opaque).
- summary : une ou deux phrases sur ce que couvre le document.
- topics : 2 à 6 notions clés, courtes (« Black-Scholes », « VaR historique »).
- sequence : ce qui situe le document dans le cours si c'est visible (« Séance 3 », « Chapitre 2 », « TD 4 », une date), sinon null.
- transcript : ${
    settings.transcribePhotos
      ? `pour les photos de tableau ou de cahier uniquement, une transcription fidèle en Markdown
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

export function digestPrompt(course: string, items: DigestItem[], readWithTool: boolean): string {
  const blocks = items.map((it, i) => {
    const head = `### Fichier ${i + 1} : ${it.path}\n(${Math.round(it.size / 1024)} Ko${it.pageCount ? `, ${it.pageCount} pages` : ""})`;
    if (it.attached) {
      return `${head}\n${readWithTool ? "Lis ce fichier avec l'outil Read (pour un PDF, les pages 1 à 4 suffisent)." : "Contenu joint ci-dessus."}`;
    }
    if (it.text) return `${head}\n\`\`\`\n${it.text}\n\`\`\``;
    return `${head}\n(contenu non lisible par le plug-in : déduis ce que tu peux du nom et de l'emplacement)`;
  });
  return `Cours : ${course}\n\n${blocks.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Onboarding: full structure of one course.

const INTERVENTION: Record<Intervention, string> = {
  conservative: `Niveau d'intervention : CONSERVATEUR. Ne touche qu'à ce qui est clairement mal placé
(fichiers en vrac à la racine, document dans le mauvais module, doublons évidents). Ne renomme pas les dossiers existants.`,
  balanced: `Niveau d'intervention : ÉQUILIBRÉ. Garde les dossiers qui fonctionnent déjà, même s'ils ne suivent pas la convention
à la lettre ; rapproche-toi de la convention quand le gain est net (vrac, dossiers fourre-tout, mélange de modules).`,
  thorough: `Niveau d'intervention : COMPLET. Applique la convention à tout le cours, en renommant et regroupant les dossiers si nécessaire.`,
};

function digestLine(file: VaultFile, d: FileDigest | undefined): string {
  const size = `${Math.max(1, Math.round(file.size / 1024))} Ko`;
  if (!d) return `- ${file.path} (${size}) — non analysé`;
  const seq = d.sequence ? ` {${d.sequence}}` : "";
  const topics = d.topics.length ? ` [${d.topics.join(", ")}]` : "";
  const tr = d.transcript ? " (transcription disponible)" : "";
  return `- ${file.path} (${size}) — ${d.docType} « ${d.title} »${seq} : ${d.summary}${topics}${tr}`;
}

function rules(settings: CuratorSettings, course: CourseInventory): string {
  return `Règles pour les opérations (ops) :
- Tous les chemins sont relatifs à la racine du vault et commencent par « ${course.folder}/ ».
- Les opérations s'exécutent dans l'ordre ; chaque chemin désigne l'état du vault après les opérations précédentes.
  Déplacer un dossier déplace tout son contenu : si un dossier entier est déjà cohérent, renomme-le plutôt que de déplacer ses fichiers un par un.
- move : déplacer ou renommer un fichier ou un dossier (source → target). Les dossiers parents sont créés automatiquement ;
  mkdir ne sert que pour un dossier qui doit exister vide, ce qui est rarement utile. Les dossiers vidés par tes déplacements
  sont supprimés automatiquement (et recréés en cas d'annulation). Garde l'extension des fichiers.
- archive : rien n'est jamais supprimé. Ce qui est obsolète ou en double va dans « ${settings.archiveFolder}/ » via archive (source seulement).
- ${settings.renameUnclearFiles ? `Renomme les fichiers au nom opaque (IMG_2034.jpg, scan0001.pdf, Document (3).pdf) en « <repère> - <type> - <titre> », par exemple « S03 - Tableau - Black-Scholes.jpg ». Ne renomme pas un fichier dont le nom est déjà parlant.` : "Ne renomme aucun fichier : déplace-les seulement."}
- ${settings.transcribePhotos ? `transcribe : pour chaque photo dont la transcription est disponible, ajoute une opération transcribe (source = chemin final de l'image, target = null, content = null) ; le plug-in crée une note Markdown à côté de l'image.` : "N'utilise pas transcribe."}
- create_note et append_note sont exceptionnels : seulement pour ne pas perdre une information (par exemple le contenu personnel d'un ancien dashboard qu'on archive). append_note ajoute à la fin d'une note existante, sans jamais la réécrire.
- N'utilise jamais ces noms, réservés au plug-in : « ${course.generated.canvas} », « ${course.generated.index} », « ${course.generated.map} ».
- Chaque opération a une raison courte (reason), lisible par l'étudiant.`;
}

export function onboardSystem(settings: CuratorSettings): string {
  return `${CONTEXT}

Ta tâche ici : structurer UN cours. Tu produis
1. un plan d'opérations pour ranger le dossier du cours de façon intelligente, pratique et intuitive ;
2. la carte du cours (courseMap), à partir de laquelle le plug-in dessine un skill tree en canvas qui sert de dashboard ;
3. un arbitrage sur chaque dashboard existant.

Convention de rangement recommandée (adapte-la au cours ; {course} = nom du dossier du cours) :
${settings.convention}

${INTERVENTION[settings.intervention]}

Carte du cours (courseMap) :
- modules : les grandes parties du cours, dans l'ordre où elles sont enseignées (en général 4 à 15).
  Utilise children pour des sous-chapitres seulement s'ils aident vraiment (un seul niveau).
- id : « m01-slug-court », stable et unique ; children : « m01-1-slug ».
- prerequisites : ids des modules à maîtriser avant celui-ci. Ce sont les flèches du skill tree :
  ne mets que de vraies dépendances conceptuelles (pas simplement « le module précédent »).
- concepts : 3 à 8 notions clés par module.
- folder : dossier final du module (après les opérations), ou null.
- resources : chaque fichier du cours apparaît exactement une fois, dans un module ou dans transverse
  (syllabus, annales couvrant tout le cours, formulaires…), avec son chemin FINAL (après les opérations),
  un rôle (docType) et un libellé court (« Slides S3 — Black-Scholes »). Exceptions : les fichiers archivés
  et les dashboards existants n'y figurent pas.

Dashboards existants (dashboards) : pour chacun, décide
- archive : tout ce qu'il contient est couvert par le nouveau skill tree ;
- merge : il contient des informations utiles (descriptions, progression, remarques) que tu reportes dans la carte
  (ou dans une note via create_note) avant de l'archiver ;
- keep : c'est un travail personnel que le skill tree ne remplace pas (carte mentale faite main, réflexions…) ; il reste en place et sera lié depuis le nouveau dashboard.
Pour archive et merge, ajoute aussi l'opération archive correspondante.

questions : les points que tu n'as pas pu trancher et que l'étudiant devrait regarder (peut être vide).
summary : 2 à 4 phrases sur l'état initial du cours et ce que change ton plan.`;
}

export function onboardPrompt(
  settings: CuratorSettings,
  course: CourseInventory,
  digests: Map<string, FileDigest>,
  dashboards: { path: string; description: string }[],
  previousMap: CourseMap | null,
): string {
  const s = course.structure;
  const parts = [
    `# Cours : ${course.name}`,
    `Dossier : ${course.folder}`,
    `État actuel : ${s.fileCount} fichiers, ${s.subfolderCount} sous-dossiers (profondeur max ${s.maxDepth}), ${s.looseFiles} fichiers en vrac à la racine, ${Math.round(s.filedRatio * 100)} % des fichiers déjà rangés dans un sous-dossier.`,
    `## Sous-dossiers\n${course.folders.length ? course.folders.map((f) => `- ${f}/`).join("\n") : "(aucun)"}`,
    `## Fichiers\n${course.files.map((f) => digestLine(f, digests.get(f.path))).join("\n")}`,
  ];
  if (dashboards.length) {
    parts.push(`## Dashboards existants\n${dashboards.map((d) => `### ${d.path}\n${d.description}`).join("\n\n")}`);
  }
  if (previousMap) {
    parts.push(`## Carte précédente (générée par le plug-in, à faire évoluer plutôt qu'à refaire de zéro)\n${mapOutline(previousMap)}`);
  }
  parts.push(rules(settings, course));
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Incremental aggregation of new documents into an organised course.

export function incrementalSystem(settings: CuratorSettings): string {
  return `${CONTEXT}

Ta tâche ici : le cours est déjà organisé et possède une carte (skill tree). De nouveaux documents sont arrivés.
Propose comment les agréger au reste :
- ops : ranger chaque nouveau document au bon endroit (dossier du module, sous-dossier par type selon la convention),
  le renommer si son nom est opaque, transcrire les photos, archiver un doublon évident d'un document existant.
  Ne déplace pas les documents existants, sauf si l'arrivée des nouveaux rend un regroupement nécessaire (par exemple
  créer le sous-dossier Exercices/ quand il atteint 3 fichiers).
- assignments : pour chaque nouveau document conservé (et chaque note créée), son chemin FINAL, le module (moduleId,
  ou null pour une ressource transverse), son rôle et un libellé court.
- newModules : seulement si un document ouvre vraiment une nouvelle partie du cours (parentId = id du module parent pour un sous-chapitre, sinon null).
- conceptUpdates : notions nouvelles apportées à des modules existants.
- append_note : si un nouveau document complète directement une note existante (même séance, même sujet), tu peux ajouter
  à la fin de cette note un court paragraphe de liaison : un lien wiki [[chemin|titre]] vers le nouveau document et une ou deux phrases. Ne réécris jamais la note.

Convention de rangement :
${settings.convention}

${INTERVENTION[settings.intervention]}

summary : 1 à 3 phrases sur ce qui arrive et où ça va. questions : ce qui reste ambigu (peut être vide).`;
}

export function incrementalPrompt(
  settings: CuratorSettings,
  course: CourseInventory,
  map: CourseMap,
  newFiles: VaultFile[],
  digests: Map<string, FileDigest>,
): string {
  const known = course.files.filter((f) => !newFiles.some((n) => n.path === f.path));
  return [
    `# Cours : ${course.name}\nDossier : ${course.folder}`,
    `## Carte actuelle du cours\n${mapOutline(map)}`,
    `## Sous-dossiers\n${course.folders.map((f) => `- ${f}/`).join("\n") || "(aucun)"}`,
    `## Documents déjà en place\n${known.map((f) => `- ${f.path}`).join("\n") || "(aucun)"}`,
    `## Nouveaux documents\n${newFiles.map((f) => digestLine(f, digests.get(f.path))).join("\n")}`,
    rules(settings, course),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Inbox routing: which course does a stray document belong to?

export function routeSystem(): string {
  return `${CONTEXT}

Ta tâche ici : des documents ont été déposés dans la boîte de réception du vault. Pour chacun, indique à quel cours il appartient
(course = le nom exact d'un cours de la liste), ou null si aucun ne convient vraiment. reason : quelques mots.`;
}

export function routePrompt(courses: { name: string; outline: string }[], files: VaultFile[], digests: Map<string, FileDigest>): string {
  return [
    `## Cours\n${courses.map((c) => `### ${c.name}\n${c.outline}`).join("\n\n")}`,
    `## Documents à router\n${files.map((f) => digestLine(f, digests.get(f.path))).join("\n")}`,
  ].join("\n\n");
}

/** Compact outline of a course map for prompts. */
export function mapOutline(map: CourseMap, withResources = true): string {
  const lines = [map.summary];
  for (const m of allModules(map)) {
    const indent = map.modules.includes(m) ? "" : "  ";
    lines.push(`${indent}- ${m.id} « ${m.title} »${m.folder ? ` (dossier ${m.folder})` : ""} — ${m.concepts.join(", ")}`);
    if (withResources) for (const r of m.resources) lines.push(`${indent}    · ${r.role} : ${r.path}`);
  }
  if (withResources && map.transverse.length) {
    lines.push("- transverse");
    for (const r of map.transverse) lines.push(`    · ${r.role} : ${r.path}`);
  }
  return lines.join("\n");
}
