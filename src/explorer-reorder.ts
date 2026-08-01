import { App, Notice, WorkspaceLeaf } from "obsidian";
import { getLeftExplorerLeaves, isLeafInLeftSidebar, isNativeExplorer } from "./native-explorer";

export type SwapHandler = (source: WorkspaceLeaf, target: WorkspaceLeaf) => Promise<boolean>;

interface ExplorerHeaderEntry {
  leaf: WorkspaceLeaf;
  header: HTMLElement;
  icon: HTMLElement;
}

interface WorkspaceTabsInternals {
  containerEl?: HTMLElement;
  children?: WorkspaceLeaf[];
}

/** Keeps private workspace-tab DOM compatibility separate from layout swapping. */
export class ExplorerTabReorderController {
  private readonly cleanups = new Map<HTMLElement, () => void>();
  private readonly entriesByIcon = new Map<HTMLElement, ExplorerHeaderEntry>();
  private source: ExplorerHeaderEntry | null = null;
  private target: ExplorerHeaderEntry | null = null;

  constructor(
    private readonly app: App,
    private readonly onSwap: SwapHandler,
  ) {}

  refresh(): void {
    this.entriesByIcon.clear();
    const currentIcons = new Set<HTMLElement>();
    for (const leaf of getLeftExplorerLeaves(this.app)) {
      const entry = this.getHeaderEntry(leaf);
      if (!entry) {
        continue;
      }
      currentIcons.add(entry.icon);
      this.entriesByIcon.set(entry.icon, entry);
      entry.icon.dataset.fileExplorerSplitReorderLeaf = getLeafId(leaf);
      entry.icon.setAttribute("draggable", "true");
      entry.icon.setAttribute("aria-label", "拖动到另一个文件列表图标以交换位置");
      entry.icon.setAttribute("title", "拖动到另一个文件列表图标以交换位置");
      entry.icon.addClass("file-explorer-split-reorder-handle");
      if (!this.cleanups.has(entry.icon)) {
        this.attach(entry);
      }
    }
    for (const [icon, cleanup] of this.cleanups) {
      if (!currentIcons.has(icon) || !icon.isConnected) {
        cleanup();
        this.cleanups.delete(icon);
      }
    }
  }

  unload(): void {
    for (const cleanup of this.cleanups.values()) {
      cleanup();
    }
    this.cleanups.clear();
    this.clearVisualState();
    this.entriesByIcon.clear();
  }

  private attach(entry: ExplorerHeaderEntry): void {
    const onDragStart = (event: DragEvent) => this.startDrag(entry, event);
    const onDragOver = (event: DragEvent) => this.dragOver(event);
    const onDrop = (event: DragEvent) => this.drop(event);
    const onDragEnd = () => this.clearVisualState();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        this.clearVisualState();
      }
    };
    entry.icon.addEventListener("dragstart", onDragStart);
    entry.icon.addEventListener("dragover", onDragOver);
    entry.icon.addEventListener("drop", onDrop);
    entry.icon.addEventListener("dragend", onDragEnd);
    document.addEventListener("keydown", onKeyDown, true);
    this.cleanups.set(entry.icon, () => {
      entry.icon.removeEventListener("dragstart", onDragStart);
      entry.icon.removeEventListener("dragover", onDragOver);
      entry.icon.removeEventListener("drop", onDrop);
      entry.icon.removeEventListener("dragend", onDragEnd);
      document.removeEventListener("keydown", onKeyDown, true);
      entry.icon.removeClass("file-explorer-split-reorder-handle");
      entry.icon.removeAttribute("draggable");
      entry.icon.removeAttribute("data-file-explorer-split-reorder-leaf");
    });
  }

  private startDrag(entry: ExplorerHeaderEntry, event: DragEvent): void {
    if (!event.dataTransfer) {
      return;
    }
    event.stopImmediatePropagation();
    this.clearVisualState();
    this.source = entry;
    entry.header.addClass("file-explorer-split-swap-source");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", getLeafId(entry.leaf));
    event.dataTransfer.setData("application/x-file-explorer-split-leaf", getLeafId(entry.leaf));
  }

  private dragOver(event: DragEvent): void {
    const target = this.entryFromTarget(event.target);
    if (!this.source || !target || target.leaf === this.source.leaf) {
      this.setTarget(null);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    this.setTarget(target);
  }

  private drop(event: DragEvent): void {
    const source = this.source;
    const target = this.entryFromTarget(event.target);
    if (!source || !target || target.leaf === source.leaf) {
      this.clearVisualState();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.clearVisualState();
    void this.onSwap(source.leaf, target.leaf).catch((error: unknown) => {
      console.error("[File Explorer Split] Reorder failed", error);
      new Notice(`交换文件列表失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private getHeaderEntry(leaf: WorkspaceLeaf): ExplorerHeaderEntry | null {
    const parent = leaf.parent as unknown as WorkspaceTabsInternals;
    const root = parent.containerEl;
    const index = (parent.children ?? []).indexOf(leaf);
    if (!root || index < 0) {
      return null;
    }
    const headers = Array.from(root.querySelectorAll<HTMLElement>(
      ":scope > .workspace-tab-header-container .workspace-tab-header",
    ));
    const header = headers[index];
    const icon = header?.querySelector<HTMLElement>(".workspace-tab-header-inner-icon");
    return header && icon ? { leaf, header, icon } : null;
  }

  private entryFromTarget(target: EventTarget | null): ExplorerHeaderEntry | null {
    const element = target instanceof HTMLElement ? target : null;
    const icon = element?.closest<HTMLElement>(".file-explorer-split-reorder-handle");
    return icon ? this.entriesByIcon.get(icon) ?? null : null;
  }

  private setTarget(entry: ExplorerHeaderEntry | null): void {
    if (this.target === entry) {
      return;
    }
    this.target?.header.removeClass("file-explorer-split-swap-target");
    this.target?.header.querySelector(".file-explorer-split-swap-preview")?.remove();
    this.target = entry;
    if (!entry) {
      return;
    }
    entry.header.addClass("file-explorer-split-swap-target");
    const preview = document.createElement("span");
    preview.className = "file-explorer-split-swap-preview";
    preview.setText("⇄ 交换位置");
    entry.header.appendChild(preview);
  }

  private clearVisualState(): void {
    this.source?.header.removeClass("file-explorer-split-swap-source");
    this.source = null;
    this.setTarget(null);
  }
}

export function isValidLeftExplorer(app: App, leaf: WorkspaceLeaf): boolean {
  return isNativeExplorer(leaf) && isLeafInLeftSidebar(app, leaf);
}

export function getLeafId(leaf: WorkspaceLeaf): string {
  const id = (leaf as unknown as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}
