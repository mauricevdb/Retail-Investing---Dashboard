import { App, FuzzySuggestModal, Modal, Setting } from "obsidian";
import { SpaceMode } from "../core/settings";

/** Picks a folder of the vault ("" = root). */
export class FolderPicker extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private readonly folders: string[],
    private readonly onPick: (folder: string) => void,
    placeholder = "Choisir un dossier",
    private readonly labels: Map<string, string> = new Map(),
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getItems() {
    return this.folders;
  }
  getItemText(folder: string) {
    return this.labels.get(folder) ?? (folder || "/ (tout le vault)");
  }
  onChooseItem(folder: string) {
    this.onPick(folder);
  }
}

export type AddChoice = { action: "organise" | "add"; instructions: string; mode: SpaceMode; level?: "course" | "programme" } | null;

/** Asks what the folder is about before managing it; the answer guides Claude's understanding. */
export class AddSpaceModal extends Modal {
  private instructions = "";
  private mode: SpaceMode = "learning";
  private level: "course" | "programme" = "course";
  private resolve!: (c: AddChoice) => void;
  private done = false;

  constructor(
    app: App,
    private readonly folder: string,
    initial = "",
    private readonly editOnly = false,
  ) {
    super(app);
    this.instructions = initial;
  }

  ask(): Promise<AddChoice> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(c: AddChoice) {
    if (this.done) return;
    this.done = true;
    this.resolve(c);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) {
      this.done = true;
      this.resolve(null);
    }
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(this.editOnly ? `Consignes — ${this.folder || "tout le vault"}` : `Organiser « ${this.folder || "tout le vault"} »`);
    contentEl.createEl("p", {
      text: "En une ou deux phrases : à quoi sert ce dossier, comment tu t'en sers, ce que tu attends du rangement. Facultatif — Claude le déduit sinon du contenu, et tu pourras corriger sa compréhension dans le plan.",
      cls: "cc-muted",
    });
    const area = contentEl.createEl("textarea", {
      cls: "cc-instructions",
      attr: { rows: "4", placeholder: "Ex. : « Mes papiers administratifs ; je dois retrouver vite un justificatif. » ou « Mon projet de mémoire, à rendre en juin. »" },
    });
    area.value = this.instructions;
    area.oninput = () => (this.instructions = area.value);
    area.focus();
    if (!this.editOnly) {
      new Setting(contentEl)
        .setName("Type de dossier")
        .setDesc(
          "Cours : les documents bruts deviennent des fiches de révision reliées par un skill tree, puis sont archivés. Plusieurs cours : un sous-dossier par cours, chacun avec son propre skill tree. Documents : rangement et renommage des fichiers.",
        )
        .addDropdown((d) =>
          d
            .addOption("course", "Un cours")
            .addOption("programme", "Plusieurs cours (un sous-dossier par cours)")
            .addOption("files", "Documents (rangement)")
            .setValue(this.mode === "files" ? "files" : this.level)
            .onChange((v) => {
              this.mode = v === "files" ? "files" : "learning";
              if (v !== "files") this.level = v as "course" | "programme";
            }),
        );
    }

    const s = new Setting(contentEl);
    if (this.editOnly) {
      s.addButton((b) => b.setButtonText("Enregistrer").setCta().onClick(() => this.finish({ action: "add", instructions: this.instructions.trim(), mode: this.mode, level: this.level })));
    } else {
      s.addButton((b) => b.setButtonText("Ajouter seulement").onClick(() => this.finish({ action: "add", instructions: this.instructions.trim(), mode: this.mode, level: this.level })));
      s.addButton((b) =>
        b
          .setButtonText("Ajouter et organiser")
          .setCta()
          .onClick(() => this.finish({ action: "organise", instructions: this.instructions.trim(), mode: this.mode, level: this.level })),
      );
    }
  }
}
