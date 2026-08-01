import { App, Notice, WorkspaceLeaf } from "obsidian";
import type { DropPlacement } from "./layout-swap";
import { getLeftExplorerLeaves, isLeafInLeftSidebar, isNativeExplorer } from "./native-explorer";

export type MoveHandler = (
  source: WorkspaceLeaf,
  target: WorkspaceLeaf,
  placement: DropPlacement,
) => Promise<boolean>;

interface ExplorerHeaderEntry {
  leaf: WorkspaceLeaf;
  header: HTMLElement;
  tabsRoot: HTMLElement;
  headerContainer: HTMLElement;
}

interface ResolvedDrop {
  entry: ExplorerHeaderEntry;
  placement: DropPlacement;
}

interface WorkspaceTabsInternals {
  containerEl?: HTMLElement;
  children?: WorkspaceLeaf[];
}

/** Private workspace-tab DOM adapter for moving native explorer leaves. */
export class ExplorerTabMoveController {
  private readonly cleanups = new Map<HTMLElement, () => void>();
  private readonly entriesByTabsRoot = new Map<HTMLElement, ExplorerHeaderEntry[]>();
  private rootCleanup: (() => void) | null = null;
  private rootElement: HTMLElement | null = null;
  private source: ExplorerHeaderEntry | null = null;
  private target: ResolvedDrop | null = null;

  constructor(
    private readonly app: App,
    private readonly onMove: MoveHandler,
  ) {}

  refresh(): void {
    this.entriesByTabsRoot.clear();
    const currentHeaders = new Set<HTMLElement>();
    for (const leaf of getLeftExplorerLeaves(this.app)) {
      const entry = this.getHeaderEntry(leaf);
      if (!entry) {
        continue;
      }
      currentHeaders.add(entry.header);
      const groupEntries = this.entriesByTabsRoot.get(entry.tabsRoot) ?? [];
      groupEntries.push(entry);
      this.entriesByTabsRoot.set(entry.tabsRoot, groupEntries);

      const icon = this.getHandle(entry.header);
      if (!icon) {
        continue;
      }
      icon.setAttribute("draggable", "true");
      icon.setAttribute("aria-label", "拖动到文件列表的右侧、下方或标签栏以移动");
      icon.setAttribute("title", "拖动到文件列表的右侧、下方或标签栏以移动");
      icon.addClass("file-explorer-split-move-handle");
      if (!this.cleanups.has(entry.header)) {
        this.attachHandle(entry, icon);
      }
    }

    for (const [header, cleanup] of this.cleanups) {
      if (!currentHeaders.has(header) || !header.isConnected) {
        cleanup();
        this.cleanups.delete(header);
      }
    }
    this.attachRootEvents();
  }

  unload(): void {
    for (const cleanup of this.cleanups.values()) {
      cleanup();
    }
    this.cleanups.clear();
    this.rootCleanup?.();
    this.rootCleanup = null;
    this.rootElement = null;
    this.clearVisualState();
    this.entriesByTabsRoot.clear();
  }

  private attachHandle(entry: ExplorerHeaderEntry, icon: HTMLElement): void {
    const onDragStart = (event: DragEvent) => this.startDrag(entry, event);
    const onDragEnd = () => this.clearVisualState();
    icon.addEventListener("dragstart", onDragStart);
    icon.addEventListener("dragend", onDragEnd);
    this.cleanups.set(entry.header, () => {
      icon.removeEventListener("dragstart", onDragStart);
      icon.removeEventListener("dragend", onDragEnd);
      icon.removeClass("file-explorer-split-move-handle");
      icon.removeAttribute("draggable");
      icon.removeAttribute("aria-label");
      icon.removeAttribute("title");
    });
  }

  private attachRootEvents(): void {
    const root = this.getLeftSidebarElement();
    if (!root) {
      return;
    }
    if (this.rootElement !== root) {
      this.rootCleanup?.();
      this.rootCleanup = null;
      this.rootElement = root;
    }
    if (this.rootCleanup) {
      return;
    }
    const onDragOver = (event: DragEvent) => this.dragOver(event);
    const onDrop = (event: DragEvent) => this.drop(event);
    const onDragLeave = (event: DragEvent) => {
      if (!root.contains(event.relatedTarget as Node | null)) {
        this.setTarget(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        this.clearVisualState();
      }
    };
    root.addEventListener("dragover", onDragOver, true);
    root.addEventListener("drop", onDrop, true);
    root.addEventListener("dragleave", onDragLeave, true);
    document.addEventListener("keydown", onKeyDown, true);
    this.rootCleanup = () => {
      root.removeEventListener("dragover", onDragOver, true);
      root.removeEventListener("drop", onDrop, true);
      root.removeEventListener("dragleave", onDragLeave, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }

  private startDrag(entry: ExplorerHeaderEntry, event: DragEvent): void {
    if (!event.dataTransfer) {
      return;
    }
    event.stopImmediatePropagation();
    this.clearVisualState();
    this.source = entry;
    entry.header.addClass("file-explorer-split-move-source");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-file-explorer-split-leaf", getLeafId(entry.leaf));
    event.dataTransfer.setData("text/plain", getLeafId(entry.leaf));
  }

  private dragOver(event: DragEvent): void {
    const target = this.resolveDrop(event);
    if (!this.source || !target || target.entry.leaf === this.source.leaf) {
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
    const target = this.resolveDrop(event);
    if (!source || !target || target.entry.leaf === source.leaf) {
      this.clearVisualState();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.clearVisualState();
    void this.onMove(source.leaf, target.entry.leaf, target.placement).catch((error: unknown) => {
      console.error("[File Explorer Split] Move failed", error);
      new Notice(`移动文件列表失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private resolveDrop(event: DragEvent): ResolvedDrop | null {
    const element = event.target instanceof HTMLElement ? event.target : null;
    if (!element) {
      return null;
    }
    const tabsRoot = element.closest<HTMLElement>(".workspace-tabs");
    if (!tabsRoot) {
      return null;
    }
    const entry = this.getActiveExplorerEntry(tabsRoot);
    if (!entry) {
      return null;
    }
    if (entry.headerContainer.contains(element)) {
      return { entry, placement: "tab" };
    }
    const content = tabsRoot.querySelector<HTMLElement>(":scope > .workspace-tab-container") ?? tabsRoot;
    if (!content.contains(element)) {
      return null;
    }
    const rect = content.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const isRight = event.clientX >= rect.right - rect.width * 0.3;
    const isBottom = event.clientY >= rect.bottom - rect.height * 0.3;
    if (isRight) {
      return { entry, placement: "right" };
    }
    return isBottom ? { entry, placement: "bottom" } : null;
  }

  private getActiveExplorerEntry(tabsRoot: HTMLElement): ExplorerHeaderEntry | null {
    const entries = this.entriesByTabsRoot.get(tabsRoot) ?? [];
    return entries.find((entry) => entry.header.hasClass("is-active")) ?? null;
  }

  private getHeaderEntry(leaf: WorkspaceLeaf): ExplorerHeaderEntry | null {
    const parent = leaf.parent as unknown as WorkspaceTabsInternals;
    const tabsRoot = parent.containerEl;
    const index = (parent.children ?? []).indexOf(leaf);
    if (!tabsRoot || index < 0) {
      return null;
    }
    const headerContainer = tabsRoot.querySelector<HTMLElement>(":scope > .workspace-tab-header-container");
    const headers = Array.from(tabsRoot.querySelectorAll<HTMLElement>(
      ":scope > .workspace-tab-header-container .workspace-tab-header",
    ));
    const header = headers[index];
    return header && headerContainer ? { leaf, header, tabsRoot, headerContainer } : null;
  }

  private getHandle(header: HTMLElement): HTMLElement | null {
    return header.querySelector<HTMLElement>(".workspace-tab-header-inner-icon");
  }

  private setTarget(target: ResolvedDrop | null): void {
    if (this.target?.entry === target?.entry && this.target?.placement === target?.placement) {
      return;
    }
    this.target?.entry.tabsRoot.removeClass("file-explorer-split-move-target");
    this.target?.entry.tabsRoot.removeClass(`file-explorer-split-move-${this.target?.placement ?? ""}`);
    this.target?.entry.tabsRoot.querySelector(".file-explorer-split-move-preview")?.remove();
    this.target = target;
    if (!target) {
      return;
    }
    target.entry.tabsRoot.addClass("file-explorer-split-move-target");
    target.entry.tabsRoot.addClass(`file-explorer-split-move-${target.placement}`);
    const preview = document.createElement("span");
    preview.className = "file-explorer-split-move-preview";
    preview.setText(target.placement === "tab" ? "合并为标签组" : target.placement === "right" ? "移到右侧" : "移到下方");
    (target.placement === "tab" ? target.entry.headerContainer : target.entry.tabsRoot).appendChild(preview);
  }

  private clearVisualState(): void {
    this.source?.header.removeClass("file-explorer-split-move-source");
    this.source = null;
    this.setTarget(null);
  }

  private getLeftSidebarElement(): HTMLElement | null {
    const split = this.app.workspace.leftSplit as unknown as { containerEl?: HTMLElement };
    return split.containerEl instanceof HTMLElement ? split.containerEl : null;
  }
}

export function isValidLeftExplorer(app: App, leaf: WorkspaceLeaf): boolean {
  return isNativeExplorer(leaf) && isLeafInLeftSidebar(app, leaf);
}

export function getLeafId(leaf: WorkspaceLeaf): string {
  const id = (leaf as unknown as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}
