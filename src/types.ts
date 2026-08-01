import type { TAbstractFile, WorkspaceLeaf } from "obsidian";

export const FILE_EXPLORER_VIEW_TYPE = "file-explorer";

export type SplitDirection = "vertical" | "horizontal";

export interface NativeExplorerTree {
  selectedDoms?: Iterable<HTMLElement>;
}

export interface NativeExplorerView {
  containerEl: HTMLElement;
  navFileContainerEl?: HTMLElement;
  tree?: NativeExplorerTree;
}

export interface DragSelection {
  leaf: WorkspaceLeaf;
  paths: string[];
  files: TAbstractFile[];
}
