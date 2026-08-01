import { App, WorkspaceLeaf, WorkspaceWindow } from "obsidian";
import { getLeafId } from "./explorer-reorder";
import { isNativeExplorer } from "./native-explorer";

/** Tracks only file explorers opened by this plugin in independent windows. */
export class PopoutExplorerRegistry {
  private readonly leafIds = new Set<string>();

  constructor(private readonly app: App) {}

  add(leaf: WorkspaceLeaf): void {
    const leafId = getLeafId(leaf);
    if (leafId) {
      this.leafIds.add(leafId);
    }
  }

  remove(leaf: WorkspaceLeaf): void {
    const leafId = getLeafId(leaf);
    if (leafId) {
      this.leafIds.delete(leafId);
    }
  }

  has(leaf: WorkspaceLeaf): boolean {
    const leafId = getLeafId(leaf);
    return Boolean(leafId && this.leafIds.has(leafId));
  }

  rebuild(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      if (isNativeExplorer(leaf) && leaf.getContainer() instanceof WorkspaceWindow) {
        this.add(leaf);
      }
    }
  }

  getLeaves(): WorkspaceLeaf[] {
    const leaves: WorkspaceLeaf[] = [];
    for (const leafId of this.leafIds) {
      const leaf = this.app.workspace.getLeafById(leafId);
      if (leaf && isNativeExplorer(leaf)) {
        leaves.push(leaf);
      } else {
        this.leafIds.delete(leafId);
      }
    }
    return leaves;
  }

  prune(): void {
    this.getLeaves();
  }
}
