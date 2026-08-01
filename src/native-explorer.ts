import { App, Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import { VaultCopyService } from "./copy-service";
import { FILE_EXPLORER_VIEW_TYPE, type DragSelection, type NativeExplorerView } from "./types";

type SplitHandler = () => void;

interface PendingCopyDrag extends DragSelection {
  startedAt: number;
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
  return view.containerEl instanceof HTMLElement ? (view as NativeExplorerView) : null;
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
  private pending: PendingCopyDrag | null = null;
  private highlighted: HTMLElement | null = null;

  constructor(
    private readonly app: App,
    private readonly copyService: VaultCopyService,
  ) {}

  refresh(): void {
    const currentContainers = new Set<HTMLElement>();
    for (const leaf of getLeftExplorerLeaves(this.app)) {
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
    this.clearPending();
  }

  private attach(leaf: WorkspaceLeaf, view: NativeExplorerView): void {
    const onDragStart = (event: DragEvent) => this.captureDragStart(leaf, view, event);
    const onDragOver = (event: DragEvent) => this.captureDragOver(leaf, view, event);
    const onDrop = (event: DragEvent) => this.captureDrop(leaf, view, event);
    const onDragEnd = () => this.clearPendingSoon();

    view.containerEl.addEventListener("dragstart", onDragStart, true);
    view.containerEl.addEventListener("dragover", onDragOver, true);
    view.containerEl.addEventListener("drop", onDrop, true);
    view.containerEl.addEventListener("dragend", onDragEnd, true);

    this.cleanups.set(view.containerEl, () => {
      view.containerEl.removeEventListener("dragstart", onDragStart, true);
      view.containerEl.removeEventListener("dragover", onDragOver, true);
      view.containerEl.removeEventListener("drop", onDrop, true);
      view.containerEl.removeEventListener("dragend", onDragEnd, true);
    });
  }

  private captureDragStart(leaf: WorkspaceLeaf, view: NativeExplorerView, event: DragEvent): void {
    if (!event.ctrlKey) {
      this.clearPending();
      return;
    }

    const selection = this.resolveDraggedSelection(leaf, view, event);
    if (!selection) {
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

  private captureDrop(_leaf: WorkspaceLeaf, view: NativeExplorerView, event: DragEvent): void {
    if (!this.pending || !event.ctrlKey) {
      return;
    }
    const destination = this.resolveDestinationFolder(view, event.target);
    if (!destination) {
      return;
    }

    const pending = this.pending;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.clearPending();

    void this.copyService.copyIntoFolder(pending.files, destination).catch((error: unknown) => {
      console.error("[File Explorer Split] Copy failed", error);
      new Notice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private resolveDraggedSelection(
    leaf: WorkspaceLeaf,
    view: NativeExplorerView,
    event: DragEvent,
  ): DragSelection | null {
    const selectedPaths = new Set<string>();
    for (const element of view.tree?.selectedDoms ?? []) {
      const path = this.pathFromElement(element);
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

    const targetElement = target instanceof HTMLElement ? target : null;
    const navigator = view.navFileContainerEl ?? view.containerEl;
    return targetElement && navigator.contains(targetElement) ? this.app.vault.getRoot() : null;
  }

  private findDropElement(target: EventTarget | null, view: NativeExplorerView): HTMLElement | null {
    const element = target instanceof HTMLElement ? target : null;
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
