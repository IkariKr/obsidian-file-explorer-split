import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { VaultCopyService } from "./copy-service";
import { MoveDiagnostics } from "./diagnostics";
import { ExplorerTabMoveController, getLeafId, isValidLeftExplorer } from "./explorer-reorder";
import { LastExplorerCloseGuard } from "./last-explorer-close-guard";
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
import { PopoutExplorerRegistry } from "./popout-explorer-registry";
import { createPopoutWindowData, type PanelBounds, type ScreenPoint } from "./popout-utils";
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
  private closeGuard: LastExplorerCloseGuard | null = null;
  private popoutRegistry: PopoutExplorerRegistry | null = null;
  private diagnostics: MoveDiagnostics | null = null;
  private refreshTimer: number | null = null;
  private minimumExplorerTimer: number | null = null;
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
    this.closeGuard = new LastExplorerCloseGuard(this.app);
    this.popoutRegistry = new PopoutExplorerRegistry(this.app);
    this.popoutRegistry.rebuild();
    this.copyDragController = new ExplorerCopyDragController(
      this.app,
      new VaultCopyService(this.app),
      () => this.getInteractiveExplorerLeaves(),
    );
    this.moveController = new ExplorerTabMoveController(
      this.app,
      () => this.getInteractiveExplorerLeaves(),
      (leaf) => this.popoutRegistry?.has(leaf) ?? false,
      (source, target, placement) => this.moveExplorerLeaf(source, target, placement),
      (source, point, panel) => this.moveExplorerToPopout(source, point, panel),
      (event, details) => this.diagnostics?.log(event, details),
    );

    this.app.workspace.onLayoutReady(() => {
      this.refreshAdapters();
      void this.ensureExplorerTabContainers();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.queueRefresh();
      this.queueMinimumExplorerCheck();
    }));
    this.registerEvent(this.app.workspace.on("window-open", () => {
      this.diagnostics?.log("popout.window-open");
      this.queueRefresh();
    }));
    this.registerEvent(this.app.workspace.on("window-close", () => {
      this.popoutRegistry?.prune();
      this.diagnostics?.log("popout.window-close");
      this.queueRefresh();
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
    this.closeGuard?.unload();
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
    this.closeGuard?.refresh();
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
      this.closeGuard?.refresh();
    }, 50);
  }

  private queueMinimumExplorerCheck(): void {
    if (this.minimumExplorerTimer !== null) {
      return;
    }
    this.minimumExplorerTimer = window.setTimeout(() => {
      this.minimumExplorerTimer = null;
      void this.ensureExplorerTabContainers();
    }, 0);
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
      await this.changeLeftSidebarLayout(layout);
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
    if (source === target || !isValidLeftExplorer(this.app, target)) {
      return false;
    }
    if (!isValidLeftExplorer(this.app, source)) {
      return this.popoutRegistry?.has(source)
        ? this.returnPopoutExplorer(source, target, placement)
        : false;
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

      await this.changeLeftSidebarLayout(layout);
      this.diagnostics?.log("move.layout-applied", {
        sourceId,
        targetId,
        explorersAfterLayout: this.describeExplorerLeaves(),
      });
      const movedLeaf = this.app.workspace.getLeafById(sourceId);
      await this.restoreExplorerStates(explorerStates, sourceId, targetId);
      await this.verifyAndRepairExplorerStates(explorerStates, sourceId, targetId, "immediate");
      this.scheduleExplorerVerification(explorerStates, sourceId, targetId);
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

  private getInteractiveExplorerLeaves(): WorkspaceLeaf[] {
    const leaves = new Map<string, WorkspaceLeaf>();
    for (const leaf of [...getLeftExplorerLeaves(this.app), ...(this.popoutRegistry?.getLeaves() ?? [])]) {
      const leafId = getLeafId(leaf);
      if (leafId) {
        leaves.set(leafId, leaf);
      }
    }
    return [...leaves.values()];
  }

  private async moveExplorerToPopout(
    source: WorkspaceLeaf,
    point: ScreenPoint,
    panel: PanelBounds,
  ): Promise<boolean> {
    if (!isValidLeftExplorer(this.app, source)) {
      return false;
    }
    const sourceId = getLeafId(source);
    const snapshot = captureNativeExplorerState(source);
    const data = createPopoutWindowData(point, panel);
    const duplicate = getLeftExplorerLeaves(this.app).length <= 1;
    this.diagnostics?.log("popout.request", { sourceId, duplicate, point, panel });
    try {
      if (duplicate) {
        const newLeaf = this.app.workspace.openPopoutLeaf(data);
        await newLeaf.setViewState(snapshot.viewState);
        newLeaf.setEphemeralState(snapshot.ephemeralState);
        this.popoutRegistry?.add(newLeaf);
        const report = await restoreNativeExplorerState(newLeaf, snapshot);
        this.diagnostics?.log("popout.created-copy", { sourceId, popoutLeafId: getLeafId(newLeaf), report });
        new Notice("已在独立窗口创建文件列表副本，左侧最后一个文件列表保持不变。");
      } else {
        await this.withExplorerCloseAllowed(() => this.app.workspace.moveLeafToPopout(source, data));
        this.popoutRegistry?.add(source);
        const report = await restoreNativeExplorerState(source, snapshot);
        this.diagnostics?.log("popout.moved", { sourceId, report });
      }
      this.queueRefresh();
      return true;
    } catch (error) {
      this.diagnostics?.error("popout.failed", error, { sourceId, duplicate });
      throw error;
    }
  }

  private async returnPopoutExplorer(
    source: WorkspaceLeaf,
    target: WorkspaceLeaf,
    placement: DropPlacement,
  ): Promise<boolean> {
    if (getLeftExplorerLeaves(this.app).length >= MAX_LEFT_EXPLORERS) {
      new Notice(`左侧边栏最多同时显示 ${MAX_LEFT_EXPLORERS} 个文件列表，无法拖回。`);
      this.diagnostics?.log("popout.return-rejected-max", { sourceId: getLeafId(source), targetId: getLeafId(target) });
      return false;
    }
    const sourceId = getLeafId(source);
    const targetId = getLeafId(target);
    if (!sourceId || !targetId) {
      return false;
    }
    const snapshot = captureNativeExplorerState(source);
    const preservedStates = this.captureLeftExplorerStates();
    const temporaryLeaf = this.app.workspace.createLeafBySplit(target, "vertical");
    const temporaryId = getLeafId(temporaryLeaf);
    if (!temporaryId) {
      temporaryLeaf.detach();
      return false;
    }
    try {
      await temporaryLeaf.setViewState(snapshot.viewState);
      temporaryLeaf.setEphemeralState(snapshot.ephemeralState);
      preservedStates.set(temporaryId, snapshot);
      const layout = JSON.parse(JSON.stringify(this.app.workspace.getLayout())) as WorkspaceLayout;
      if (!moveLeftSidebarLeaf(layout, temporaryId, targetId, placement)) {
        temporaryLeaf.detach();
        this.diagnostics?.log("popout.return-layout-transform-failed", { sourceId, targetId, placement });
        return false;
      }
      await this.changeLeftSidebarLayout(layout);
      await this.restoreExplorerStates(preservedStates, temporaryId, targetId);
      await this.verifyAndRepairExplorerStates(preservedStates, temporaryId, targetId, "immediate");
      this.scheduleExplorerVerification(preservedStates, temporaryId, targetId);
      source.detach();
      this.popoutRegistry?.remove(source);
      this.diagnostics?.log("popout.returned", { sourceId, returnedLeafId: temporaryId, targetId, placement });
      this.queueRefresh();
      return true;
    } catch (error) {
      this.diagnostics?.error("popout.return-failed", error, { sourceId, targetId, placement });
      throw error;
    }
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

  private scheduleExplorerVerification(
    states: Map<string, ReturnType<typeof captureNativeExplorerState>>,
    sourceId: string,
    targetId: string,
  ): void {
    window.setTimeout(() => {
      void this.verifyAndRepairExplorerStates(states, sourceId, targetId, "after-300ms");
    }, 300);
    window.setTimeout(() => {
      void this.verifyAndRepairExplorerStates(states, sourceId, targetId, "after-1000ms");
    }, 1000);
    window.setTimeout(() => {
      void this.verifyAndRepairExplorerStates(states, sourceId, targetId, "after-1800ms");
    }, 1800);
  }

  private async changeLeftSidebarLayout(layout: WorkspaceLayout): Promise<void> {
    await this.withExplorerCloseAllowed(() => this.app.workspace.changeLayout(layout));
  }

  private async withExplorerCloseAllowed<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.closeGuard) {
      return this.closeGuard.withCloseAllowed(action);
    }
    return action();
  }
}
