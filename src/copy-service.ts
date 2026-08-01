import {
  App,
  Modal,
  Notice,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";

type ConflictResolution = "replace" | "skip" | "cancel";

interface FileCopyTask {
  source: TFile;
  destinationPath: string;
  conflict: boolean;
}

interface CopyPlan {
  foldersToCreate: Set<string>;
  files: FileCopyTask[];
  conflicts: FileCopyTask[];
  blocked: string[];
}

export interface CopyResult {
  copied: number;
  skipped: number;
  blocked: number;
  cancelled: boolean;
}

export class VaultCopyService {
  constructor(private readonly app: App) {}

  async copyIntoFolder(sources: TAbstractFile[], destination: TFolder): Promise<CopyResult> {
    const roots = this.removeNestedSelections(sources);
    const plan: CopyPlan = {
      foldersToCreate: new Set<string>(),
      files: [],
      conflicts: [],
      blocked: [],
    };

    for (const source of roots) {
      this.planCopy(source, destination.path, plan);
    }

    if (plan.files.length === 0 && plan.foldersToCreate.size === 0) {
      this.showPlanFailure(plan);
      return {
        copied: 0,
        skipped: 0,
        blocked: plan.blocked.length,
        cancelled: false,
      };
    }

    let resolution: ConflictResolution = "replace";
    if (plan.conflicts.length > 0) {
      resolution = await CopyConflictModal.ask(this.app, plan.conflicts.map((task) => task.destinationPath));
      if (resolution === "cancel") {
        return {
          copied: 0,
          skipped: 0,
          blocked: plan.blocked.length,
          cancelled: true,
        };
      }
    }

    let copied = 0;
    let skipped = 0;
    const errors: string[] = [];

    const folders = [...plan.foldersToCreate].sort((left, right) => this.depth(left) - this.depth(right));
    for (const path of folders) {
      try {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (!existing) {
          await this.app.vault.createFolder(path);
        }
      } catch (error) {
        errors.push(`${path}: ${this.messageFrom(error)}`);
      }
    }

    for (const task of plan.files) {
      if (task.conflict && resolution === "skip") {
        skipped += 1;
        continue;
      }

      try {
        const bytes = await this.app.vault.readBinary(task.source);
        const existing = this.app.vault.getAbstractFileByPath(task.destinationPath);
        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, bytes);
        } else if (!existing) {
          await this.app.vault.createBinary(task.destinationPath, bytes);
        } else {
          skipped += 1;
          errors.push(`${task.destinationPath}: 目标路径是文件夹，未替换`);
          continue;
        }
        copied += 1;
      } catch (error) {
        errors.push(`${task.destinationPath}: ${this.messageFrom(error)}`);
      }
    }

    if (errors.length > 0) {
      new Notice(`复制完成：${copied} 项成功，${errors.length} 项失败。`);
      console.error("[File Explorer Split] Copy errors", errors);
    } else {
      const notes = [
        `已复制 ${copied} 项`,
        skipped > 0 ? `跳过 ${skipped} 项` : "",
        plan.blocked.length > 0 ? `无法安全处理 ${plan.blocked.length} 项` : "",
      ].filter(Boolean);
      new Notice(notes.join("，"));
    }

    if (plan.blocked.length > 0) {
      console.warn("[File Explorer Split] Skipped unsafe copy paths", plan.blocked);
    }

    return {
      copied,
      skipped,
      blocked: plan.blocked.length,
      cancelled: false,
    };
  }

  private planCopy(source: TAbstractFile, destinationFolderPath: string, plan: CopyPlan): void {
    const destinationPath = this.joinPath(destinationFolderPath, source.name);

    if (source instanceof TFolder) {
      if (destinationFolderPath === source.path || destinationFolderPath.startsWith(`${source.path}/`)) {
        plan.blocked.push(`${source.path} → ${destinationFolderPath}（不能复制到自身或子目录）`);
        return;
      }
      if (destinationPath === source.path) {
        plan.blocked.push(`${source.path}（不能复制到原文件夹）`);
        return;
      }

      const existing = this.app.vault.getAbstractFileByPath(destinationPath);
      if (existing instanceof TFile) {
        plan.blocked.push(`${destinationPath}（目标是同名文件）`);
        return;
      }
      if (!existing) {
        plan.foldersToCreate.add(destinationPath);
      }
      for (const child of source.children) {
        this.planCopy(child, destinationPath, plan);
      }
      return;
    }

    if (!(source instanceof TFile)) {
      return;
    }

    if (destinationPath === source.path) {
      plan.blocked.push(`${source.path}（不能复制到原文件夹）`);
      return;
    }

    const existing = this.app.vault.getAbstractFileByPath(destinationPath);
    if (existing instanceof TFolder) {
      plan.blocked.push(`${destinationPath}（目标是同名文件夹）`);
      return;
    }

    const task: FileCopyTask = {
      source,
      destinationPath,
      conflict: existing instanceof TFile,
    };
    plan.files.push(task);
    if (task.conflict) {
      plan.conflicts.push(task);
    }
  }

  private removeNestedSelections(files: TAbstractFile[]): TAbstractFile[] {
    const unique = new Map(files.map((file) => [file.path, file]));
    return [...unique.values()].filter((file) => {
      return ![...unique.values()].some((possibleParent) => {
        return possibleParent instanceof TFolder
          && possibleParent.path !== file.path
          && file.path.startsWith(`${possibleParent.path}/`);
      });
    });
  }

  private joinPath(parentPath: string, childName: string): string {
    return normalizePath(parentPath ? `${parentPath}/${childName}` : childName);
  }

  private depth(path: string): number {
    return path.split("/").length;
  }

  private showPlanFailure(plan: CopyPlan): void {
    if (plan.blocked.length > 0) {
      new Notice(`未复制：${plan.blocked.length} 项目标不安全或类型不匹配。`);
      console.warn("[File Explorer Split] Copy plan blocked", plan.blocked);
      return;
    }
    new Notice("没有可复制的文件或文件夹。");
  }

  private messageFrom(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

class CopyConflictModal extends Modal {
  private resolved = false;

  private constructor(
    app: App,
    private readonly conflicts: string[],
    private readonly resolveResult: (result: ConflictResolution) => void,
  ) {
    super(app);
  }

  static ask(app: App, conflicts: string[]): Promise<ConflictResolution> {
    return new Promise((resolve) => {
      new CopyConflictModal(app, conflicts, resolve).open();
    });
  }

  onOpen(): void {
    this.titleEl.setText("复制时发现同名文件");
    this.contentEl.createEl("p", {
      text: `目标位置已有 ${this.conflicts.length} 个同名文件。请选择整批处理方式：`,
      cls: "file-explorer-split-conflicts",
    });

    const list = this.contentEl.createEl("ul", { cls: "file-explorer-split-conflict-list" });
    for (const path of this.conflicts.slice(0, 100)) {
      list.createEl("li", { text: path });
    }
    if (this.conflicts.length > 100) {
      list.createEl("li", { text: `……以及另外 ${this.conflicts.length - 100} 项` });
    }

    const actions = this.contentEl.createDiv({ cls: "file-explorer-split-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.finish("cancel"));

    const skip = actions.createEl("button", { text: "全部跳过" });
    skip.addEventListener("click", () => this.finish("skip"));

    const replace = actions.createEl("button", {
      text: "全部替换",
      cls: "mod-warning",
    });
    replace.addEventListener("click", () => this.finish("replace"));
    replace.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolveResult("cancel");
    }
  }

  private finish(result: ConflictResolution): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.resolveResult(result);
    this.close();
  }
}
