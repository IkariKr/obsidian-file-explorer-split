import type { TAbstractFile, WorkspaceLeaf } from "obsidian";

export const FILE_EXPLORER_VIEW_TYPE = "file-explorer";

export type SplitDirection = "vertical" | "horizontal";

/**
 * 原生文件列表树节点的最小运行时结构。
 * Minimal runtime shape of a native file-explorer tree item.
 */
export interface NativeExplorerTreeItem {
  file?: TAbstractFile;
  selfEl?: HTMLElement;
  /** 原生文件夹节点的私有折叠状态。 / Native folder item's private collapsed state. */
  collapsed?: boolean;
  /**
   * 原生文件夹节点的异步折叠 API。
   * Native folder item's asynchronous collapse API.
   *
   * Obsidian does not expose this method in its public typings; callers must
   * detect it at runtime and retain a DOM fallback for older builds.
   * Obsidian 未在公开类型中暴露此方法；调用方必须运行时检测，并为旧版本保留 DOM fallback。
   */
  setCollapsed?: (collapsed: boolean, updateFlag?: boolean) => void | Promise<void>;
}

/**
 * 原生文件列表树的私有选择 API 适配面。
 * Private selection surface exposed by Obsidian's native file-explorer tree.
 */
export interface NativeExplorerTree {
  activeDom?: NativeExplorerTreeItem | null;
  selectedDoms?: Iterable<NativeExplorerTreeItem>;
  focusedItem?: NativeExplorerTreeItem | null;
  selectItem?: (item: NativeExplorerTreeItem) => void;
  clearSelectedDoms?: () => void;
  setFocusedItem?: (item: NativeExplorerTreeItem | null, scrollIntoView?: boolean) => void;
}

/**
 * 原生文件列表视图的私有状态适配面。
 * Private state surface exposed by Obsidian's native file-explorer view.
 */
export interface NativeExplorerView {
  containerEl: HTMLElement;
  navFileContainerEl?: HTMLElement;
  /** 原生自动显示当前文件的开关。 / Native auto-reveal-current-file toggle. */
  autoRevealFile?: boolean;
  tree?: NativeExplorerTree;
  fileItems?: Record<string, NativeExplorerTreeItem>;
  activeDom?: NativeExplorerTreeItem | null;
}

/**
 * Files resolved from one explorer's current drag selection.
 * 从一个文件列表当前拖拽选择集中解析出的文件集合。
 */
export interface DragSelection {
  leaf: WorkspaceLeaf;
  paths: string[];
  files: TAbstractFile[];
}
