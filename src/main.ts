import { App, FuzzySuggestModal, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { VaultCopyService } from "./copy-service";
import { ExplorerTabReorderController, getLeafId, isValidLeftExplorer } from "./explorer-reorder";
import { swapLeftSidebarLeafNodes, type WorkspaceLayout } from "./layout-swap";
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
  private reorderController: ExplorerTabReorderController | null = null;
  private refreshTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new FileExplorerSplitSettingTab(this.app, this));
    this.addCommand({
      id: "split-current-file-explorer",
      name: "Split current file explorer",
      callback: () => void this.splitCurrentFileExplorer(),
    });
    this.addCommand({
      id: "swap-file-explorer-positions",
      name: "Swap file explorer positions",
      callback: () => this.openSwapPicker(),
    });

    this.headerControl = new ExplorerHeaderControl(this.app, this, () => {
      void this.splitCurrentFileExplorer();
    });
    this.copyDragController = new ExplorerCopyDragController(this.app, new VaultCopyService(this.app));
    this.reorderController = new ExplorerTabReorderController(this.app, (source, target) =>
      this.swapExplorerLeaves(source, target),
    );

    this.app.workspace.onLayoutReady(() => this.refreshAdapters());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.queueRefresh()));
  }

  onunload(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.headerControl?.unload();
    this.copyDragController?.unload();
    this.reorderController?.unload();
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
    this.reorderController?.refresh();
  }

  private queueRefresh(): void {
    if (this.refreshTimer !== null) {
      return;
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.headerControl?.refresh();
      this.copyDragController?.refresh();
      this.reorderController?.refresh();
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

  private openSwapPicker(): void {
    const leaves = getLeftExplorerLeaves(this.app);
    if (leaves.length < 2) {
      new Notice("至少需要两个左侧文件列表才能交换位置。");
      return;
    }
    new ExplorerLeafPickerModal(
      this.app,
      leaves,
      "选择要交换的文件列表",
      (source) => {
        new ExplorerLeafPickerModal(
          this.app,
          leaves.filter((leaf) => leaf !== source),
          "选择目标文件列表",
          (target) => void this.swapExplorerLeaves(source, target),
        ).open();
      },
    ).open();
  }

  private async swapExplorerLeaves(source: WorkspaceLeaf, target: WorkspaceLeaf): Promise<boolean> {
    if (source === target || !isValidLeftExplorer(this.app, source) || !isValidLeftExplorer(this.app, target)) {
      return false;
    }

    const sourceId = getLeafId(source);
    const targetId = getLeafId(target);
    if (!sourceId || !targetId) {
      new Notice("无法识别要交换的文件列表。");
      return false;
    }

    const layout = JSON.parse(JSON.stringify(this.app.workspace.getLayout())) as WorkspaceLayout;
    if (!swapLeftSidebarLeafNodes(layout, sourceId, targetId)) {
      new Notice("未能在左侧布局中找到要交换的文件列表。");
      return false;
    }

    const activeId = this.app.workspace.activeLeaf ? getLeafId(this.app.workspace.activeLeaf) : "";
    await this.app.workspace.changeLayout(layout);
    const activeLeaf = activeId ? this.app.workspace.getLeafById(activeId) : null;
    if (activeLeaf) {
      await this.app.workspace.revealLeaf(activeLeaf);
      this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
    }
    this.queueRefresh();
    return true;
  }
}

class ExplorerLeafPickerModal extends FuzzySuggestModal<WorkspaceLeaf> {
  constructor(
    app: App,
    private readonly leaves: WorkspaceLeaf[],
    placeholder: string,
    private readonly onChoose: (leaf: WorkspaceLeaf) => void,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): WorkspaceLeaf[] {
    return this.leaves;
  }

  getItemText(leaf: WorkspaceLeaf): string {
    const index = this.leaves.indexOf(leaf) + 1;
    return `文件列表 ${index} · ${getLeafId(leaf).slice(-4) || "未知"}`;
  }

  onChooseItem(leaf: WorkspaceLeaf): void {
    this.onChoose(leaf);
  }
}
