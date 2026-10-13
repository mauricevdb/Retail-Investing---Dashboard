import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { Backend, DEFAULT_FICHE_TEMPLATE, DEFAULT_GUIDELINES, HandwritingMode, Intervention } from "../core/settings";
import type VaultCuratorPlugin from "../main";

export class CuratorSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: VaultCuratorPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl, plugin } = this;
    const s = plugin.cfg;
    const save = async () => {
      await plugin.saveSettings();
    };
    containerEl.empty();

    new Setting(containerEl).setName("Connexion à Claude").setHeading();
    new Setting(containerEl)
      .setName("Moteur")
      .setDesc(
        "Claude Code : le plug-in pilote le CLI `claude` installé sur l'ordinateur (abonnement Claude, lecture directe des PDF et photos ; ordinateur uniquement). API : clé API Claude, fonctionne aussi sur mobile.",
      )
      .addDropdown((d) =>
        d
          .addOption("claude-code", "Claude Code (abonnement)")
          .addOption("anthropic-api", "API Claude (clé)")
          .setValue(s.backend)
          .onChange(async (v) => {
            s.backend = v as Backend;
            await save();
            this.display();
          }),
      );

    if (s.backend === "claude-code") {
      if (!Platform.isDesktopApp) containerEl.createEl("p", { cls: "mod-warning", text: "Claude Code n'est utilisable que sur ordinateur : choisissez l'API sur mobile." });
      new Setting(containerEl)
        .setName("Chemin de claude")
        .setDesc("Laisser vide pour la détection automatique (PATH du shell, ~/.local/bin, Homebrew…).")
        .addText((t) =>
          t
            .setPlaceholder("/opt/homebrew/bin/claude")
            .setValue(s.claudePath)
            .onChange(async (v) => {
              s.claudePath = v.trim();
              await save();
            }),
        );
    } else {
      new Setting(containerEl)
        .setName("Clé API Claude")
        .setDesc("Stockée en clair dans les données du plug-in de ce vault (.obsidian/plugins/course-curator/data.json).")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("sk-ant-…")
            .setValue(s.apiKey)
            .onChange(async (v) => {
              s.apiKey = v.trim();
              await save();
            });
        });
    }

    new Setting(containerEl)
      .setName("Modèle de structuration")
      .setDesc("Comprend les dossiers et conçoit les plans de rangement (raisonnement le plus exigeant).")
      .addText((t) =>
        t.setValue(s.planModel).onChange(async (v) => {
          s.planModel = v.trim() || "claude-opus-5-5";
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Modèle de lecture")
      .setDesc("Lit et résume chaque document, transcrit les photos (gros volume, un modèle plus rapide suffit).")
      .addText((t) =>
        t.setValue(s.digestModel).onChange(async (v) => {
          s.digestModel = v.trim() || "claude-sonnet-5-5";
          await save();
        }),
      );
    new Setting(containerEl).setName("Tester la connexion").addButton((b) =>
      b.setButtonText("Tester").onClick(async () => {
        b.setDisabled(true);
        const error = await plugin.backend().check();
        new Notice(error ? `Vault Curator : ${error}` : `Vault Curator : connexion à ${plugin.backend().name} OK.`);
        b.setDisabled(false);
      }),
    );
    numberSetting(containerEl, "Délai maximal par appel (s)", "", s.timeoutSec, async (v) => ((s.timeoutSec = v), save()));
    numberSetting(containerEl, "Appels en parallèle", "Lecture des documents.", s.concurrency, async (v) => ((s.concurrency = v), save()));
    numberSetting(containerEl, "Fichiers par appel de lecture", "", s.batchSize, async (v) => ((s.batchSize = v), save()));

    new Setting(containerEl).setName("Toi et tes règles").setHeading();
    new Setting(containerEl)
      .setName("À propos de toi")
      .setDesc("Aide Claude à comprendre à quoi servent tes dossiers.")
      .addText((t) => t.setValue(s.profile).onChange(async (v) => ((s.profile = v.trim()), save())));
    new Setting(containerEl)
      .setName("Règles maison")
      .setDesc("Appliquées à tous les dossiers (nommage, profondeur…). Les règles propres à un dossier se construisent dans la discussion de son plan.")
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Rétablir les règles par défaut")
          .onClick(async () => {
            s.guidelines = DEFAULT_GUIDELINES;
            await save();
            this.display();
          }),
      );
    const area = containerEl.createEl("textarea", { cls: "cc-convention" });
    area.value = s.guidelines;
    area.rows = 7;
    area.onchange = async () => {
      s.guidelines = area.value;
      await save();
    };

    new Setting(containerEl).setName("Rangement").setHeading();
    new Setting(containerEl)
      .setName("Niveau d'intervention")
      .setDesc("Jusqu'où Claude peut remanier un dossier déjà partiellement rangé.")
      .addDropdown((d) =>
        d
          .addOption("conservative", "Conservateur — seulement le vrac et les erreurs")
          .addOption("balanced", "Équilibré — garde ce qui fonctionne")
          .addOption("thorough", "Complet — réorganise tout")
          .setValue(s.intervention)
          .onChange(async (v) => ((s.intervention = v as Intervention), save())),
      );
    toggleSetting(containerEl, "Renommer les fichiers au nom opaque", "IMG_2034.jpg → « S03 - Tableau - Black-Scholes.jpg ».", s.renameUnclearFiles, async (v) => ((s.renameUnclearFiles = v), save()));
    new Setting(containerEl)
      .setName("Photos et notes manuscrites")
      .setDesc("Photos de tableau ou de cahier, scans de notes : ce que le plug-in fait de leur contenu.")
      .addDropdown((d) =>
        d
          .addOption("integrate", "Transcrire et intégrer dans la fiche correspondante")
          .addOption("separate", "Transcrire dans une note à part, à côté de la photo")
          .addOption("off", "Ne pas transcrire")
          .setValue(s.handwriting)
          .onChange(async (v) => ((s.handwriting = v as HandwritingMode), save())),
      );
    numberSetting(containerEl, "Pages lues par PDF", "Texte extrait localement pour identifier un PDF.", s.pdfPages, async (v) => ((s.pdfPages = v), save()));

    new Setting(containerEl).setName("Synthèse des cours (dossiers en mode apprentissage)").setHeading();
    textSetting(containerEl, "Dossier des fiches", "Dans chaque séance : les fiches générées (sorties).", s.fichesFolder, async (v) => ((s.fichesFolder = v || "Fiches"), save()));
    textSetting(containerEl, "Dossier des sources", "Dans chaque séance : les documents bruts une fois intégrés (entrées), avec leurs transcriptions.", s.sourcesFolder, async (v) => ((s.sourcesFolder = v || "Sources"), save()));
    new Setting(containerEl)
      .setName("Langue des fiches")
      .setDesc("Automatique : la langue du cours (slides, professeur) pour le corps des fiches ; les explications ajoutées peuvent être en français.")
      .addDropdown((d) =>
        d
          .addOption("auto", "Langue du cours")
          .addOption("en", "Anglais")
          .addOption("fr", "Français")
          .setValue(s.ficheLanguage)
          .onChange(async (v) => ((s.ficheLanguage = v as "auto" | "fr" | "en"), await save())),
      );
    new Setting(containerEl)
      .setName("Modèle de transcription")
      .setDesc("Lit les photos de tableau et de cahier : c'est la lecture la plus difficile, le modèle le plus capable est conseillé.")
      .addText((t) => t.setValue(s.transcriptionModel).onChange(async (v) => ((s.transcriptionModel = v.trim() || "claude-opus-5-5"), save())));
    toggleSetting(containerEl, "Vérifier chaque transcription", "Deuxième lecture de la photo pour corriger la transcription (plus lent, nettement plus fiable).", s.verifyTranscriptions, async (v) => ((s.verifyTranscriptions = v), save()));
    numberSetting(containerEl, "Pages lues par PDF", "Au-delà, le document est seulement survolé et gardé comme référence. Les livres, polys et documents d'un dossier « Ressources » sont survolés au-delà de 40 pages.", s.maxPdfPages, async (v) => ((s.maxPdfPages = v), save()));
    new Setting(containerEl)
      .setName("Gabarit de fiche")
      .setDesc("Structure d'une fiche de révision ; Claude l'adapte au contenu.")
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Rétablir le gabarit par défaut")
          .onClick(async () => {
            s.ficheTemplate = DEFAULT_FICHE_TEMPLATE;
            await save();
            this.display();
          }),
      );
    const tpl = containerEl.createEl("textarea", { cls: "cc-convention" });
    tpl.value = s.ficheTemplate;
    tpl.rows = 14;
    tpl.onchange = async () => {
      s.ficheTemplate = tpl.value;
      await save();
    };

    new Setting(containerEl).setName("Au lancement d'Obsidian").setHeading();
    toggleSetting(containerEl, "Chercher le nouveau matériau", "Repère les documents arrivés dans les dossiers gérés depuis la dernière fois et te le signale.", s.checkOnStart, async (v) => ((s.checkOnStart = v), save()));
    toggleSetting(containerEl, "Proposer l'agrégation directement", "Lance la préparation des plans d'agrégation sans attendre ton clic (tu valides toujours avant toute modification).", s.aggregateOnStart, async (v) => ((s.aggregateOnStart = v), save()));

    new Setting(containerEl).setName("Vault").setHeading();
    textSetting(containerEl, "Boîte de réception", "Dossier où déposer un document sans savoir où il va ; il est attribué au bon dossier géré.", s.inboxFolder, async (v) => ((s.inboxFolder = v), save()));
    textSetting(
      containerEl,
      "Dossiers ignorés",
      "Noms de dossiers jamais lus ni touchés (modèles, pièces jointes…), séparés par des virgules.",
      s.ignoredFolders.join(", "),
      async (v) => ((s.ignoredFolders = v.split(",").map((x) => x.trim()).filter(Boolean)), save()),
    );
    textSetting(containerEl, "Archive des dossiers en mode documents", "Créé dans chaque dossier géré en mode documents ; rien n'est jamais supprimé.", s.archiveFolder, async (v) => ((s.archiveFolder = v || "99 Archive"), save()));
    textSetting(containerEl, "Nom des dashboards", "Pour les nouveaux dossiers ; {name} = nom du dossier.", s.canvasName, async (v) => ((s.canvasName = v || "{name} — Dashboard"), save()));
    textSetting(containerEl, "Nom des index", "Pour les nouveaux dossiers ; {name} = nom du dossier.", s.indexName, async (v) => ((s.indexName = v || "{name} — Index"), save()));

    new Setting(containerEl).setName("Maintenance").setHeading();
    new Setting(containerEl)
      .setName("Oublier les lectures en cache")
      .setDesc("Les documents seront relus par Claude à la prochaine analyse.")
      .addButton((b) =>
        b.setButtonText("Vider").onClick(async () => {
          for (const e of Object.values(plugin.data.ledger)) {
            delete e.digest;
            delete e.digestFp;
          }
          await plugin.saveData(plugin.data);
          new Notice("Cache des lectures vidé.");
        }),
      );
  }
}

function textSetting(el: HTMLElement, name: string, desc: string, value: string, onChange: (v: string) => unknown) {
  new Setting(el)
    .setName(name)
    .setDesc(desc)
    .addText((t) => t.setValue(value).onChange((v) => onChange(v.trim())));
}

function toggleSetting(el: HTMLElement, name: string, desc: string, value: boolean, onChange: (v: boolean) => unknown) {
  new Setting(el)
    .setName(name)
    .setDesc(desc)
    .addToggle((t) => t.setValue(value).onChange(onChange));
}

function numberSetting(el: HTMLElement, name: string, desc: string, value: number, onChange: (v: number) => unknown) {
  new Setting(el)
    .setName(name)
    .setDesc(desc)
    .addText((t) => {
      t.inputEl.type = "number";
      t.setValue(String(value)).onChange((v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) onChange(Math.round(n));
      });
    });
}
