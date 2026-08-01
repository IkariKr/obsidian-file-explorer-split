import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { VaultCopyService } from "./copy-service";
import {
  ExplorerCopyDragController,
  ExplorerHeaderControl,
  getLeftExplorerLeaves,
  isLeafInLeftSidebar,
  isNativeExplorer,
} from "./native-explorer";
import {
  DEFAULT_SETTINGS,
  FileExplorerSplitSettingTab,
  type FileExplorerSplitSettings,
} from "./settings";
import { FILE_EXPLORER_VIEW_TYPE } from "./types";

const MAX_LEFT_EXPLORERS = 4;

export default class FileExplorerSplitPlugin extends Plugin {
  settings: FileExplorerSplitSettings = DEFAULT_SETTINGS;

  private headerControl: ExplorerHeaderControl | null = null;
  private copyDragController: ExplorerCopyDragController | null = null;
  private refreshTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new FileExplorerSplitSettingTab(this.app, this));
    this.addCommand({
      id: "split-current-file-explorer",
      name: "Split current file explorer",
      callback: () => void this.splitCurrentFileExplorer(),
    });

    this.headerControl = new ExplorerHeaderControl(this.app, this, () => {
      void this.splitCurrentFileExplorer();
    });
    this.copyDragController = new ExplorerCopyDragController(this.app, new VaultCopyService(this.app));

    this.app.workspace.onLayoutReady(() => this.refreshAdapters());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.queueRefresh()));
  }

  onunload(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.headerControl?.unload();
    this.copyDragController?.unload();
  }

  async updateSettings(settings: FileExplorerSplitSettings): Promise<void> {
    this.settings = settings;
    await this.saveData(settings);
  }

  private async loadSettings(): Promise<void> {
    const stored = await this.loadData() as Partial<FileExplorerSplitSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      defaultDirection: stored?.defaultDirection === "horizontal" ? "horizontal" : "vertical",
    };
  }

  private refreshAdapters(): void {
    this.headerControl?.start();
    this.headerControl?.refresh();
    this.copyDragController?.refresh();
  }

  private queueRefresh(): void {
    if (this.refreshTimer !== null) {
      return;
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.headerControl?.refresh();
      this.copyDragController?.refresh();
    }, 50);
  }

  private async splitCurrentFileExplorer(): Promise<void> {
    const source = this.getPreferredExplorerLeaf();
    if (!source) {
      new Notice("左侧边栏中没有可分栏的文件列表。");
      return;
    }

    if (getLeftExplorerLeaves(this.app).length >= MAX_LEFT_EXPLORERS) {
      new Notice(`左侧边栏最多同时显示 ${MAX_LEFT_EXPLORERS} 个文件列表。`);
      return;
    }

    const sourceState = source.getViewState();
    const clonedState = JSON.parse(JSON.stringify(sourceState.state ?? {})) as Record<string, unknown>;
    const newLeaf = this.app.workspace.createLeafBySplit(source, this.settings.defaultDirection);
    await newLeaf.setViewState({
      type: FILE_EXPLORER_VIEW_TYPE,
      state: clonedState,
      active: true,
    });
    await this.app.workspace.revealLeaf(newLeaf);
    this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
    this.queueRefresh();
  }

  private getPreferredExplorerLeaf(): WorkspaceLeaf | null {
    const active = this.app.workspace.activeLeaf;
    if (active && isNativeExplorer(active) && isLeafInLeftSidebar(this.app, active)) {
      return active;
    }
    return getLeftExplorerLeaves(this.app)[0] ?? null;
  }
}
