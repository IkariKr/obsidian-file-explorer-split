import { App, Notice, WorkspaceLeaf } from "obsidian";
import { getLeftExplorerLeaves, isLeafInLeftSidebar, isNativeExplorer } from "./native-explorer";

interface GuardedLeaf {
  originalDetach: () => void;
  guardedDetach: () => void;
}

/** Prevents the final native file explorer in the left sidebar from closing. */
export class LastExplorerCloseGuard {
  private readonly guardedLeaves = new Map<WorkspaceLeaf, GuardedLeaf>();
  private allowedDepth = 0;

  constructor(private readonly app: App) {}

  refresh(): void {
    const currentLeaves = new Set(getLeftExplorerLeaves(this.app));
    for (const leaf of currentLeaves) {
      this.guard(leaf);
    }
    for (const [leaf, guard] of this.guardedLeaves) {
      if (!currentLeaves.has(leaf)) {
        this.restore(leaf, guard);
      }
    }
  }

  unload(): void {
    for (const [leaf, guard] of this.guardedLeaves) {
      this.restore(leaf, guard);
    }
  }

  async withCloseAllowed<T>(action: () => Promise<T> | T): Promise<T> {
    this.allowedDepth += 1;
    try {
      return await action();
    } finally {
      this.allowedDepth -= 1;
    }
  }

  private guard(leaf: WorkspaceLeaf): void {
    if (this.guardedLeaves.has(leaf)) {
      return;
    }
    const originalDetach = leaf.detach.bind(leaf);
    const guardedDetach = () => {
      if (!this.shouldBlock(leaf)) {
        originalDetach();
        return;
      }
      new Notice("至少保留一个左侧文件列表，无法关闭最后一个。");
    };
    leaf.detach = guardedDetach;
    this.guardedLeaves.set(leaf, { originalDetach, guardedDetach });
  }

  private restore(leaf: WorkspaceLeaf, guard: GuardedLeaf): void {
    if (leaf.detach === guard.guardedDetach) {
      leaf.detach = guard.originalDetach;
    }
    this.guardedLeaves.delete(leaf);
  }

  private shouldBlock(leaf: WorkspaceLeaf): boolean {
    return this.allowedDepth === 0
      && isNativeExplorer(leaf)
      && isLeafInLeftSidebar(this.app, leaf)
      && getLeftExplorerLeaves(this.app).length <= 1;
  }
}
