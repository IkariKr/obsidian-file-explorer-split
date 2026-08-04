import type { WorkspaceLeaf } from "obsidian";
import type { NativeExplorerTreeItem, NativeExplorerView } from "./types";

const PENDING_OPEN_TIMEOUT_MS = 1500;

/**
 * 原生文件列表视图的独立选择状态，以稳定的 vault path 表示节点。
 * Independent selection state for a native file explorer, represented by stable vault paths.
 */
export interface NativeExplorerSelectionSnapshot {
  activePath: string | null;
  selectedPaths: string[];
  focusedPath: string | null;
}

/**
 * 选择状态恢复结果，用于能力降级和诊断日志。
 * Selection restore result used for capability fallback and diagnostics.
 */
export interface NativeExplorerSelectionRestoreReport {
  supported: boolean;
  selectedPathsRestored: number;
  activePathRestored: boolean;
  focusedPathRestored: boolean;
  missingPaths: string[];
}

/**
 * 两个选择快照的可诊断比较结果。
 * Diagnostic comparison result for two selection snapshots.
 */
export interface NativeExplorerSelectionComparison {
  matches: boolean;
  selectedPathsMatch: boolean;
  activePathMatch: boolean;
  focusedPathMatch: boolean;
  missingSelectedPaths: string[];
  unexpectedSelectedPaths: string[];
}

/**
 * 文件列表视图的文件夹展开状态，以稳定的 vault path 表示节点。
 * Folder expansion state for a file explorer, represented by stable vault paths.
 */
export interface NativeExplorerFolderSnapshot {
  path: string;
  collapsed: boolean;
}

/**
 * 文件夹展开状态恢复结果，用于兼容降级和诊断。
 * Folder expansion restore result used for compatibility fallback and diagnostics.
 */
export interface NativeExplorerFolderRestoreReport {
  supported: boolean;
  expandedFoldersRestored: number;
  collapsedFoldersRestored: number;
  missingPaths: string[];
}

/**
 * 文件夹恢复任务及其最终完成状态。
 * Folder restore task and its eventual completion state.
 */
export interface NativeExplorerFolderRestoreTask {
  report: NativeExplorerFolderRestoreReport;
  settled: Promise<NativeExplorerFolderRestoreReport>;
  pending: boolean;
}

interface LeafIsolationSnapshot {
  revision: number;
  snapshot: ExplorerIsolationSnapshot;
}

interface PendingFileOpen {
  path: string;
  sourceId: string;
  createdAt: number;
  snapshots: Map<string, LeafIsolationSnapshot>;
}

interface DragSelectionIsolationSession {
  id: number;
  sourceId: string;
  targetId: string | null;
  paths: string[];
  snapshots: Map<string, LeafIsolationSnapshot>;
}

interface ExplorerIsolationRestoreTask {
  pending: boolean;
  report: NativeExplorerSelectionRestoreReport | null;
  settled: Promise<NativeExplorerSelectionRestoreReport>;
}

type InteractiveLeavesProvider = () => WorkspaceLeaf[];
type SelectionLogHandler = (event: string, details?: Record<string, unknown>) => void;

const EMPTY_SELECTION: NativeExplorerSelectionSnapshot = {
  activePath: null,
  selectedPaths: [],
  focusedPath: null,
};

/**
 * Per-view state that must remain independent during global workspace events.
 * 全局工作区事件期间必须保持独立的单个视图状态。
 */
export interface ExplorerIsolationSnapshot {
  selection: NativeExplorerSelectionSnapshot;
  scrollTop: number;
  folders: NativeExplorerFolderSnapshot[];
}

/**
 * 捕获当前文件列表中全部可用文件夹的展开状态，不保留 DOM 引用。
 * Captures all available folder expansion states without retaining DOM references.
 */
export function captureNativeExplorerFolders(
  view: NativeExplorerView | null | undefined,
): NativeExplorerFolderSnapshot[] {
  const navigator = view ? getExplorerNavigator(view) : null;
  const nativeFolders = captureNativeFolderItems(view);
  if (nativeFolders.length > 0) {
    return nativeFolders;
  }

  const folders: NativeExplorerFolderSnapshot[] = [];
  for (const folder of Array.from(navigator?.querySelectorAll<HTMLElement>(".nav-folder") ?? [])) {
    const path = getFolderTitle(folder)?.dataset.path;
    if (path) {
      folders.push({ path, collapsed: folder.classList.contains("is-collapsed") });
    }
  }
  return folders;
}

/**
 * 按文件夹路径恢复展开状态，忽略不存在或暂不可见的节点。
 * Restores folder expansion by path while ignoring missing or temporarily hidden nodes.
 *
 * This synchronous compatibility entry point starts native asynchronous updates
 * but does not wait for them. Runtime isolation uses the settled variant below.
 * 此同步兼容入口会启动原生异步更新但不等待；运行时隔离使用下方可等待版本。
 */
export function restoreNativeExplorerFolders(
  view: NativeExplorerView | null | undefined,
  snapshot: NativeExplorerFolderSnapshot[] | undefined,
): NativeExplorerFolderRestoreReport {
  const task = startNativeExplorerFolderRestore(view, snapshot);
  void task.settled;
  return task.report;
}

/**
 * 启动文件夹恢复并暴露异步完成状态，供滚动校正流程使用。
 * Starts folder restoration and exposes completion for scroll correction.
 */
export function beginNativeExplorerFolderRestore(
  view: NativeExplorerView | null | undefined,
  snapshot: NativeExplorerFolderSnapshot[] | undefined,
): NativeExplorerFolderRestoreTask {
  return startNativeExplorerFolderRestore(view, snapshot);
}

/**
 * 等待原生文件夹折叠/展开和虚拟树节点更新完成。
 * Waits for native folder collapse/expand and virtual-tree updates to finish.
 */
export function restoreNativeExplorerFoldersSettled(
  view: NativeExplorerView | null | undefined,
  snapshot: NativeExplorerFolderSnapshot[] | undefined,
): Promise<NativeExplorerFolderRestoreReport> {
  return startNativeExplorerFolderRestore(view, snapshot).settled;
}

function startNativeExplorerFolderRestore(
  view: NativeExplorerView | null | undefined,
  snapshot: NativeExplorerFolderSnapshot[] | undefined,
): NativeExplorerFolderRestoreTask {
  const desired = snapshot ?? [];
  const navigator = view ? getExplorerNavigator(view) : null;
  if (!navigator) {
    const report = {
      supported: false,
      expandedFoldersRestored: 0,
      collapsedFoldersRestored: 0,
      missingPaths: uniquePaths(desired.map((folder) => folder.path)),
    };
    return { report, settled: Promise.resolve(report), pending: false };
  }

  const states = new Map(desired.map((folder) => [folder.path, folder]));
  const orderedPaths = [...states.keys()].sort(comparePathDepth);
  const actions = createFolderRestoreActions(view ?? undefined, navigator, states, orderedPaths);
  const report: NativeExplorerFolderRestoreReport = {
    supported: true,
    expandedFoldersRestored: actions.filter((action) => !action.collapsed && action.target).length,
    collapsedFoldersRestored: actions.filter((action) => action.collapsed && action.target).length,
    missingPaths: actions.filter((action) => !action.target).map((action) => action.path),
  };

  const task: NativeExplorerFolderRestoreTask = {
    report,
    settled: Promise.resolve(report),
    pending: false,
  };
  const settled = applyFolderRestoreActions(actions, () => {
    task.pending = true;
  }).then(() => ({
    ...report,
    missingPaths: actions.filter((action) => !action.target).map((action) => action.path),
  }));
  task.settled = settled;
  return task;
}

interface FolderRestoreAction {
  path: string;
  collapsed: boolean;
  target: NativeExplorerTreeItem | HTMLElement | null;
}

function createFolderRestoreActions(
  view: NativeExplorerView | undefined,
  navigator: HTMLElement,
  states: Map<string, NativeExplorerFolderSnapshot>,
  orderedPaths: string[],
): FolderRestoreAction[] {
  const actions: FolderRestoreAction[] = [];
  for (const path of orderedPaths) {
    const desired = states.get(path);
    if (!desired) {
      continue;
    }
    const item = view ? getFolderItem(view, path) : null;
    const folder = findFolderByPath(navigator, path);
    const currentCollapsed = item && typeof item.collapsed === "boolean"
      ? item.collapsed
      : folder?.classList.contains("is-collapsed");
    if (currentCollapsed === undefined) {
      actions.push({ path, collapsed: desired.collapsed, target: null });
      continue;
    }
    if (currentCollapsed !== desired.collapsed) {
      actions.push({
        path,
        collapsed: desired.collapsed,
        target: item ?? folder,
      });
    }
  }
  const collapseActions = actions.filter((action) => action.collapsed).reverse();
  const expandActions = actions.filter((action) => !action.collapsed);
  return [...expandActions, ...collapseActions];
}

async function applyFolderRestoreActions(
  actions: FolderRestoreAction[],
  onPending: () => void,
): Promise<void> {
  for (const action of actions) {
    try {
      if (isNativeFolderItem(action.target) && typeof action.target.setCollapsed === "function") {
        const result = action.target.setCollapsed(action.collapsed, false);
        if (isPromiseLike(result)) {
          onPending();
          await result;
        }
        continue;
      }
      const folder = action.target as HTMLElement | null;
      const title = folder ? getFolderTitle(folder) : null;
      if (title && typeof title.click === "function") {
        title.click();
      }
    } catch {
      // 私有运行时字段可能在不同 Obsidian 版本中失效，继续恢复其余视图状态。
      // Private runtime fields can fail across Obsidian versions; continue restoring other state.
    }
  }
}

/**
 * Captures the native file explorer's private selection state without retaining DOM nodes.
 * 捕获原生文件列表的私有选择状态，但不保留 DOM 节点引用。
 */
export function captureNativeExplorerSelection(leaf: WorkspaceLeaf): NativeExplorerSelectionSnapshot {
  const view = getSelectionView(leaf);
  const selectedPaths = uniquePaths(
    [...(view?.tree?.selectedDoms ?? [])]
      .map((item) => getItemPath(item))
      .filter((path): path is string => Boolean(path)),
  );
  return {
    activePath: getItemPath(view?.activeDom ?? view?.tree?.activeDom),
    selectedPaths,
    focusedPath: getItemPath(view?.tree?.focusedItem),
  };
}

/**
 * Restores a native file explorer's selection by resolving paths against its current item map.
 * 根据当前节点映射恢复原生文件列表选择，并忽略已经失效的路径。
 */
export function restoreNativeExplorerSelection(
  leaf: WorkspaceLeaf,
  snapshot: NativeExplorerSelectionSnapshot | undefined,
): NativeExplorerSelectionRestoreReport {
  const view = getSelectionView(leaf);
  const tree = view?.tree;
  const desired = snapshot ?? EMPTY_SELECTION;
  if (
    !view
    || !tree
    || !view.fileItems
    || typeof tree.selectItem !== "function"
    || typeof tree.clearSelectedDoms !== "function"
    || typeof tree.setFocusedItem !== "function"
  ) {
    return {
      supported: false,
      selectedPathsRestored: 0,
      activePathRestored: false,
      focusedPathRestored: false,
      missingPaths: uniquePaths([
        ...desired.selectedPaths,
        ...(desired.activePath ? [desired.activePath] : []),
        ...(desired.focusedPath ? [desired.focusedPath] : []),
      ]),
    };
  }

  clearSelectedItems(view);
  const missingPaths: string[] = [];
  let selectedPathsRestored = 0;
  for (const path of desired.selectedPaths) {
    const item = view.fileItems[path];
    if (!item) {
      missingPaths.push(path);
      continue;
    }
    selectItem(view, item);
    selectedPathsRestored += 1;
  }

  clearActiveItems(view);
  const activeItem = desired.activePath ? view.fileItems[desired.activePath] : undefined;
  if (desired.activePath && !activeItem) {
    missingPaths.push(desired.activePath);
  }
  view.activeDom = activeItem ?? null;
  setTreeActiveItem(view, activeItem ?? null);
  activeItem?.selfEl?.classList.add("is-active");

  const focusedItem = desired.focusedPath ? view.fileItems[desired.focusedPath] : null;
  if (desired.focusedPath && !focusedItem) {
    missingPaths.push(desired.focusedPath);
  }
  setFocusedItem(view, focusedItem);

  return {
    supported: true,
    selectedPathsRestored,
    activePathRestored: !desired.activePath || Boolean(activeItem),
    focusedPathRestored: !desired.focusedPath || Boolean(focusedItem),
    missingPaths: uniquePaths(missingPaths),
  };
}

/**
 * Compares selection paths and active/focused nodes without comparing private node identities.
 * 比较选择路径、当前节点和焦点节点，不比较私有节点对象身份。
 */
export function compareNativeExplorerSelection(
  expected: NativeExplorerSelectionSnapshot,
  observed: NativeExplorerSelectionSnapshot,
): NativeExplorerSelectionComparison {
  const selectedPathsMatch = arraysEqual(expected.selectedPaths, observed.selectedPaths);
  const activePathMatch = expected.activePath === observed.activePath;
  const focusedPathMatch = expected.focusedPath === observed.focusedPath;
  const expectedSelected = new Set(expected.selectedPaths);
  const observedSelected = new Set(observed.selectedPaths);
  return {
    matches: selectedPathsMatch && activePathMatch && focusedPathMatch,
    selectedPathsMatch,
    activePathMatch,
    focusedPathMatch,
    missingSelectedPaths: expected.selectedPaths.filter((path) => !observedSelected.has(path)),
    unexpectedSelectedPaths: observed.selectedPaths.filter((path) => !expectedSelected.has(path)),
  };
}

/**
 * Keeps selection and scroll state independent across plugin-managed native file explorers.
 * 让插件管理的所有原生文件列表保持彼此独立的选择和滚动状态。
 */
export class ExplorerViewIsolationController {
  private readonly cleanups = new Map<HTMLElement, () => void>();
  private readonly states = new Map<string, ExplorerIsolationSnapshot>();
  private readonly revisions = new Map<string, number>();
  private readonly scheduledLeaves = new Set<string>();
  private readonly restoringLeaves = new Set<string>();
  private readonly restoreGenerations = new Map<string, number>();
  private readonly activeRestoreSnapshots = new Map<string, ExplorerIsolationSnapshot>();
  private readonly suppressedAutoReveal = new Map<string, boolean>();
  private pendingOpens: PendingFileOpen[] = [];
  private dragSelectionSession: DragSelectionIsolationSession | null = null;
  private dragSelectionTimer: number | null = null;
  private deferredCaptureAfterDrag = false;
  private dragSelectionSequence = 0;
  private fileOpenSequence = 0;

  constructor(
    private readonly getInteractiveLeaves: InteractiveLeavesProvider,
    private readonly log: SelectionLogHandler = () => undefined,
  ) {}

  /**
   * Attaches handlers to new explorer DOM trees and reapplies session state after layout rebuilds.
   * 为新建的文件列表 DOM 挂接事件，并在布局重建后重新应用会话状态。
   */
  refresh(): void {
    const leaves = this.getLeavesById();
    const activeIds = new Set(leaves.keys());
    const activeContainers = new Set<HTMLElement>();

    for (const [leafId, leaf] of leaves) {
      const view = getSelectionView(leaf);
      if (!view) {
        continue;
      }
      activeContainers.add(view.containerEl);
      const existing = this.states.get(leafId);
      if (existing) {
        this.restoreLeafState(leaf, existing);
      } else {
        this.states.set(leafId, captureExplorerIsolationState(leaf));
        this.revisions.set(leafId, 0);
      }
      if (!this.cleanups.has(view.containerEl)) {
        this.attach(leaf, view);
      }
    }

    for (const [container, cleanup] of this.cleanups) {
      if (!activeContainers.has(container) || !container.isConnected) {
        cleanup();
        this.cleanups.delete(container);
      }
    }
    for (const leafId of this.states.keys()) {
      if (!activeIds.has(leafId)) {
        this.states.delete(leafId);
        this.revisions.delete(leafId);
      }
    }
    this.prunePendingOpens();
  }

  /**
   * Removes all handlers and session state when the plugin unloads.
   * 插件卸载时移除所有事件处理器并清空会话状态。
   */
  unload(): void {
    this.restoreSuppressedAutoReveal();
    for (const cleanup of this.cleanups.values()) {
      cleanup();
    }
    this.cleanups.clear();
    this.states.clear();
    this.revisions.clear();
    this.scheduledLeaves.clear();
    this.restoringLeaves.clear();
    this.restoreGenerations.clear();
    this.activeRestoreSnapshots.clear();
    this.suppressedAutoReveal.clear();
    this.pendingOpens = [];
    this.clearDragSelectionSession();
    this.fileOpenSequence = 0;
  }

  /**
   * Records the pre-open state so a global file-open event can be scoped to its source view.
   * 记录打开文件前的状态，使全局 file-open 事件可以限定到来源视图。
   */
  beginFileOpenInteraction(source: WorkspaceLeaf, path: string): void {
    const sourceId = getLeafId(source);
    if (!sourceId || !path) {
      return;
    }
    const snapshots = new Map<string, LeafIsolationSnapshot>();
    for (const [leafId, leaf] of this.getLeavesById()) {
      const view = getSelectionView(leaf);
      if (leafId === sourceId) {
        this.allowAutoReveal(leafId, view);
      } else {
        this.suppressAutoReveal(leafId, view);
      }
      const snapshot = captureExplorerIsolationState(leaf);
      if (!this.states.has(leafId)) {
        this.states.set(leafId, snapshot);
        this.revisions.set(leafId, 0);
      }
      snapshots.set(leafId, {
        revision: this.revisions.get(leafId) ?? 0,
        snapshot,
      });
    }
    this.pendingOpens.push({
      path,
      sourceId,
      createdAt: Date.now(),
      snapshots,
    });
    this.prunePendingOpens();
  }

  /**
   * Handles Obsidian's global file-open event and restores unrelated explorer selections.
   * 处理 Obsidian 全局 file-open 事件，并恢复无关文件列表的选择状态。
   */
  handleFileOpen(path: string | null | undefined): void {
    const pending = path ? this.consumePendingOpen(path) : undefined;
    const sequence = ++this.fileOpenSequence;
    const restore = () => {
      if (sequence === this.fileOpenSequence) {
        this.restoreAfterFileOpen(pending);
      }
    };
    restore();
    // Event listener order can differ while a native view is being created.
    // 在原生视图创建期间监听器顺序可能变化，因此在当前事件循环末尾再校正一次。
    queueMicrotask(restore);
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(restore);
      });
    }
    this.prunePendingOpens();
  }

  /**
   * Captures a leaf after native click/keyboard handling has completed.
   * 在原生点击或键盘处理完成后捕获指定视图状态。
   */
  rememberLeaf(leaf: WorkspaceLeaf): void {
    const leafId = getLeafId(leaf);
    if (!leafId || this.restoringLeaves.has(leafId)) {
      return;
    }
    this.states.set(leafId, captureExplorerIsolationState(leaf));
    this.revisions.set(leafId, (this.revisions.get(leafId) ?? 0) + 1);
  }

  /**
   * Captures all current leaves after vault rename/delete events update native item maps.
   * 在 vault 重命名/删除事件更新原生节点映射后重新捕获所有视图。
   */
  scheduleCapture(): void {
    if (this.dragSelectionSession) {
      this.deferredCaptureAfterDrag = true;
      return;
    }
    queueMicrotask(() => {
      this.captureCurrentStates();
    });
  }

  /**
   * 在文件拖动开始时保存所有视图的选择状态。
   * Captures every explorer's selection state when a file drag starts.
   */
  beginDragSelection(source: WorkspaceLeaf, paths: string[]): void {
    this.clearDragSelectionSession();
    const sourceId = getLeafId(source);
    if (!sourceId || paths.length === 0) {
      return;
    }
    const snapshots = new Map<string, LeafIsolationSnapshot>();
    for (const [leafId, leaf] of this.getLeavesById()) {
      const snapshot = captureExplorerIsolationState(leaf);
      if (!this.states.has(leafId)) {
        this.states.set(leafId, snapshot);
        this.revisions.set(leafId, 0);
      }
      snapshots.set(leafId, {
        revision: this.revisions.get(leafId) ?? 0,
        snapshot,
      });
    }
    this.dragSelectionSession = {
      id: ++this.dragSelectionSequence,
      sourceId,
      targetId: null,
      paths: uniquePaths(paths),
      snapshots,
    };
    this.deferredCaptureAfterDrag = false;
  }

  /**
   * 记录拖放目标视图；目标视图保留 Obsidian 原生 drop 选择结果。
   * Records the drop target; the target keeps Obsidian's native drop selection result.
   */
  captureDragDrop(target: WorkspaceLeaf): void {
    const session = this.dragSelectionSession;
    const targetId = getLeafId(target);
    if (session && targetId) {
      session.targetId = targetId;
    }
  }

  /**
   * 恢复源视图和非目标视图的选择、焦点及文件夹状态，但不改变滚动位置。
   * Restores source and non-target selection, focus, and folders without changing scroll positions.
   */
  restoreDragSelection(): void {
    const session = this.dragSelectionSession;
    if (!session?.targetId) {
      return;
    }
    const leaves = this.getLeavesById();
    for (const [leafId, leaf] of leaves) {
      if (leafId === session.targetId) {
        continue;
      }
      const before = session.snapshots.get(leafId);
      if (!before) {
        continue;
      }
      this.restoreLeafState(leaf, before.snapshot);
    }
    this.captureCurrentStates();
  }

  /**
   * 在普通移动或异步复制完成后完成拖放选择会话，并延迟清理以覆盖最后一次树刷新。
   * Completes a drag selection session and delays cleanup to cover the final tree refresh.
   */
  completeDragSelection(): void {
    const session = this.dragSelectionSession;
    if (!session) {
      return;
    }
    this.restoreDragSelection();
    const sessionId = session.id;
    if (this.dragSelectionTimer !== null) {
      window.clearTimeout(this.dragSelectionTimer);
    }
    this.dragSelectionTimer = window.setTimeout(() => {
      this.dragSelectionTimer = null;
      if (this.dragSelectionSession?.id !== sessionId) {
        return;
      }
      this.restoreDragSelection();
      this.clearDragSelectionSession();
      if (this.deferredCaptureAfterDrag) {
        this.deferredCaptureAfterDrag = false;
        this.captureCurrentStates();
      }
    }, 450);
  }

  /**
   * 取消未发生 drop 的拖动会话，不修改当前原生选择。
   * Cancels a drag session with no drop without changing the current native selection.
   */
  cancelDragSelection(): void {
    this.clearDragSelectionSession();
  }

  /**
   * 放下后用户主动交互时取消尾部选择恢复；拖动尚未放下时保留保护快照。
   * Cancels trailing selection restoration after drop while preserving a pre-drop session.
   */
  cancelDragSelectionAfterUserInput(): void {
    if (this.dragSelectionSession?.targetId) {
      this.clearDragSelectionSession();
    }
  }

  /**
   * Copies a source selection to a newly created leaf before the two views diverge.
   * 将来源视图选择复制到新建视图，之后两个视图再独立变化。
   */
  initializeLeafFrom(source: WorkspaceLeaf, target: WorkspaceLeaf): void {
    const targetId = getLeafId(target);
    if (!targetId) {
      return;
    }
    const snapshot = captureExplorerIsolationState(source);
    this.states.set(targetId, cloneIsolationSnapshot(snapshot));
    this.revisions.set(targetId, 0);
    this.restoreLeafState(target, snapshot);
  }

  private attach(leaf: WorkspaceLeaf, view: NativeExplorerView): void {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) {
        return;
      }
      this.cancelLeafRestore(leaf);
      if (isFolderTarget(event.target)) {
        return;
      }
      const path = filePathFromTarget(event.target);
      if (path) {
        this.beginFileOpenInteraction(leaf, path);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const opensWithArrow = (event.key === "ArrowUp" || event.key === "ArrowDown")
        && (event.ctrlKey || event.metaKey);
      if (event.key !== "Enter" && !opensWithArrow) {
        return;
      }
      if (isNativeFolderItem(view.tree?.focusedItem)) {
        this.cancelLeafRestore(leaf);
        return;
      }
      const path = getItemPath(view.tree?.focusedItem)
        ?? filePathFromTarget(view.containerEl.ownerDocument.activeElement);
      if (path) {
        this.beginFileOpenInteraction(leaf, path);
      }
    };
    const onClick = (event: MouseEvent) => this.scheduleRemember(leaf, isFolderTarget(event.target));
    const onKeyUp = (event: KeyboardEvent) => this.scheduleRemember(leaf, isFolderTarget(event.target));
    const navigator = getExplorerNavigator(view);
    const onScroll = () => this.rememberScrollPosition(leaf);
    const onWheel = () => this.cancelLeafRestore(leaf);

    view.containerEl.addEventListener("pointerdown", onPointerDown, true);
    view.containerEl.addEventListener("keydown", onKeyDown, true);
    view.containerEl.addEventListener("click", onClick, true);
    view.containerEl.addEventListener("keyup", onKeyUp, true);
    view.containerEl.addEventListener("wheel", onWheel, true);
    navigator?.addEventListener("scroll", onScroll, { passive: true });
    this.cleanups.set(view.containerEl, () => {
      view.containerEl.removeEventListener("pointerdown", onPointerDown, true);
      view.containerEl.removeEventListener("keydown", onKeyDown, true);
      view.containerEl.removeEventListener("click", onClick, true);
      view.containerEl.removeEventListener("keyup", onKeyUp, true);
      view.containerEl.removeEventListener("wheel", onWheel, true);
      navigator?.removeEventListener("scroll", onScroll);
    });
  }

  private scheduleRemember(leaf: WorkspaceLeaf, waitForTreeSettle = false): void {
    const leafId = getLeafId(leaf);
    if (!leafId || this.restoringLeaves.has(leafId) || this.scheduledLeaves.has(leafId)) {
      return;
    }
    this.scheduledLeaves.add(leafId);
    const capture = () => {
      this.scheduledLeaves.delete(leafId);
      if (!this.restoringLeaves.has(leafId) && this.getLeavesById().has(leafId)) {
        this.rememberLeaf(leaf);
      }
    };
    queueMicrotask(() => {
      if (waitForTreeSettle) {
        void waitForAnimationFrames(2).then(capture);
      } else {
        capture();
      }
    });
  }

  private rememberScrollPosition(leaf: WorkspaceLeaf): void {
    const leafId = getLeafId(leaf);
    if (!leafId || this.restoringLeaves.has(leafId)) {
      return;
    }
    const current = this.states.get(leafId) ?? captureExplorerIsolationState(leaf);
    const view = getSelectionView(leaf);
    const scrollTop = view ? getExplorerNavigator(view)?.scrollTop : undefined;
    if (scrollTop === undefined || !Number.isFinite(scrollTop)) {
      return;
    }
    this.states.set(leafId, {
      ...current,
      scrollTop,
    });
    this.revisions.set(leafId, (this.revisions.get(leafId) ?? 0) + 1);
  }

  private captureCurrentStates(): void {
    for (const leaf of this.getLeavesById().values()) {
      const leafId = getLeafId(leaf);
      if (leafId && !this.restoringLeaves.has(leafId)) {
        this.states.set(leafId, captureExplorerIsolationState(leaf));
      }
    }
  }

  private clearDragSelectionSession(): void {
    if (this.dragSelectionTimer !== null) {
      window.clearTimeout(this.dragSelectionTimer);
      this.dragSelectionTimer = null;
    }
    this.dragSelectionSession = null;
    this.deferredCaptureAfterDrag = false;
  }

  private restoreAfterFileOpen(pending: PendingFileOpen | undefined): void {
    const leaves = this.getLeavesById();
    for (const [leafId, leaf] of leaves) {
      let desired: ExplorerIsolationSnapshot | undefined;
      if (pending && leafId === pending.sourceId) {
        desired = undefined;
      } else if (pending) {
        const before = pending.snapshots.get(leafId);
        const currentRevision = this.revisions.get(leafId) ?? 0;
        desired = before && before.revision === currentRevision
          ? before.snapshot
          : this.states.get(leafId);
      } else {
        desired = this.states.get(leafId);
      }

      if (desired) {
        this.restoreLeafState(leaf, desired);
      } else {
        this.states.set(leafId, captureExplorerIsolationState(leaf));
      }
    }
    if (pending) {
      this.restoreSuppressedAutoRevealIfIdle();
    }
  }

  private getLeavesById(): Map<string, WorkspaceLeaf> {
    const leaves = new Map<string, WorkspaceLeaf>();
    for (const leaf of this.getInteractiveLeaves()) {
      const leafId = getLeafId(leaf);
      if (leafId) {
        leaves.set(leafId, leaf);
      }
    }
    return leaves;
  }

  private consumePendingOpen(path: string): PendingFileOpen | undefined {
    this.prunePendingOpens();
    for (let index = this.pendingOpens.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingOpens[index];
      if (pending.path === path) {
        this.pendingOpens.splice(index, 1);
        return pending;
      }
    }
    return undefined;
  }

  private prunePendingOpens(): void {
    const cutoff = Date.now() - PENDING_OPEN_TIMEOUT_MS;
    this.pendingOpens = this.pendingOpens.filter((pending) => pending.createdAt >= cutoff);
    this.restoreSuppressedAutoRevealIfIdle();
  }

  private suppressAutoReveal(leafId: string, view: NativeExplorerView | null): void {
    if (!view || typeof view.autoRevealFile !== "boolean") {
      return;
    }
    if (!this.suppressedAutoReveal.has(leafId)) {
      this.suppressedAutoReveal.set(leafId, view.autoRevealFile);
    }
    view.autoRevealFile = false;
  }

  private allowAutoReveal(leafId: string, view: NativeExplorerView | null): void {
    if (!view || !this.suppressedAutoReveal.has(leafId)) {
      return;
    }
    view.autoRevealFile = this.suppressedAutoReveal.get(leafId) ?? false;
    this.suppressedAutoReveal.delete(leafId);
  }

  private restoreSuppressedAutoRevealIfIdle(): void {
    if (this.pendingOpens.length > 0) {
      return;
    }
    this.restoreSuppressedAutoReveal();
  }

  private restoreSuppressedAutoReveal(): void {
    const leaves = this.getLeavesById();
    for (const [leafId, originalValue] of this.suppressedAutoReveal) {
      const view = getSelectionView(leaves.get(leafId));
      if (view && typeof view.autoRevealFile === "boolean") {
        view.autoRevealFile = originalValue;
      }
      this.suppressedAutoReveal.delete(leafId);
    }
  }

  private logUnsupported(leafId: string, report: NativeExplorerSelectionRestoreReport): void {
    if (!report.supported) {
      this.log("selection.unsupported", { leafId, missingPaths: report.missingPaths });
    }
  }

  private restoreLeafState(leaf: WorkspaceLeaf, snapshot: ExplorerIsolationSnapshot): void {
    const leafId = getLeafId(leaf);
    if (!leafId) {
      return;
    }
    if (this.restoringLeaves.has(leafId) && this.activeRestoreSnapshots.get(leafId) === snapshot) {
      return;
    }
    this.cancelLeafRestore(leaf);
    const generation = (this.restoreGenerations.get(leafId) ?? 0) + 1;
    this.restoreGenerations.set(leafId, generation);
    this.restoringLeaves.add(leafId);
    this.activeRestoreSnapshots.set(leafId, snapshot);
    const task = beginRestoreExplorerIsolationState(leaf, snapshot);
    const finish = (report: NativeExplorerSelectionRestoreReport) => {
      if (this.restoreGenerations.get(leafId) !== generation || !this.getLeavesById().has(leafId)) {
        return;
      }
      this.restoringLeaves.delete(leafId);
      this.activeRestoreSnapshots.delete(leafId);
      this.logUnsupported(leafId, report);
      this.states.set(leafId, captureExplorerIsolationState(leaf));
    };
    if (task.pending) {
      void task.settled.then(finish);
      return;
    }
    finish(task.report as NativeExplorerSelectionRestoreReport);
  }

  private cancelLeafRestore(leaf: WorkspaceLeaf): void {
    const leafId = getLeafId(leaf);
    if (!leafId) {
      return;
    }
    this.restoreGenerations.set(leafId, (this.restoreGenerations.get(leafId) ?? 0) + 1);
    this.restoringLeaves.delete(leafId);
    this.activeRestoreSnapshots.delete(leafId);
  }
}

function getSelectionView(leaf: WorkspaceLeaf | undefined): NativeExplorerView | null {
  const view = leaf?.view as unknown as Partial<NativeExplorerView> | undefined;
  return isHtmlElement(view?.containerEl) ? view as NativeExplorerView : null;
}

function captureExplorerIsolationState(leaf: WorkspaceLeaf): ExplorerIsolationSnapshot {
  const view = getSelectionView(leaf);
  const navigator = view ? getExplorerNavigator(view) : null;
  return {
    selection: captureNativeExplorerSelection(leaf),
    scrollTop: navigator?.scrollTop ?? 0,
    folders: captureNativeExplorerFolders(view),
  };
}

function beginRestoreExplorerIsolationState(
  leaf: WorkspaceLeaf,
  snapshot: ExplorerIsolationSnapshot,
): ExplorerIsolationRestoreTask {
  const view = getSelectionView(leaf);
  const folderTask = startNativeExplorerFolderRestore(view, snapshot.folders);
  const applySelectionAndScroll = (): NativeExplorerSelectionRestoreReport => {
    const report = restoreNativeExplorerSelection(leaf, snapshot.selection);
    const navigator = view ? getExplorerNavigator(view) : null;
    if (navigator && Number.isFinite(snapshot.scrollTop)) {
      navigator.scrollTop = snapshot.scrollTop;
    }
    return report;
  };

  if (!folderTask.pending) {
    const report = applySelectionAndScroll();
    return {
      pending: false,
      report,
      settled: Promise.resolve(report),
    };
  }

  const settled = folderTask.settled.then(async () => {
    await waitForAnimationFrames(2);
    return applySelectionAndScroll();
  });
  return {
    pending: true,
    report: null,
    settled,
  };
}

function getExplorerNavigator(view: NativeExplorerView): HTMLElement | null {
  const navigator = view.navFileContainerEl ?? view.containerEl;
  return isHtmlElement(navigator) ? navigator : null;
}

function captureNativeFolderItems(
  view: NativeExplorerView | null | undefined,
): NativeExplorerFolderSnapshot[] {
  const fileItems = view?.fileItems;
  if (!fileItems) {
    return [];
  }
  const folders: NativeExplorerFolderSnapshot[] = [];
  for (const [path, item] of Object.entries(fileItems)) {
    if (!isNativeFolderItem(item)) {
      continue;
    }
    const folderPath = item.file?.path ?? path;
    if (folderPath) {
      folders.push({ path: folderPath, collapsed: item.collapsed });
    }
  }
  return folders;
}

function getFolderItem(view: NativeExplorerView, path: string): NativeExplorerTreeItem | null {
  const item = view.fileItems?.[path];
  return isNativeFolderItem(item) ? item : null;
}

function isNativeFolderItem(value: unknown): value is NativeExplorerTreeItem & { collapsed: boolean } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as NativeExplorerTreeItem;
  const file = item.file as unknown as { children?: unknown } | undefined;
  return typeof item.collapsed === "boolean" && Array.isArray(file?.children);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value)
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

function getFolderTitle(folder: HTMLElement): HTMLElement | null {
  return folder.querySelector<HTMLElement>(":scope > .nav-folder-title[data-path]")
    ?? folder.querySelector<HTMLElement>(":scope > [data-path]");
}

function findFolderByPath(container: HTMLElement, path: string): HTMLElement | null {
  return Array.from(container.querySelectorAll<HTMLElement>(".nav-folder"))
    .find((folder) => getFolderTitle(folder)?.dataset.path === path) ?? null;
}

function getItemPath(item: NativeExplorerTreeItem | null | undefined): string | null {
  const path = item?.file?.path ?? item?.selfEl?.dataset.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function clearSelectedItems(view: NativeExplorerView): void {
  const tree = view.tree;
  tree?.clearSelectedDoms?.();
}

function selectItem(view: NativeExplorerView, item: NativeExplorerTreeItem): void {
  view.tree?.selectItem?.(item);
}

function clearActiveItems(view: NativeExplorerView): void {
  view.activeDom?.selfEl?.classList.remove("is-active");
  view.tree?.activeDom?.selfEl?.classList.remove("is-active");
  for (const element of Array.from(view.containerEl.querySelectorAll<HTMLElement>("[data-path].is-active"))) {
    element.classList.remove("is-active");
  }
}

/**
 * 当 Obsidian 暴露该私有字段时，同步其重复的活动节点引用。
 * Keeps Obsidian's duplicate active-node references aligned when the private field exists.
 */
function setTreeActiveItem(view: NativeExplorerView, item: NativeExplorerTreeItem | null): void {
  const tree = view.tree;
  if (!tree || !("activeDom" in tree)) {
    return;
  }
  try {
    tree.activeDom = item;
  } catch {
    // 旧版本可能将该字段暴露为只读，此时仍保留视觉状态恢复能力。
    // Older builds may expose the field as read-only; visual state restoration still works.
  }
}

function setFocusedItem(view: NativeExplorerView, item: NativeExplorerTreeItem | null): void {
  view.tree?.setFocusedItem?.(item, false);
}

function filePathFromTarget(target: EventTarget | null): string | null {
  const element = asHtmlElement(target);
  const fileTitle = element?.closest<HTMLElement>(".nav-file-title");
  return fileTitle?.dataset.path ?? null;
}

function isFolderTarget(target: EventTarget | null): boolean {
  return Boolean(asHtmlElement(target)?.closest<HTMLElement>(".nav-folder-title"));
}

function waitForAnimationFrames(count: number): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  let promise = Promise.resolve();
  for (let index = 0; index < count; index += 1) {
    promise = promise.then(() => new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    }));
  }
  return promise;
}

function getLeafId(leaf: WorkspaceLeaf): string {
  const id = (leaf as unknown as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

function cloneSelection(snapshot: NativeExplorerSelectionSnapshot): NativeExplorerSelectionSnapshot {
  return {
    activePath: snapshot.activePath,
    selectedPaths: [...snapshot.selectedPaths],
    focusedPath: snapshot.focusedPath,
  };
}

function cloneIsolationSnapshot(snapshot: ExplorerIsolationSnapshot): ExplorerIsolationSnapshot {
  return {
    selection: cloneSelection(snapshot.selection),
    scrollTop: snapshot.scrollTop,
    folders: snapshot.folders.map((folder) => ({ ...folder })),
  };
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function comparePathDepth(left: string, right: string): number {
  const depthDelta = left.split("/").length - right.split("/").length;
  return depthDelta !== 0 ? depthDelta : left.localeCompare(right);
}

function asHtmlElement(value: EventTarget | null | undefined): HTMLElement | null {
  return value && typeof value === "object" && (value as Node).nodeType === 1
    ? value as HTMLElement
    : null;
}

function isHtmlElement(value: unknown): value is HTMLElement {
  return value !== null && typeof value === "object" && (value as Node).nodeType === 1;
}
