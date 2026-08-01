import { App, Notice, WorkspaceLeaf } from "obsidian";
import type { DropPlacement } from "./layout-swap";
import { isOutsideWindow, type PanelBounds, type ScreenPoint } from "./popout-utils";
import { getLeftExplorerLeaves, isLeafInLeftSidebar, isNativeExplorer } from "./native-explorer";

export type MoveHandler = (source: WorkspaceLeaf, target: WorkspaceLeaf, placement: DropPlacement) => Promise<boolean>;
export type PopoutHandler = (source: WorkspaceLeaf, point: ScreenPoint, panel: PanelBounds) => Promise<boolean>;

interface ExplorerHeaderEntry {
  leaf: WorkspaceLeaf;
  header: HTMLElement;
  tabsRoot: HTMLElement;
  headerContainer: HTMLElement;
  inLeftSidebar: boolean;
}

interface ResolvedDrop {
  entry: ExplorerHeaderEntry;
  placement: DropPlacement;
}

interface WorkspaceTabsInternals {
  containerEl?: HTMLElement;
  children?: WorkspaceLeaf[];
}

/** Cross-window DOM adapter for moving native explorer leaves. */
export class ExplorerTabMoveController {
  private readonly cleanups = new Map<HTMLElement, () => void>();
  private readonly leftEntriesByTabsRoot = new Map<HTMLElement, ExplorerHeaderEntry[]>();
  private readonly keyCleanups = new Map<Document, () => void>();
  private rootCleanup: (() => void) | null = null;
  private rootElement: HTMLElement | null = null;
  private source: ExplorerHeaderEntry | null = null;
  private target: ResolvedDrop | null = null;
  private lastScreenPoint: ScreenPoint | null = null;
  private outsideMainWindow = false;

  constructor(
    private readonly app: App,
    private readonly getInteractiveLeaves: () => WorkspaceLeaf[],
    private readonly isManagedPopoutLeaf: (leaf: WorkspaceLeaf) => boolean,
    private readonly onMove: MoveHandler,
    private readonly onPopout: PopoutHandler,
  ) {}

  refresh(): void {
    this.leftEntriesByTabsRoot.clear();
    const currentHeaders = new Set<HTMLElement>();
    const documents = new Set<Document>();
    const leaves = new Map<string, WorkspaceLeaf>();
    for (const leaf of this.getInteractiveLeaves()) {
      const id = getLeafId(leaf);
      if (id) {
        leaves.set(id, leaf);
      }
    }

    for (const leaf of leaves.values()) {
      const inLeftSidebar = isLeafInLeftSidebar(this.app, leaf);
      if (!inLeftSidebar && !this.isManagedPopoutLeaf(leaf)) {
        continue;
      }
      const entry = this.getHeaderEntry(leaf, inLeftSidebar);
      if (!entry) {
        continue;
      }
      currentHeaders.add(entry.header);
      documents.add(entry.header.ownerDocument);
      if (inLeftSidebar) {
        const group = this.leftEntriesByTabsRoot.get(entry.tabsRoot) ?? [];
        group.push(entry);
        this.leftEntriesByTabsRoot.set(entry.tabsRoot, group);
      }
      const icon = this.getHandle(entry.header);
      if (!icon) {
        continue;
      }
      icon.setAttribute("draggable", "true");
      icon.setAttribute("aria-label", "拖动到文件列表的右侧、下方、标签栏或窗口外");
      icon.setAttribute("title", "拖动到文件列表的右侧、下方、标签栏或窗口外");
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
    for (const document of documents) {
      this.attachKeyListener(document);
    }
    for (const [document, cleanup] of this.keyCleanups) {
      if (!documents.has(document)) {
        cleanup();
        this.keyCleanups.delete(document);
      }
    }
    this.attachLeftSidebarEvents();
  }

  unload(): void {
    for (const cleanup of this.cleanups.values()) {
      cleanup();
    }
    this.cleanups.clear();
    for (const cleanup of this.keyCleanups.values()) {
      cleanup();
    }
    this.keyCleanups.clear();
    this.rootCleanup?.();
    this.rootCleanup = null;
    this.rootElement = null;
    this.clearVisualState();
    this.leftEntriesByTabsRoot.clear();
  }

  private attachHandle(entry: ExplorerHeaderEntry, icon: HTMLElement): void {
    const onDragStart = (event: DragEvent) => this.startDrag(entry, event);
    const onDrag = (event: DragEvent) => this.trackDrag(event);
    const onDragEnd = (event: DragEvent) => this.finishDrag(event);
    icon.addEventListener("dragstart", onDragStart);
    icon.addEventListener("drag", onDrag);
    icon.addEventListener("dragend", onDragEnd);
    this.cleanups.set(entry.header, () => {
      icon.removeEventListener("dragstart", onDragStart);
      icon.removeEventListener("drag", onDrag);
      icon.removeEventListener("dragend", onDragEnd);
      icon.removeClass("file-explorer-split-move-handle");
      icon.removeAttribute("draggable");
      icon.removeAttribute("aria-label");
      icon.removeAttribute("title");
    });
  }

  private attachKeyListener(document: Document): void {
    if (this.keyCleanups.has(document)) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        this.clearVisualState();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    this.keyCleanups.set(document, () => document.removeEventListener("keydown", onKeyDown, true));
  }

  private attachLeftSidebarEvents(): void {
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
    root.addEventListener("dragover", onDragOver, true);
    root.addEventListener("drop", onDrop, true);
    root.addEventListener("dragleave", onDragLeave, true);
    this.rootCleanup = () => {
      root.removeEventListener("dragover", onDragOver, true);
      root.removeEventListener("drop", onDrop, true);
      root.removeEventListener("dragleave", onDragLeave, true);
    };
  }

  private startDrag(entry: ExplorerHeaderEntry, event: DragEvent): void {
    if (!event.dataTransfer) {
      return;
    }
    event.stopImmediatePropagation();
    this.clearVisualState();
    this.source = entry;
    this.lastScreenPoint = this.pointFromEvent(event);
    entry.header.addClass("file-explorer-split-move-source");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-file-explorer-split-leaf", getLeafId(entry.leaf));
    event.dataTransfer.setData("text/plain", getLeafId(entry.leaf));
  }

  private trackDrag(event: DragEvent): void {
    if (!this.source) {
      return;
    }
    const point = this.pointFromEvent(event);
    if (point) {
      this.lastScreenPoint = point;
    }
    this.updateExternalPreview();
  }

  private finishDrag(event: DragEvent): void {
    const source = this.source;
    const point = this.pointFromEvent(event) ?? this.lastScreenPoint;
    const shouldPopout = Boolean(source?.inLeftSidebar && this.outsideMainWindow && point);
    const panel = source?.tabsRoot.getBoundingClientRect();
    this.clearVisualState();
    if (!source || !point || !panel || !shouldPopout) {
      return;
    }
    void this.onPopout(source.leaf, point, { width: panel.width, height: panel.height }).catch((error: unknown) => {
      console.error("[File Explorer Split] Popout failed", error);
      new Notice(`打开独立窗口失败：${error instanceof Error ? error.message : String(error)}`);
    });
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
    this.outsideMainWindow = false;
    this.removeExternalPreview();
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
    const element = asHtmlElement(event.target);
    if (!element) {
      return null;
    }
    const tabsRoot = element.closest<HTMLElement>(".workspace-tabs");
    if (!tabsRoot) {
      return null;
    }
    const entry = this.getActiveLeftExplorerEntry(tabsRoot);
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
    if (event.clientX >= rect.right - rect.width * 0.3) {
      return { entry, placement: "right" };
    }
    return event.clientY >= rect.bottom - rect.height * 0.3 ? { entry, placement: "bottom" } : null;
  }

  private getActiveLeftExplorerEntry(tabsRoot: HTMLElement): ExplorerHeaderEntry | null {
    const entries = this.leftEntriesByTabsRoot.get(tabsRoot) ?? [];
    return entries.find((entry) => entry.header.hasClass("is-active")) ?? null;
  }

  private getHeaderEntry(leaf: WorkspaceLeaf, inLeftSidebar: boolean): ExplorerHeaderEntry | null {
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
    return header && headerContainer ? { leaf, header, tabsRoot, headerContainer, inLeftSidebar } : null;
  }

  private getHandle(header: HTMLElement): HTMLElement | null {
    return header.querySelector<HTMLElement>(".workspace-tab-header-inner-icon");
  }

  private updateExternalPreview(): void {
    const source = this.source;
    if (!source || !source.inLeftSidebar || !this.lastScreenPoint) {
      return;
    }
    const bounds = this.getMainWindowBounds();
    this.outsideMainWindow = Boolean(bounds && isOutsideWindow(this.lastScreenPoint, bounds));
    if (this.outsideMainWindow) {
      source.header.addClass("file-explorer-split-move-popout");
      if (!source.header.querySelector(".file-explorer-split-popout-preview")) {
        const preview = source.header.ownerDocument.createElement("span");
        preview.className = "file-explorer-split-popout-preview";
        preview.setText("松开以移至独立窗口");
        source.header.appendChild(preview);
      }
    } else {
      this.removeExternalPreview();
    }
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
    const preview = target.entry.tabsRoot.ownerDocument.createElement("span");
    preview.className = "file-explorer-split-move-preview";
    preview.setText(target.placement === "tab" ? "合并为标签组" : target.placement === "right" ? "移到右侧" : "移到下方");
    (target.placement === "tab" ? target.entry.headerContainer : target.entry.tabsRoot).appendChild(preview);
  }

  private clearVisualState(): void {
    this.source?.header.removeClass("file-explorer-split-move-source");
    this.removeExternalPreview();
    this.source = null;
    this.lastScreenPoint = null;
    this.outsideMainWindow = false;
    this.setTarget(null);
  }

  private removeExternalPreview(): void {
    this.source?.header.removeClass("file-explorer-split-move-popout");
    this.source?.header.querySelector(".file-explorer-split-popout-preview")?.remove();
  }

  private pointFromEvent(event: DragEvent): ScreenPoint | null {
    return event.screenX === 0 && event.screenY === 0 ? null : { x: event.screenX, y: event.screenY };
  }

  private getMainWindowBounds(): { x: number; y: number; width: number; height: number } | null {
    const win = this.getLeftSidebarElement()?.ownerDocument.defaultView;
    if (!win) {
      return null;
    }
    return { x: win.screenX, y: win.screenY, width: win.outerWidth, height: win.outerHeight };
  }

  private getLeftSidebarElement(): HTMLElement | null {
    const split = this.app.workspace.leftSplit as unknown as { containerEl?: HTMLElement };
    return split.containerEl && isHtmlElement(split.containerEl) ? split.containerEl : null;
  }
}

export function isValidLeftExplorer(app: App, leaf: WorkspaceLeaf): boolean {
  return isNativeExplorer(leaf) && isLeafInLeftSidebar(app, leaf);
}

export function getLeafId(leaf: WorkspaceLeaf): string {
  const id = (leaf as unknown as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

function asHtmlElement(value: EventTarget | null | undefined): HTMLElement | null {
  return value && typeof value === "object" && (value as Node).nodeType === 1
    ? value as HTMLElement
    : null;
}

function isHtmlElement(value: unknown): value is HTMLElement {
  return value !== null && typeof value === "object" && (value as Node).nodeType === 1;
}
