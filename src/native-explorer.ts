import { App, Notice, Plugin, TAbstractFile, TFile, TFolder, ViewState, WorkspaceLeaf, setIcon } from "obsidian";
import { VaultCopyService } from "./copy-service";
import { ExplorerDragScrollGuard } from "./drag-scroll-guard";
import {
  captureNativeExplorerSelection,
  compareNativeExplorerSelection,
  captureNativeExplorerFolders,
  restoreNativeExplorerFoldersSettled,
  restoreNativeExplorerSelection,
  type NativeExplorerFolderSnapshot,
  type NativeExplorerSelectionComparison,
  type NativeExplorerSelectionRestoreReport,
  type NativeExplorerSelectionSnapshot,
} from "./explorer-selection";
import { FILE_EXPLORER_VIEW_TYPE, type DragSelection, type NativeExplorerView } from "./types";

type SplitHandler = () => void;

interface PendingCopyDrag extends DragSelection {
  startedAt: number;
}

type DragScrollRestoreHandler = () => void;

/**
 * 拖放选择隔离回调，连接原生拖放与每个视图的选择会话。
 * Drag selection isolation callbacks connecting native drag-and-drop to per-view selection sessions.
 */
export interface ExplorerDragIsolationCallbacks {
  onDragStart?: (source: WorkspaceLeaf, paths: string[]) => void;
  onDrop?: (target: WorkspaceLeaf) => void;
  onDropComplete?: () => void;
  onCancel?: () => void;
  onUserInteraction?: () => void;
}

/**
 * Captured native explorer state used while Obsidian rebuilds a workspace tree.
 * 在 Obsidian 重建工作区树时使用的原生文件列表状态快照。
 */
export interface NativeExplorerStateSnapshot {
  viewState: ViewState;
  ephemeralState: unknown;
  folders: NativeExplorerFolderSnapshot[];
  scrollTop: number;
  selection: NativeExplorerSelectionSnapshot;
}

/**
 * Reports which native explorer state portions were restored.
 * 报告原生文件列表各部分状态的恢复结果。
 */
export interface NativeExplorerRestoreReport {
  navigatorFound: boolean;
  expandedFoldersRestored: number;
  collapsedFoldersRestored: number;
  scrollTop: number;
  selection: NativeExplorerSelectionRestoreReport;
}

/**
 * Compares expected native explorer state with the currently rendered state.
 * 比较预期的原生文件列表状态与当前渲染状态。
 */
export interface NativeExplorerStateComparison {
  expectedFolderCount: number;
  observedFolderCount: number;
  matchedFolders: number;
  collapsedMismatches: Array<{ path: string; expected: boolean; observed: boolean }>;
  missingVisibleFolders: string[];
  missingBecauseAncestorCollapsed: string[];
  unexpectedVisibleFolders: string[];
  expectedScrollTop: number;
  observedScrollTop: number;
  scrollTopDelta: number;
  selection: NativeExplorerSelectionComparison;
}

export function isNativeExplorer(leaf: WorkspaceLeaf): boolean {
  return leaf.getViewState().type === FILE_EXPLORER_VIEW_TYPE;
}

export function isLeafInLeftSidebar(app: App, leaf: WorkspaceLeaf): boolean {
  let current: { parent?: unknown } | undefined = leaf;
  while (current) {
    if (current === app.workspace.leftSplit) {
      return true;
    }
    current = current.parent as { parent?: unknown } | undefined;
  }
  return false;
}

export function getLeftExplorerLeaves(app: App): WorkspaceLeaf[] {
  return app.workspace
    .getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)
    .filter((leaf) => isLeafInLeftSidebar(app, leaf));
}

export function getExplorerView(leaf: WorkspaceLeaf): NativeExplorerView | null {
  const view = leaf.view as unknown as Partial<NativeExplorerView>;
  return isHtmlElement(view.containerEl) ? (view as NativeExplorerView) : null;
}

/** Captures the per-pane state that the core file explorer does not serialize. */
export function captureNativeExplorerState(leaf: WorkspaceLeaf): NativeExplorerStateSnapshot {
  const view = getExplorerView(leaf);
  const navigator = view?.navFileContainerEl ?? view?.containerEl;
  return {
    viewState: cloneState(leaf.getViewState()),
    ephemeralState: cloneState(leaf.getEphemeralState()),
    folders: captureNativeExplorerFolders(view),
    scrollTop: navigator?.scrollTop ?? 0,
    selection: captureNativeExplorerSelection(leaf),
  };
}

/**
 * Compares a captured explorer state with the DOM currently rendered by Obsidian.
 * A descendant hidden under an expected collapsed ancestor is normal, so it is
 * reported separately from a folder that should have been visible but is absent.
 */
export function compareNativeExplorerState(
  expected: NativeExplorerStateSnapshot,
  observed: NativeExplorerStateSnapshot,
): NativeExplorerStateComparison {
  const expectedByPath = new Map(expected.folders.map((folder) => [folder.path, folder]));
  const observedByPath = new Map(observed.folders.map((folder) => [folder.path, folder]));
  const collapsedMismatches: NativeExplorerStateComparison["collapsedMismatches"] = [];
  const missingVisibleFolders: string[] = [];
  const missingBecauseAncestorCollapsed: string[] = [];

  for (const [path, expectedFolder] of expectedByPath) {
    const observedFolder = observedByPath.get(path);
    if (observedFolder) {
      if (expectedFolder.collapsed !== observedFolder.collapsed) {
        collapsedMismatches.push({
          path,
          expected: expectedFolder.collapsed,
          observed: observedFolder.collapsed,
        });
      }
      continue;
    }
    if (hasCollapsedAncestor(path, expectedByPath)) {
      missingBecauseAncestorCollapsed.push(path);
    } else {
      missingVisibleFolders.push(path);
    }
  }

  const unexpectedVisibleFolders = [...observedByPath.keys()]
    .filter((path) => !expectedByPath.has(path));
  return {
    expectedFolderCount: expected.folders.length,
    observedFolderCount: observed.folders.length,
    matchedFolders: expected.folders.length - missingVisibleFolders.length - missingBecauseAncestorCollapsed.length,
    collapsedMismatches,
    missingVisibleFolders,
    missingBecauseAncestorCollapsed,
    unexpectedVisibleFolders,
    expectedScrollTop: expected.scrollTop,
    observedScrollTop: observed.scrollTop,
    scrollTopDelta: observed.scrollTop - expected.scrollTop,
    selection: compareNativeExplorerSelection(expected.selection, observed.selection),
  };
}

/** Restores the source explorer after changeLayout recreates its runtime tree. */
export async function restoreNativeExplorerState(
  leaf: WorkspaceLeaf,
  snapshot: NativeExplorerStateSnapshot,
): Promise<NativeExplorerRestoreReport> {
  if (leaf.isDeferred) {
    await leaf.loadIfDeferred();
  }
  await leaf.setViewState(cloneState(snapshot.viewState));
  leaf.setEphemeralState(cloneState(snapshot.ephemeralState));
  await nextFrame();
  await nextFrame();

  const view = getExplorerView(leaf);
  const navigator = view?.navFileContainerEl ?? view?.containerEl;
  if (!navigator) {
    return {
      navigatorFound: false,
      expandedFoldersRestored: 0,
      collapsedFoldersRestored: 0,
      scrollTop: 0,
      selection: restoreNativeExplorerSelection(leaf, snapshot.selection),
    };
  }
  const folderRestore = await restoreNativeExplorerFoldersSettled(view, snapshot.folders);
  await nextFrame();
  await nextFrame();
  navigator.scrollTop = snapshot.scrollTop;
  const selection = restoreNativeExplorerSelection(leaf, snapshot.selection);
  return {
    navigatorFound: true,
    expandedFoldersRestored: folderRestore.expandedFoldersRestored,
    collapsedFoldersRestored: folderRestore.collapsedFoldersRestored,
    scrollTop: snapshot.scrollTop,
    selection,
  };
}

function hasCollapsedAncestor(path: string, folders: Map<string, NativeExplorerFolderSnapshot>): boolean {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = folders.get(segments.slice(0, index).join("/"));
    if (ancestor?.collapsed) {
      return true;
    }
  }
  return false;
}

function cloneState<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

export class ExplorerHeaderControl {
  constructor(
    private readonly app: App,
    private readonly plugin: Plugin,
    private readonly onSplit: SplitHandler,
  ) {}

  start(): void {
    this.refresh();
  }

  refresh(): void {
    const root = this.getLeftSidebarElement();
    if (!root) {
      return;
    }
    for (const header of Array.from(root.querySelectorAll<HTMLElement>(".workspace-tab-header-container"))) {
      if (header.querySelector(":scope > .file-explorer-split-tab-button")) {
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "clickable-icon file-explorer-split-tab-button";
      button.setAttribute("aria-label", "分栏文件列表");
      button.setAttribute("title", "分栏文件列表");
      setIcon(button, "panel-left-open");
      this.plugin.registerDomEvent(button, "click", () => this.onSplit());
      header.appendChild(button);
    }
  }

  unload(): void {
    this.getLeftSidebarElement()
      ?.querySelectorAll(".file-explorer-split-tab-button")
      .forEach((button) => button.remove());
  }

  private getLeftSidebarElement(): HTMLElement | null {
    const split = this.app.workspace.leftSplit as unknown as { containerEl?: HTMLElement };
    return split.containerEl instanceof HTMLElement ? split.containerEl : null;
  }
}

export class ExplorerCopyDragController {
  private readonly cleanups = new Map<HTMLElement, () => void>();
  private readonly dragScrollGuard: ExplorerDragScrollGuard;
  private pending: PendingCopyDrag | null = null;
  private dragSelection: DragSelection | null = null;
  private dragSessionId: number | null = null;
  private dropSessionId: number | null = null;
  private copyInFlightSessionId: number | null = null;
  private highlighted: HTMLElement | null = null;

  constructor(
    private readonly app: App,
    private readonly copyService: VaultCopyService,
    private readonly getInteractiveLeaves: () => WorkspaceLeaf[] = () => getLeftExplorerLeaves(this.app),
    onDragScrollRestored: DragScrollRestoreHandler = () => undefined,
    private readonly dragIsolation?: ExplorerDragIsolationCallbacks,
  ) {
    this.dragScrollGuard = new ExplorerDragScrollGuard(
      this.getInteractiveLeaves,
      onDragScrollRestored,
    );
  }

  refresh(): void {
    const currentContainers = new Set<HTMLElement>();
    for (const leaf of this.getInteractiveLeaves()) {
      const view = getExplorerView(leaf);
      if (!view) {
        continue;
      }
      currentContainers.add(view.containerEl);
      if (!this.cleanups.has(view.containerEl)) {
        this.attach(leaf, view);
      }
    }

    for (const [container, cleanup] of this.cleanups) {
      if (!currentContainers.has(container) || !container.isConnected) {
        cleanup();
        this.cleanups.delete(container);
      }
    }
  }

  unload(): void {
    for (const cleanup of this.cleanups.values()) {
      cleanup();
    }
    this.cleanups.clear();
    this.dragScrollGuard.unload();
    this.dragIsolation?.onCancel?.();
    this.dragSelection = null;
    this.clearPending();
  }

  private attach(leaf: WorkspaceLeaf, view: NativeExplorerView): void {
    const onDragStart = (event: DragEvent) => this.captureDragStart(leaf, view, event);
    const onDragOver = (event: DragEvent) => this.captureDragOver(leaf, view, event);
    const onDrop = (event: DragEvent) => this.captureDrop(leaf, view, event);
    const onDragEnd = () => {
      const dragSessionId = this.dragSessionId;
      const hasDrop = dragSessionId !== null && this.dropSessionId === dragSessionId;
      if (this.copyInFlightSessionId !== this.dragSessionId) {
        this.dragScrollGuard.completeDrop(this.dragSessionId ?? undefined);
        if (hasDrop) {
          this.dragIsolation?.onDropComplete?.();
        } else {
          this.dragIsolation?.onCancel?.();
        }
      }
      this.dragSessionId = null;
      this.dropSessionId = null;
      this.dragSelection = null;
      this.clearPendingSoon();
    };
    const onPointerDown = () => {
      this.dragScrollGuard.cancelPendingRestore();
      this.dragIsolation?.onUserInteraction?.();
    };
    const onWheel = () => {
      this.dragScrollGuard.cancelPendingRestore();
      this.dragIsolation?.onUserInteraction?.();
    };

    view.containerEl.addEventListener("dragstart", onDragStart, true);
    view.containerEl.addEventListener("dragover", onDragOver, true);
    view.containerEl.addEventListener("drop", onDrop, true);
    view.containerEl.addEventListener("dragend", onDragEnd, true);
    view.containerEl.addEventListener("pointerdown", onPointerDown, true);
    view.containerEl.addEventListener("wheel", onWheel, true);

    this.cleanups.set(view.containerEl, () => {
      view.containerEl.removeEventListener("dragstart", onDragStart, true);
      view.containerEl.removeEventListener("dragover", onDragOver, true);
      view.containerEl.removeEventListener("drop", onDrop, true);
      view.containerEl.removeEventListener("dragend", onDragEnd, true);
      view.containerEl.removeEventListener("pointerdown", onPointerDown, true);
      view.containerEl.removeEventListener("wheel", onWheel, true);
    });
  }

  private captureDragStart(leaf: WorkspaceLeaf, view: NativeExplorerView, event: DragEvent): void {
    this.copyInFlightSessionId = null;
    const selection = this.resolveDraggedSelection(leaf, view, event);
    if (!selection) {
      this.dragSessionId = null;
      this.dropSessionId = null;
      this.dragSelection = null;
      this.dragScrollGuard.cancelPendingRestore();
      this.dragIsolation?.onCancel?.();
      if (!event.ctrlKey) {
        this.clearPending();
      }
      return;
    }

    this.dragSessionId = this.dragScrollGuard.beginDrag();
    this.dropSessionId = null;
    this.dragSelection = selection;
    this.dragIsolation?.onDragStart?.(leaf, selection.paths);
    if (!event.ctrlKey) {
      this.clearPending();
      return;
    }

    this.pending = { ...selection, startedAt: Date.now() };
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
      event.dataTransfer.effectAllowed = "copyMove";
    }
  }

  private captureDragOver(leaf: WorkspaceLeaf, view: NativeExplorerView, event: DragEvent): void {
    if (!this.pending || !event.ctrlKey) {
      return;
    }
    const destination = this.resolveDestinationFolder(view, event.target);
    if (!destination) {
      this.setHighlighted(null);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    this.setHighlighted(this.findDropElement(event.target, view));
  }

  private captureDrop(leaf: WorkspaceLeaf, view: NativeExplorerView, event: DragEvent): void {
    this.dragScrollGuard.captureDrop(this.dragSessionId ?? undefined);
    if (this.dragSessionId !== null && this.dragSelection && this.dropSessionId !== this.dragSessionId) {
      this.dropSessionId = this.dragSessionId;
      this.dragIsolation?.onDrop?.(leaf);
    }
    if (!this.pending || !event.ctrlKey) {
      return;
    }
    const destination = this.resolveDestinationFolder(view, event.target);
    if (!destination) {
      return;
    }

    const pending = this.pending;
    const copySessionId = this.dragSessionId;
    this.copyInFlightSessionId = copySessionId;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.clearPending();

    void this.copyService.copyIntoFolder(pending.files, destination)
      .catch((error: unknown) => {
        console.error("[File Explorer Split] Copy failed", error);
        new Notice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        const ownsCopySession = this.copyInFlightSessionId === copySessionId;
        if (ownsCopySession) {
          this.copyInFlightSessionId = null;
        }
        if (!ownsCopySession) {
          return;
        }
        this.dragScrollGuard.completeDrop(copySessionId ?? undefined);
        if (copySessionId !== null) {
          this.dragIsolation?.onDropComplete?.();
        }
      });
  }

  private resolveDraggedSelection(
    leaf: WorkspaceLeaf,
    view: NativeExplorerView,
    event: DragEvent,
  ): DragSelection | null {
    const selectedPaths = new Set<string>();
    for (const item of view.tree?.selectedDoms ?? []) {
      const path = item.file?.path ?? this.pathFromElement(item.selfEl);
      if (path) {
        selectedPaths.add(path);
      }
    }
    for (const element of Array.from(view.containerEl.querySelectorAll<HTMLElement>(".is-selected[data-path], [aria-selected='true'][data-path]"))) {
      const path = this.pathFromElement(element);
      if (path) {
        selectedPaths.add(path);
      }
    }
    const targetPath = this.pathFromElement(this.findDropElement(event.target, view));
    if (targetPath) {
      selectedPaths.add(targetPath);
    }

    const files = [...selectedPaths]
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter((file): file is TAbstractFile => file instanceof TFile || file instanceof TFolder);
    if (files.length === 0) {
      return null;
    }
    return { leaf, paths: files.map((file) => file.path), files };
  }

  private resolveDestinationFolder(view: NativeExplorerView, target: EventTarget | null): TFolder | null {
    const item = this.findDropElement(target, view);
    const path = this.pathFromElement(item);
    if (path) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFolder) {
        return file;
      }
      if (file instanceof TFile) {
        return file.parent;
      }
    }

    const targetElement = asHtmlElement(target);
    const navigator = view.navFileContainerEl ?? view.containerEl;
    return targetElement && navigator.contains(targetElement) ? this.app.vault.getRoot() : null;
  }

  private findDropElement(target: EventTarget | null, view: NativeExplorerView): HTMLElement | null {
    const element = asHtmlElement(target);
    if (!element) {
      return null;
    }
    const pathElement = element.closest<HTMLElement>("[data-path]");
    return pathElement && view.containerEl.contains(pathElement) ? pathElement : null;
  }

  private pathFromElement(element: HTMLElement | null | undefined): string | null {
    if (!element) {
      return null;
    }
    const pathElement = element.matches("[data-path]")
      ? element
      : element.closest<HTMLElement>("[data-path]");
    return pathElement?.dataset.path ?? null;
  }

  private setHighlighted(element: HTMLElement | null): void {
    if (this.highlighted === element) {
      return;
    }
    this.highlighted?.removeClass("file-explorer-split-copy-target");
    this.highlighted = element;
    this.highlighted?.addClass("file-explorer-split-copy-target");
  }

  private clearPendingSoon(): void {
    window.setTimeout(() => this.clearPending(), 0);
  }

  private clearPending(): void {
    this.pending = null;
    this.setHighlighted(null);
  }
}

function asHtmlElement(value: EventTarget | null | undefined): HTMLElement | null {
  return value && typeof value === "object" && (value as Node).nodeType === 1
    ? value as HTMLElement
    : null;
}

function isHtmlElement(value: unknown): value is HTMLElement {
  return value !== null && typeof value === "object" && (value as Node).nodeType === 1;
}
