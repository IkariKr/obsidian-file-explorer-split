import { Notice, Plugin, WorkspaceLeaf, WorkspaceSplit } from "obsidian";
import { VaultCopyService } from "./copy-service";
import { MoveDiagnostics } from "./diagnostics";
import { ExplorerTabMoveController, getLeafId, isValidLeftExplorer } from "./explorer-reorder";
import {
  ensureLeftExplorersUseTabs,
  moveLeftSidebarLeaf,
  type DropPlacement,
  type WorkspaceLayout,
} from "./layout-swap";
import {
  ExplorerCopyDragController,
  ExplorerHeaderControl,
  captureNativeExplorerState,
  compareNativeExplorerState,
  getLeftExplorerLeaves,
  isLeafInLeftSidebar,
  isNativeExplorer,
  restoreNativeExplorerState,
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
  private moveController: ExplorerTabMoveController | null = null;
  private diagnostics: MoveDiagnostics | null = null;
  private refreshTimer: number | null = null;
  private minimumExplorerTimer: number | null = null;
  private isRestoringMinimumExplorer = false;
  private isNormalizingExplorerTabs = false;

  async onload(): Promise<void> {
    this.diagnostics = new MoveDiagnostics(this.app, this.manifest.id);
    try {
      await this.diagnostics.start();
    } catch (error) {
      console.error("[File Explorer Split] Failed to start diagnostics", error);
    }
    await this.loadSettings();
    this.addSettingTab(new FileExplorerSplitSettingTab(this.app, this));
    this.addCommand({
      id: "split-current-file-explorer",
      name: "Split current file explorer",
      callback: () => void this.splitCurrentFileExplorer(),
    });
    this.addCommand({
      id: "show-diagnostic-log-location",
      name: "Show diagnostic log location",
      callback: () => new Notice(`诊断日志：${this.diagnostics?.path ?? "不可用"}`),
    });
    this.headerControl = new ExplorerHeaderControl(this.app, this, () => {
      void this.splitCurrentFileExplorer();
    });
    this.copyDragController = new ExplorerCopyDragController(this.app, new VaultCopyService(this.app));
    this.moveController = new ExplorerTabMoveController(this.app, (source, target, placement) =>
      this.moveExplorerLeaf(source, target, placement),
    );

    this.app.workspace.onLayoutReady(() => {
      this.refreshAdapters();
      void this.ensureMinimumExplorer();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.queueRefresh();
      this.queueMinimumExplorerCheck();
    }));
  }

  onunload(): void {
    this.diagnostics?.log("session.unloading");
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    if (this.minimumExplorerTimer !== null) {
      window.clearTimeout(this.minimumExplorerTimer);
    }
    this.headerControl?.unload();
    this.copyDragController?.unload();
    this.moveController?.unload();
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
    this.moveController?.refresh();
  }

  private queueRefresh(): void {
    if (this.refreshTimer !== null) {
      return;
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.headerControl?.refresh();
      this.copyDragController?.refresh();
      this.moveController?.refresh();
    }, 50);
  }

  private queueMinimumExplorerCheck(): void {
    if (this.minimumExplorerTimer !== null || this.isRestoringMinimumExplorer) {
      return;
    }
    this.minimumExplorerTimer = window.setTimeout(() => {
      this.minimumExplorerTimer = null;
      void this.ensureMinimumExplorer();
    }, 0);
  }

  private async ensureMinimumExplorer(): Promise<void> {
    if (this.isRestoringMinimumExplorer) {
      return;
    }
    if (getLeftExplorerLeaves(this.app).length === 0) {
      this.isRestoringMinimumExplorer = true;
      try {
        const leaf = this.app.workspace.createLeafInParent(this.app.workspace.leftSplit as WorkspaceSplit, 0);
        await leaf.setViewState({
          type: FILE_EXPLORER_VIEW_TYPE,
          state: {},
          active: false,
        });
        new Notice("已保留一个左侧文件列表，不能全部关闭。");
      } catch (error) {
        console.error("[File Explorer Split] Failed to restore the last explorer", error);
        new Notice("无法恢复最后一个文件列表。请重新打开文件列表视图。");
      } finally {
        this.isRestoringMinimumExplorer = false;
      }
    }
    await this.ensureExplorerTabContainers();
    this.queueRefresh();
  }

  private async ensureExplorerTabContainers(): Promise<void> {
    if (this.isNormalizingExplorerTabs) {
      return;
    }
    const layout = JSON.parse(JSON.stringify(this.app.workspace.getLayout())) as WorkspaceLayout;
    if (!ensureLeftExplorersUseTabs(layout)) {
      return;
    }
    this.isNormalizingExplorerTabs = true;
    try {
      await this.app.workspace.changeLayout(layout);
    } catch (error) {
      console.error("[File Explorer Split] Failed to normalize file explorer tab containers", error);
    } finally {
      this.isNormalizingExplorerTabs = false;
    }
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

  private async moveExplorerLeaf(
    source: WorkspaceLeaf,
    target: WorkspaceLeaf,
    placement: DropPlacement,
  ): Promise<boolean> {
    if (source === target || !isValidLeftExplorer(this.app, source) || !isValidLeftExplorer(this.app, target)) {
      return false;
    }

    const sourceId = getLeafId(source);
    const targetId = getLeafId(target);
    if (!sourceId || !targetId) {
      new Notice("无法识别要移动的文件列表。");
      return false;
    }

    this.diagnostics?.log("move.request", {
      sourceId,
      targetId,
      placement,
      sourceViewState: source.getViewState(),
      targetViewState: target.getViewState(),
      explorersBefore: this.describeExplorerLeaves(),
    });
    try {
      const explorerStates = this.captureLeftExplorerStates();
      const sourceState = explorerStates.get(sourceId) ?? captureNativeExplorerState(source);
      this.diagnostics?.log("move.snapshot", {
        sourceId,
        folders: sourceState.folders,
        folderCount: sourceState.folders.length,
        scrollTop: sourceState.scrollTop,
        ephemeralState: sourceState.ephemeralState,
      });
      this.diagnostics?.log("move.all-explorer-snapshots", {
        sourceId,
        explorers: [...explorerStates.entries()].map(([leafId, state]) => ({
          leafId,
          isSource: leafId === sourceId,
          isTarget: leafId === targetId,
          folders: state.folders,
          scrollTop: state.scrollTop,
        })),
      });
      const layout = JSON.parse(JSON.stringify(this.app.workspace.getLayout())) as WorkspaceLayout;
      if (!moveLeftSidebarLeaf(layout, sourceId, targetId, placement)) {
        this.diagnostics?.log("move.layout-transform-failed", { sourceId, targetId, placement });
        new Notice("未能在左侧布局中完成文件列表移动。");
        return false;
      }

      await this.app.workspace.changeLayout(layout);
      this.diagnostics?.log("move.layout-applied", {
        sourceId,
        targetId,
        explorersAfterLayout: this.describeExplorerLeaves(),
      });
      const movedLeaf = this.app.workspace.getLeafById(sourceId);
      await this.restoreExplorerStates(explorerStates, sourceId, targetId);
      await this.verifyAndRepairExplorerStates(explorerStates, sourceId, targetId, "immediate");
      window.setTimeout(() => {
        void this.verifyAndRepairExplorerStates(explorerStates, sourceId, targetId, "after-300ms");
      }, 300);
      window.setTimeout(() => {
        void this.verifyAndRepairExplorerStates(explorerStates, sourceId, targetId, "after-1000ms");
      }, 1000);
      window.setTimeout(() => {
        void this.verifyAndRepairExplorerStates(explorerStates, sourceId, targetId, "after-1800ms");
      }, 1800);
      if (movedLeaf) {
        await this.app.workspace.revealLeaf(movedLeaf);
        this.app.workspace.setActiveLeaf(movedLeaf, { focus: true });
      } else {
        this.diagnostics?.log("move.source-leaf-missing-after-layout", { sourceId, targetId });
      }
      this.queueRefresh();
      return true;
    } catch (error) {
      this.diagnostics?.error("move.failed", error, { sourceId, targetId, placement });
      throw error;
    }
  }

  private describeExplorerLeaves(): Array<Record<string, unknown>> {
    return getLeftExplorerLeaves(this.app).map((leaf) => ({
      id: getLeafId(leaf),
      viewState: leaf.getViewState(),
      ephemeralState: leaf.getEphemeralState(),
    }));
  }

  private captureLeftExplorerStates(): Map<string, ReturnType<typeof captureNativeExplorerState>> {
    const states = new Map<string, ReturnType<typeof captureNativeExplorerState>>();
    for (const leaf of getLeftExplorerLeaves(this.app)) {
      const leafId = getLeafId(leaf);
      if (leafId) {
        states.set(leafId, captureNativeExplorerState(leaf));
      }
    }
    return states;
  }

  private async restoreExplorerStates(
    states: Map<string, ReturnType<typeof captureNativeExplorerState>>,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    for (const [leafId, state] of states) {
      const leaf = this.app.workspace.getLeafById(leafId);
      if (!leaf || !isNativeExplorer(leaf) || !isLeafInLeftSidebar(this.app, leaf)) {
        this.diagnostics?.log("move.restore-leaf-missing", { leafId, sourceId, targetId });
        continue;
      }
      try {
        const report = await restoreNativeExplorerState(leaf, state);
        this.diagnostics?.log("move.restore-complete", {
          leafId,
          isSource: leafId === sourceId,
          isTarget: leafId === targetId,
          report,
          restoredViewState: leaf.getViewState(),
        });
      } catch (error) {
        this.diagnostics?.error("move.restore-failed", error, { leafId, sourceId, targetId });
      }
    }
  }

  private async verifyAndRepairExplorerStates(
    states: Map<string, ReturnType<typeof captureNativeExplorerState>>,
    sourceId: string,
    targetId: string,
    stage: "immediate" | "after-300ms" | "after-1000ms" | "after-1800ms",
  ): Promise<void> {
    for (const [leafId, expected] of states) {
      const leaf = this.app.workspace.getLeafById(leafId);
      if (!leaf || !isNativeExplorer(leaf) || !isLeafInLeftSidebar(this.app, leaf)) {
        this.diagnostics?.log("move.restore-verification-leaf-missing", { leafId, sourceId, targetId, stage });
        continue;
      }
      const observed = captureNativeExplorerState(leaf);
      const comparison = compareNativeExplorerState(expected, observed);
      this.diagnostics?.log("move.restore-verification", {
        leafId,
        isSource: leafId === sourceId,
        isTarget: leafId === targetId,
        stage,
        comparison,
        observedFolders: observed.folders,
      });
      if (!this.hasRestoreMismatch(comparison)) {
        continue;
      }
      try {
        const report = await restoreNativeExplorerState(leaf, expected);
        this.diagnostics?.log("move.restore-retry", { leafId, sourceId, targetId, stage, comparison, report });
      } catch (error) {
        this.diagnostics?.error("move.restore-retry-failed", error, { leafId, sourceId, targetId, stage, comparison });
      }
    }
  }

  private hasRestoreMismatch(comparison: ReturnType<typeof compareNativeExplorerState>): boolean {
    return comparison.collapsedMismatches.length > 0
      || comparison.missingVisibleFolders.length > 0
      || Math.abs(comparison.scrollTopDelta) > 2;
  }
}
