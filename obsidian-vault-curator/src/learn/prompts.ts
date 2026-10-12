import { CuratorSettings } from "../core/settings";
import { Extract, FichePlan, Source, SynthesisPlan } from "./types";

function context(settings: CuratorSettings): string {
  return `Tu fais partie de Vault Curator, un plug-in Obsidian qui transforme les documents bruts d'un cours (slides, feuilles d'exercices,
photos du tableau et du cahier, notes tapées) en fiches de révision structurées, reliées par un skill tree.
À propos de l'utilisateur : ${settings.profile || "(non renseigné)"}
Langue : les fiches suivent la langue du cours (celle des slides et du professeur) ; les échanges avec l'utilisateur (plan, questions,
remarques) sont en français. Mathématiques en LaTeX ($...$ en ligne, $$...$$ en bloc).`;
}

// ---------------------------------------------------------------------------
// Extraction

export function photoSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : transcrire une photo prise en cours (tableau, page de cahier, feuille). On te donne plusieurs vues de la même photo :
la vue d'ensemble pour comprendre l'organisation, et des vues de détail agrandies pour lire. Le but est une transcription intégrale
et exacte, que l'étudiant puisse utiliser à la place de la photo.
- Transcris tout ce qui est écrit, dans l'ordre de lecture (sur un tableau : colonne par colonne, de haut en bas), y compris les annotations,
  les encadrés (signale-les), les flèches (« flèche de … vers … ») et les mots soulignés.
- Mathématiques en LaTeX, en respectant exactement indices, exposants, transposées, chapeaux, normes, indicatrices.
- Schémas et graphes : décris-les précisément entre crochets [Schéma : axes, courbes, légendes, ce qu'ils montrent].
- Ne corrige pas le fond et n'ajoute rien. Si une erreur du professeur semble évidente, transcris tel quel et signale-la dans uncertain.
- En cas de doute, écris ta meilleure lecture suivie de [?] et décris le passage dans uncertain (où il se trouve, quelles lectures possibles).
- Ignore ce qui n'est pas du contenu (plafond, lampes, reflets, bords de table).
description : ce qu'est la photo (tableau, cahier, feuille), son sujet et tout repère visible (séance, exercice, date).`;
}

export function photoPrompt(path: string, labels: string[], readWithTool: boolean, prior: string | null = null): string {
  const views = labels.map((l, i) => `- vue ${i + 1} : ${l}`).join("\n");
  const old = prior
    ? `\n\n## Transcription antérieure (version précédente de l'outil)\nSers-t'en comme aide à la lecture, sans la recopier aveuglément : la photo fait foi, corrige-la et complète-la.\n\`\`\`markdown\n${prior}\n\`\`\``
    : "";
  return `Photo : ${path}\nVues fournies${readWithTool ? " (à lire avec l'outil Read)" : " (jointes ci-dessus)"} :\n${views}${old}`;
}

export function verifySystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : relire une transcription de photo prise en cours. On te donne la photo (vue d'ensemble et vues de détail) et une transcription
brouillon. Compare la photo et la transcription ligne par ligne et corrige : passages oubliés, symboles mal lus (indices, signes, transposées,
exposants, lettres grecques), ordre de lecture, schémas mal décrits. Garde ce qui est juste tel quel.
transcript : la transcription corrigée complète. corrections : chaque correction faite, en une ligne. uncertain : les doutes qui restent.`;
}

export function verifyPrompt(path: string, labels: string[], draft: string, readWithTool: boolean): string {
  return `${photoPrompt(path, labels, readWithTool)}\n\n## Transcription brouillon\n\`\`\`markdown\n${draft}\n\`\`\``;
}

export function pdfSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : transcrire fidèlement et intégralement des pages d'un document de cours (slides, poly, feuille d'exercices).
Pour chaque page : « ## Page N — titre de la page », puis tout son contenu : texte, formules en LaTeX, tableaux en Markdown,
figures décrites entre crochets [Figure : …]. Pas de résumé, pas de commentaire. Ignore les pieds de page répétés (nom du cours, logo).
Le texte extrait automatiquement est fourni comme aide : il peut être mal formé, surtout pour les formules ; la page fait foi.
uncertain : les passages illisibles ou ambigus.`;
}

export function pdfPrompt(path: string, from: number, to: number, pageCount: number, layerText: string | null, readWithTool: boolean): string {
  const how = readWithTool ? `Lis ce PDF avec l'outil Read (paramètre pages : "${from}-${to}").` : "Le PDF est joint ci-dessus.";
  const hint = layerText ? `\n\n## Texte extrait automatiquement (aide)\n\`\`\`\n${layerText}\n\`\`\`` : "";
  return `Document : ${path} (${pageCount} pages). Transcris les pages ${from} à ${to}. ${how}${hint}`;
}

// ---------------------------------------------------------------------------
// Plan: what the lot contains and how to turn it into notes.

export function planSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : à partir du contenu intégral des documents d'une séance (ou d'un ensemble de séances), concevoir les fiches de révision
qui permettront de l'apprendre le mieux, et leur place dans le skill tree du cours. Rien n'est encore écrit : l'utilisateur discute ton plan
avant la rédaction. Procède ainsi :

1. Inventaire. Ce que chaque source apporte et comment elles se complètent : les slides donnent le cadre et les énoncés de référence,
   le tableau les explications, dérivations et exemples du professeur, le cahier les exercices résolus et remarques, les notes personnelles
   les points d'attention et questions de l'étudiant, la feuille d'exercices les énoncés. Repère les problèmes (sources contradictoires,
   énoncé sans corrigé ou l'inverse, passages illisibles) dans issues.
2. Notions. Identifie les notions enseignées et leurs dépendances, y compris avec les fiches déjà existantes du cours.
3. Fiches. Une fiche = une notion cohérente qu'on apprend en une séance de travail (20 à 40 minutes) ; jamais une fiche par document.
   Les exercices vont dans une fiche « Exercices corrigés » de la séance (énoncé, correction, méthode à retenir), reliée aux fiches de notions ;
   un exercice très lié à une seule notion peut aussi être un exemple de cette fiche. Si une fiche existante traite déjà la notion,
   complète-la (action = extend, path = son chemin) plutôt que d'en créer une concurrente.
   Pour chaque fiche : objectif (ce qu'on sait faire après), plan des sections dans l'ordre (avec ce que contient chacune, inspiré du gabarit),
   sources qui l'alimentent avec ce que chacune apporte, prérequis (ids de fiches, nouvelles ou existantes), mots-clés.
4. Destination de chaque document (disposition, dans sources) :
   - integrate : son contenu entier va dans les fiches, puis il rejoint le dossier Sources de la séance. C'est le cas des slides et polys
     de la séance, des feuilles d'exercices, des photos, des notes brutes prises en cours. Il apparaît dans les sources d'au moins une fiche.
   - keep : matériel de la séance non transcrit (notebook, données, annexe) : rejoint Sources, relié au skill tree, cité par la fiche concernée.
   - reference : référence du cours entier (syllabus, manuel, polycopié complet d'un autre auteur, annales) : reste où il est, relié au
     skill tree. Les documents seulement survolés (signalés comme tels) sont des références.
   - ignore : pas du contenu de cours (README d'un outil, journal de session, fichier de configuration, consignes pour un autre assistant) :
     on n'y touche pas.
   Les fiches de révision DÉJÀ STRUCTURÉES (rédigées par l'étudiant ou un autre outil : notions, exemples, exercices organisés) ne sont pas
   des sources : ce sont des fiches. Mets-les dans fiches avec leur chemin et action « keep » (gardée telle quelle, placée dans le
   skill tree avec ses prérequis) ou « extend » si les documents bruts de la séance les complètent. Ne propose jamais une fiche
   concurrente d'une fiche existante. Respecte l'organisation que l'étudiant a déjà construite (ses noms, ses dossiers, ses modules).
   Les photos insérées dans une note (marquées « ⟨photo transcrite : voir Sx⟩ ») sont des sources à part entière : leur transcription est
   le vrai contenu de la note ; elles vont avec la note dans les mêmes fiches.
   S'il n'y a rien à apprendre dans le lot (que des références), fiches peut être vide.
5. Module. La séance rejoint un module existant du cours (mode existing, même id) ou en ouvre un nouveau (mode new). Organisation d'une séance :
   <séance>/Fiches (les fiches, numérotées « 01 - Titre » par le plug-in dans l'ordre où tu les donnes), <séance>/Sources (les documents
   bruts une fois intégrés, avec leurs transcriptions) et <séance>/<séance>.canvas (la synthèse). Quand les documents viennent d'un dossier
   de séance, ce dossier est gardé tel quel. Sinon folder : dossier de la séance dans le cours, nommé selon les conventions existantes
   (sinon « NN Titre », numéroté dans l'ordre du cours). Donne les fiches dans l'ordre d'apprentissage, exercices corrigés en dernier.
   Il n'y a qu'un skill tree, celui du cours entier : les fiches de chaque séance y sont des nœuds reliés par leurs prérequis.
8. Skill tree du cours (tree) : la nouvelle séance s'insère dans le cours ; remodèle le skill tree en conséquence.
   moduleOrder : les ids de TOUS les modules du cours (existants et nouveau) dans l'ordre d'apprentissage.
   updates : les modules ou fiches EXISTANTS dont les prérequis ou le résumé doivent changer à la lumière du nouveau contenu
   (une fiche d'une séance précédente qui s'appuie en fait sur une notion de cette séance, un module mal placé, un résumé
   devenu inexact…) : dependsOn = la nouvelle liste complète de ses prérequis, summary = nouveau résumé ou "" pour le garder,
   why = la raison en une phrase. Vide si rien ne change. Les prérequis des nouvelles fiches peuvent viser des fiches d'autres
   séances : c'est ce qui relie le skill tree d'une séance à l'autre.
7. Langue (language) : celle des documents du cours (slides, poly, énoncés), par exemple « English ». Les titres et le corps des fiches
   sont dans cette langue ; seules les explications ajoutées et remarques personnelles peuvent être en français. Le reste du plan
   (summary, contributes, questions, issues) est en français.
6. id des fiches : courts, stables, en minuscules avec tirets (« knn-principe »). Les prérequis vers des fiches existantes utilisent leurs ids
   tels que donnés dans la carte du cours.
questions : ce qui changerait la structure et que tu ne peux pas trancher (avec ton hypothèse). summary : 2 à 4 phrases sur la séance et le plan.
session : nom court de la séance (« Semaine 2 — k plus proches voisins »). changes : vide pour une première proposition.
preferences : ce que l'utilisateur a exprimé sur sa façon d'apprendre (vide au départ, alimenté par ses retours).

Gabarit de fiche de l'utilisateur (à adapter au contenu) :
${settings.ficheTemplate}`;
}

export interface CourseContext {
  course: string;
  folder: string;
  /** Outline of the course map: modules, their notes (id, title, path, headings). */
  outline: string;
  conventions: string;
  preferences: string[];
  instructions: string;
}

export function sourcesBlock(sources: Source[], extracts: Map<string, Extract>): string {
  return sources
    .map((s) => {
      const e = extracts.get(s.id);
      const head = `### ${s.id} — ${s.path}${s.embeddedIn ? ` (photo insérée dans ${s.embeddedIn})` : ""}${e?.survey ? "\n(document seulement survolé : à garder comme référence)" : ""}${e?.description ? `\n(${e.description})` : ""}${e?.editedByUser ? "\n(transcription relue et corrigée par l'utilisateur)" : ""}`;
      if (!e) return `${head}\n(contenu non disponible)`;
      const unc = e.uncertain.length ? `\nPassages incertains : ${e.uncertain.join(" ; ")}` : "";
      const trunc = e.truncated ? `\n(${e.truncated})` : "";
      return `${head}\n\`\`\`markdown\n${e.text}\n\`\`\`${unc}${trunc}`;
    })
    .join("\n\n");
}

export function planPrompt(ctx: CourseContext, lotName: string, sources: Source[], extracts: Map<string, Extract>): string {
  return [
    `# Cours : ${ctx.course}\nDossier du cours : ${ctx.folder}`,
    ctx.instructions ? `Ce que l'utilisateur dit de ce cours : ${ctx.instructions}` : "",
    `## Carte actuelle du cours (modules et fiches existantes)\n${ctx.outline || "(aucune fiche pour l'instant)"}`,
    ctx.conventions ? `## Conventions du cours\n${ctx.conventions}` : "",
    ctx.preferences.length ? `## Préférences de l'utilisateur\n${ctx.preferences.map((p) => `- ${p}`).join("\n")}` : "",
    `## Documents à synthétiser (${lotName}) — contenu intégral\n${sourcesBlock(sources, extracts)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function planRevisionPrompt(original: string, previous: SynthesisPlan, round: number, feedback: string, earlier: string[]): string {
  const history = earlier.length ? `\n\n## Retours sur les versions précédentes (à respecter encore)\n${earlier.map((e, i) => `### Version ${i + 1}\n${e}`).join("\n\n")}` : "";
  return `${original}${history}

## Ta proposition précédente (version ${round})
\`\`\`json
${JSON.stringify(previous)}
\`\`\`

## Retour de l'utilisateur sur cette version
${feedback || "(aucun commentaire)"}

Produis une version révisée COMPLÈTE du plan (même format) qui intègre chaque retour. Ne repose pas une question à laquelle il a répondu.
Ajoute aux préférences ce que ses retours disent de sa façon d'apprendre, formulé comme des règles réutilisables.
changes : ce qui a changé et comment chaque retour est pris en compte (ou pourquoi il ne peut pas l'être).`;
}

// ---------------------------------------------------------------------------
// Writing

export function writeSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : rédiger UNE fiche de révision à partir du contenu intégral de ses sources, selon le plan validé par l'utilisateur.
- Complète : tout ce que les sources apportent à cette fiche y figure (définitions, formules, hypothèses, dérivations, exemples du tableau,
  remarques du professeur, exercices et leurs corrections, questions des notes personnelles). C'est la condition pour archiver les sources.
- Pédagogique : l'intuition avant le formalisme, les exemples rédigés pas à pas, les liens entre notions explicités, les pièges signalés.
  Tu peux ajouter de courtes transitions et explications pour relier les éléments, mais aucun fait qui ne vienne pas des sources ;
  si une question des notes personnelles trouve sa réponse dans les sources, réponds-y dans un encadré > [!question].
- Fidèle : si des sources se contredisent, dis-le dans un encadré > [!warning] ; garde [?] sur les passages incertains.
- Obsidian : liens vers les autres fiches avec [[chemin|titre]] (liste fournie) ; pas d'image intégrée ; pas de lien après chaque phrase :
  les sources sont listées une fois, dans la section « Sources », avec les liens fournis.
- Langue : le titre et le corps de la fiche (définitions, énoncés, théorèmes, méthode, exemples) sont dans la langue du cours indiquée ;
  les explications que tu ajoutes et les remarques de l'étudiant peuvent rester en français (encadrés > [!note] par exemple). Ne traduis
  pas les notes personnelles de l'étudiant : cite-les telles quelles.
- Garde exactement le frontmatter fourni en tête du fichier.
Si la fiche existe déjà (extension), réorganise-la librement pour intégrer le nouveau contenu, mais tout son contenu actuel doit rester présent.
content : la fiche complète en Markdown. summary : une phrase sur ce qu'elle couvre.

Gabarit de l'utilisateur (à adapter, les sections vides sont supprimées) :
${settings.ficheTemplate}`;
}

export function writePrompt(
  fiche: FichePlan,
  frontmatter: string,
  before: string | null,
  sources: Source[],
  extracts: Map<string, Extract>,
  others: { title: string; path: string }[],
  sourceLinks: { path: string; title: string }[],
  comment: string,
  language = "",
): string {
  return [
    `# Fiche à rédiger : ${fiche.title}\nChemin : ${fiche.path}\nObjectif : ${fiche.objective}${language ? `\nLangue du cours (titre et corps de la fiche) : ${language}` : ""}`,
    `## Plan validé\n${fiche.outline.map((o, i) => `${i + 1}. ${o}`).join("\n")}`,
    `## Ce que chaque source apporte\n${fiche.sources.map((s) => `- ${s.sourceId} : ${s.what}`).join("\n")}`,
    `## Frontmatter à reprendre tel quel\n\`\`\`yaml\n${frontmatter}\n\`\`\``,
    before !== null ? `## Contenu actuel de la fiche (à conserver intégralement)\n\`\`\`markdown\n${before}\n\`\`\`` : "",
    `## Autres fiches (pour les liens)\n${others.map((o) => `- [[${o.path}|${o.title}]]`).join("\n") || "(aucune)"}`,
    `## Liens à mettre dans la section Sources\n${sourceLinks.map((l) => `- [[${l.path}|${l.title}]]`).join("\n")}`,
    comment ? `## Demande de l'utilisateur pour cette fiche\n${comment}` : "",
    `## Contenu intégral des sources\n${sourcesBlock(sources, extracts)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Coverage

export function coverageSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : vérifier qu'aucun contenu des sources n'a été perdu dans les fiches rédigées, avant que les sources soient archivées.
Pour chaque source, liste les éléments de contenu absents des fiches ou déformés : formule, définition, hypothèse, étape de dérivation,
résultat, exemple, remarque, exercice ou correction, question. Ne compte pas la mise en forme, les répétitions, ni ce qui n'est pas du contenu
(titres de diapositives répétés, numéros de page, logos, en-têtes). Une formule réécrite avec d'autres notations mais équivalente est présente.
covered = true quand rien de substantiel ne manque. missing : un élément par entrée (item : cité assez précisément pour être retrouvé ;
fiche : chemin de la fiche où il devrait aller).`;
}

export function coveragePrompt(sources: Source[], extracts: Map<string, Extract>, fiches: { path: string; content: string }[]): string {
  return [
    `## Fiches rédigées\n${fiches.map((f) => `### ${f.path}\n\`\`\`markdown\n${f.content}\n\`\`\``).join("\n\n")}`,
    `## Sources\n${sourcesBlock(sources, extracts)}`,
  ].join("\n\n");
}

export function completeSystem(settings: CuratorSettings): string {
  return `${context(settings)}

Ta tâche ici : compléter une fiche de révision avec des éléments qui manquent, chacun à sa place logique (pas en vrac à la fin),
sans rien retirer de la fiche. content : la fiche complète. summary : ce que tu as ajouté.`;
}

export function completePrompt(path: string, content: string, missing: { sourceId: string; items: string[] }[], sources: Source[], extracts: Map<string, Extract>): string {
  return [
    `# Fiche : ${path}\n\`\`\`markdown\n${content}\n\`\`\``,
    `## Éléments à intégrer\n${missing.map((m) => m.items.map((i) => `- (${m.sourceId}) ${i}`).join("\n")).join("\n")}`,
    `## Sources concernées\n${sourcesBlock(
      sources.filter((s) => missing.some((m) => m.sourceId === s.id)),
      extracts,
    )}`,
  ].join("\n\n");
}
