import type { WorkspaceLeaf } from "obsidian";
import type { NativeExplorerView } from "./types";

interface ExplorerScrollSnapshot {
  leafId: string;
  scrollTop: number;
}

interface DragScrollSession {
  id: number;
  snapshot: ExplorerScrollSnapshot[] | null;
  completed: boolean;
}

type InteractiveLeavesProvider = () => WorkspaceLeaf[];
type ScrollRestoreHandler = () => void;

/**
 * 拖放期间保护所有文件列表的滚动位置，并抵抗原生树的异步重绘。
 * Protects all explorer scroll positions during drag-and-drop and resists asynchronous native tree redraws.
 */
export class ExplorerDragScrollGuard {
  private nextSessionId = 0;
  private session: DragScrollSession | null = null;
  private readonly timers = new Set<number>();

  constructor(
    private readonly getInteractiveLeaves: InteractiveLeavesProvider,
    private readonly onRestored: ScrollRestoreHandler = () => undefined,
  ) {}

  /**
   * 开始新的文件拖放会话，并使旧会话的延迟恢复失效。
   * Starts a new file drag session and invalidates delayed restores from older sessions.
   */
  beginDrag(): number {
    this.clearTimers();
    this.session = null;
    this.session = {
      id: ++this.nextSessionId,
      snapshot: null,
      completed: false,
    };
    return this.session.id;
  }

  /**
   * 在 drop 捕获阶段记录放下瞬间的位置，然后安排多阶段恢复。
   * Captures positions during drop capture and schedules multi-stage restoration.
   */
  captureDrop(sessionId?: number): void {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }
    session.snapshot = this.captureScrollSnapshot();
    this.scheduleRestore(session);
  }

  /**
   * 在原生移动或异步复制完成后再次延长保护窗口。
   * Extends the protection window after native move or asynchronous copy completion.
   */
  completeDrop(sessionId?: number): void {
    const session = this.getSession(sessionId);
    if (!session?.snapshot) {
      return;
    }
    session.completed = true;
    this.scheduleRestore(session);
  }

  /**
   * 用户开始新的交互后取消尾部恢复，避免覆盖用户主动滚动。
   * Cancels trailing restoration after user interaction so intentional scrolling is preserved.
   */
  cancelPendingRestore(): void {
    this.clearTimers();
    if (this.session?.snapshot) {
      this.session = null;
    }
  }

  unload(): void {
    this.clearTimers();
    this.session = null;
  }

  private scheduleRestore(session: DragScrollSession): void {
    this.clearTimers();
    const restore = () => this.restore(session);
    queueMicrotask(restore);
    this.scheduleFrame(() => this.scheduleFrame(restore));
    this.timers.add(this.scheduleTimeout(restore, 100));
    this.timers.add(this.scheduleTimeout(() => {
      restore();
      if (session.completed && this.session?.id === session.id) {
        this.session = null;
      }
    }, 350));
  }

  private restore(session: DragScrollSession): void {
    if (this.session?.id !== session.id || !session.snapshot) {
      return;
    }
    const leaves = new Map<string, WorkspaceLeaf>();
    for (const leaf of this.getInteractiveLeaves()) {
      const leafId = getLeafId(leaf);
      if (leafId) {
        leaves.set(leafId, leaf);
      }
    }
    for (const expected of session.snapshot) {
      const navigator = getExplorerNavigator(leaves.get(expected.leafId));
      if (navigator && Number.isFinite(expected.scrollTop)) {
        navigator.scrollTop = expected.scrollTop;
      }
    }
    this.onRestored();
  }

  private getSession(sessionId: number | undefined): DragScrollSession | null {
    if (!this.session || (sessionId !== undefined && this.session.id !== sessionId)) {
      return null;
    }
    return this.session;
  }

  private captureScrollSnapshot(): ExplorerScrollSnapshot[] {
    const snapshots: ExplorerScrollSnapshot[] = [];
    const seen = new Set<string>();
    for (const leaf of this.getInteractiveLeaves()) {
      const leafId = getLeafId(leaf);
      const navigator = getExplorerNavigator(leaf);
      if (!leafId || seen.has(leafId) || !navigator || !Number.isFinite(navigator.scrollTop)) {
        continue;
      }
      seen.add(leafId);
      snapshots.push({ leafId, scrollTop: navigator.scrollTop });
    }
    return snapshots;
  }

  private scheduleFrame(callback: () => void): void {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(callback);
      return;
    }
    this.timers.add(this.scheduleTimeout(callback, 0));
  }

  private scheduleTimeout(callback: () => void, delay: number): number {
    if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
      return window.setTimeout(callback, delay);
    }
    return globalThis.setTimeout(callback, delay) as unknown as number;
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      if (typeof window !== "undefined" && typeof window.clearTimeout === "function") {
        window.clearTimeout(timer);
      } else {
        globalThis.clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
      }
    }
    this.timers.clear();
  }
}

function getExplorerNavigator(leaf: WorkspaceLeaf | undefined): HTMLElement | null {
  const view = leaf?.view as unknown as Partial<NativeExplorerView> | undefined;
  const navigator = view?.navFileContainerEl ?? view?.containerEl;
  return isHtmlElement(navigator) ? navigator : null;
}

function getLeafId(leaf: WorkspaceLeaf): string {
  const id = (leaf as unknown as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

function isHtmlElement(value: unknown): value is HTMLElement {
  return value !== null && typeof value === "object" && (value as Node).nodeType === 1;
}
