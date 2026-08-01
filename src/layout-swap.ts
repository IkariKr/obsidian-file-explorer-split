export interface WorkspaceLayoutNode {
  id?: string;
  type?: string;
  children?: WorkspaceLayoutNode[];
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

/** Exchanges two leaf entries so native view state follows its leaf. */
export function swapLeftSidebarLeafNodes(
  layout: WorkspaceLayout,
  sourceLeafId: string,
  targetLeafId: string,
): boolean {
  if (!layout.left || sourceLeafId === targetLeafId) {
    return false;
  }

  const source = findLeaf(layout.left, sourceLeafId);
  const target = findLeaf(layout.left, targetLeafId);
  if (!source || !target) {
    return false;
  }

  const sourceNode = source.parent.children?.[source.index];
  const targetNode = target.parent.children?.[target.index];
  if (!sourceNode || !targetNode) {
    return false;
  }
  source.parent.children![source.index] = targetNode;
  target.parent.children![target.index] = sourceNode;
  return true;
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
