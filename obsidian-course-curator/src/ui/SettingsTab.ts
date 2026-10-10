import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { Backend, DEFAULT_CONVENTION, Intervention } from "../core/settings";
import type CourseCuratorPlugin from "../main";

export class CuratorSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: CourseCuratorPlugin,
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
      .setDesc("Conçoit les skill trees et les plans de rangement (raisonnement le plus exigeant).")
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
        new Notice(error ? `Course Curator : ${error}` : `Course Curator : connexion à ${plugin.backend().name} OK.`);
        b.setDisabled(false);
      }),
    );
    numberSetting(containerEl, "Délai maximal par appel (s)", "", s.timeoutSec, async (v) => ((s.timeoutSec = v), save()));
    numberSetting(containerEl, "Appels en parallèle", "Lecture des documents.", s.concurrency, async (v) => ((s.concurrency = v), save()));
    numberSetting(containerEl, "Fichiers par appel de lecture", "", s.batchSize, async (v) => ((s.batchSize = v), save()));

    new Setting(containerEl).setName("Vault").setHeading();
    textSetting(containerEl, "Dossier des cours", "Chaque sous-dossier direct est un cours. Vide = racine du vault.", s.coursesRoot, async (v) => ((s.coursesRoot = v), save()));
    textSetting(containerEl, "Boîte de réception", "Dossier où déposer un document sans savoir à quel cours il appartient.", s.inboxFolder, async (v) => ((s.inboxFolder = v), save()));
    textSetting(
      containerEl,
      "Dossiers ignorés",
      "Dossiers de premier niveau qui ne sont pas des cours, séparés par des virgules.",
      s.ignoredFolders.join(", "),
      async (v) => ((s.ignoredFolders = v.split(",").map((x) => x.trim()).filter(Boolean)), save()),
    );
    textSetting(containerEl, "Dossier d'archive", "Créé dans chaque cours ; rien n'est jamais supprimé.", s.archiveFolder, async (v) => ((s.archiveFolder = v || "99 Archive"), save()));
    textSetting(containerEl, "Nom du skill tree", "{course} = nom du dossier du cours.", s.canvasName, async (v) => ((s.canvasName = v || "{course} — Skill tree"), save()));
    textSetting(containerEl, "Nom de l'index", "{course} = nom du dossier du cours.", s.indexName, async (v) => ((s.indexName = v || "{course} — Index"), save()));

    new Setting(containerEl).setName("Rangement").setHeading();
    new Setting(containerEl)
      .setName("Niveau d'intervention")
      .setDesc("Jusqu'où Claude peut remanier un cours déjà partiellement rangé.")
      .addDropdown((d) =>
        d
          .addOption("conservative", "Conservateur — seulement le vrac et les erreurs")
          .addOption("balanced", "Équilibré — garde ce qui fonctionne")
          .addOption("thorough", "Complet — applique la convention partout")
          .setValue(s.intervention)
          .onChange(async (v) => ((s.intervention = v as Intervention), save())),
      );
    toggleSetting(containerEl, "Renommer les fichiers au nom opaque", "IMG_2034.jpg → « S03 - Tableau - Black-Scholes.jpg ».", s.renameUnclearFiles, async (v) => ((s.renameUnclearFiles = v), save()));
    toggleSetting(containerEl, "Transcrire les photos", "Crée une note Markdown (formules en LaTeX) à côté de chaque photo de tableau ou de cahier.", s.transcribePhotos, async (v) => ((s.transcribePhotos = v), save()));
    numberSetting(containerEl, "Pages lues par PDF", "Texte extrait localement pour identifier un PDF.", s.pdfPages, async (v) => ((s.pdfPages = v), save()));
    toggleSetting(containerEl, "Signaler les nouveaux documents", "Notification quand des fichiers arrivent dans un cours organisé.", s.watchNewFiles, async (v) => ((s.watchNewFiles = v), save()));

    new Setting(containerEl)
      .setName("Convention de rangement")
      .setDesc("Structure cible proposée à Claude. Modifiez-la librement.")
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Rétablir la convention par défaut")
          .onClick(async () => {
            s.convention = DEFAULT_CONVENTION;
            await save();
            this.display();
          }),
      );
    const area = containerEl.createEl("textarea", { cls: "cc-convention" });
    area.value = s.convention;
    area.rows = 16;
    area.onchange = async () => {
      s.convention = area.value;
      await save();
    };

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
