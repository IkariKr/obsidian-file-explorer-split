export type DropPlacement = "bottom" | "right" | "tab";

export interface WorkspaceLayoutNode {
  id?: string;
  type?: string;
  children?: WorkspaceLayoutNode[];
  dimension?: number;
  currentTab?: number;
  [key: string]: unknown;
}

export interface WorkspaceLayout {
  left?: WorkspaceLayoutNode;
  [key: string]: unknown;
}

interface LocatedLeaf {
  parent: WorkspaceLayoutNode;
  index: number;
}

interface LocatedNode {
  parent: WorkspaceLayoutNode | null;
  index: number;
}

let generatedId = 0;

/**
 * Moves one leaf into the target tabs, or creates a split immediately after the
 * target tabs. Only the source leaf moves; both surrounding tab groups survive.
 */
export function moveLeftSidebarLeaf(
  layout: WorkspaceLayout,
  sourceLeafId: string,
  targetLeafId: string,
  placement: DropPlacement,
): boolean {
  if (!layout.left || sourceLeafId === targetLeafId) {
    return false;
  }

  const source = findLeaf(layout.left, sourceLeafId);
  const target = findLeaf(layout.left, targetLeafId);
  if (!source || !target || source.parent.type !== "tabs" || target.parent.type !== "tabs") {
    return false;
  }

  const sourceNode = source.parent.children?.[source.index];
  if (!sourceNode) {
    return false;
  }
  source.parent.children!.splice(source.index, 1);

  // The source may have been before the target in the same tab group.
  const updatedTarget = findLeaf(layout.left, targetLeafId);
  if (!updatedTarget || updatedTarget.parent.type !== "tabs") {
    return false;
  }

  if (placement === "tab") {
    updatedTarget.parent.children!.splice(updatedTarget.index + 1, 0, sourceNode);
    updatedTarget.parent.currentTab = updatedTarget.index + 1;
    normalizeLeftLayout(layout);
    return true;
  }

  const targetTabs = updatedTarget.parent;
  const targetLocation = findNode(layout.left, targetTabs);
  if (!targetLocation) {
    return false;
  }

  const outerDimension = targetTabs.dimension;
  const sourceTabs: WorkspaceLayoutNode = {
    id: createLayoutId("tabs"),
    type: "tabs",
    children: [sourceNode],
    currentTab: 0,
    dimension: 50,
  };
  targetTabs.dimension = 50;
  const split: WorkspaceLayoutNode = {
    id: createLayoutId("split"),
    type: "split",
    direction: placement === "right" ? "vertical" : "horizontal",
    children: [targetTabs, sourceTabs],
  };
  if (typeof outerDimension === "number") {
    split.dimension = outerDimension;
  }

  if (targetLocation.parent) {
    targetLocation.parent.children![targetLocation.index] = split;
  } else {
    layout.left = split;
  }
  normalizeLeftLayout(layout);
  return true;
}

/**
 * Obsidian's createLeafInParent inserts a bare leaf below a split. A file
 * explorer in that shape has no native tab header, unlike normal side-pane
 * file explorers. Wrap only those leaves in a tabs container; other core and
 * community-plugin leaves retain their existing location and grouping.
 */
export function ensureLeftExplorersUseTabs(layout: WorkspaceLayout): boolean {
  if (!layout.left) {
    return false;
  }
  return wrapBareExplorerLeaves(layout.left);
}

function findLeaf(node: WorkspaceLayoutNode, leafId: string): LocatedLeaf | null {
  const children = node.children;
  if (!children) {
    return null;
  }
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type === "leaf" && child.id === leafId) {
      return { parent: node, index };
    }
    const nested = findLeaf(child, leafId);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function findNode(
  node: WorkspaceLayoutNode,
  expected: WorkspaceLayoutNode,
  parent: WorkspaceLayoutNode | null = null,
  index = -1,
): LocatedNode | null {
  if (node === expected) {
    return { parent, index };
  }
  for (let childIndex = 0; childIndex < (node.children?.length ?? 0); childIndex += 1) {
    const child = node.children![childIndex];
    const result = findNode(child, expected, node, childIndex);
    if (result) {
      return result;
    }
  }
  return null;
}

function normalizeLeftLayout(layout: WorkspaceLayout): void {
  if (!layout.left) {
    return;
  }
  const normalized = normalizeNode(layout.left, true);
  if (normalized) {
    layout.left = normalized;
  }
}

function wrapBareExplorerLeaves(node: WorkspaceLayoutNode): boolean {
  let changed = false;
  const children = node.children;
  if (!children) {
    return false;
  }
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (node.type !== "tabs" && isExplorerLeaf(child)) {
      const dimension = child.dimension;
      children[index] = {
        id: createLayoutId("tabs"),
        type: "tabs",
        children: [child],
        currentTab: 0,
        ...(typeof dimension === "number" ? { dimension } : {}),
      };
      changed = true;
      continue;
    }
    changed = wrapBareExplorerLeaves(child) || changed;
  }
  return changed;
}

function isExplorerLeaf(node: WorkspaceLayoutNode): boolean {
  if (node.type !== "leaf") {
    return false;
  }
  const state = node.state;
  return state !== null
    && typeof state === "object"
    && (state as { type?: unknown }).type === "file-explorer";
}

function normalizeNode(node: WorkspaceLayoutNode, isRoot: boolean): WorkspaceLayoutNode | null {
  if (!node.children) {
    return node;
  }
  node.children = node.children
    .map((child) => normalizeNode(child, false))
    .filter((child): child is WorkspaceLayoutNode => child !== null);

  if (node.type === "tabs" && node.children.length === 0) {
    return null;
  }
  if (node.type !== "split") {
    return node;
  }
  if (node.children.length === 0) {
    return null;
  }
  if (!isRoot && node.children.length === 1) {
    const onlyChild = node.children[0];
    if (typeof node.dimension === "number" && typeof onlyChild.dimension !== "number") {
      onlyChild.dimension = node.dimension;
    }
    return onlyChild;
  }
  return node;
}

function createLayoutId(prefix: string): string {
  generatedId += 1;
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${generatedId.toString(36)}`;
  return `file-explorer-split-${prefix}-${random}`;
}
