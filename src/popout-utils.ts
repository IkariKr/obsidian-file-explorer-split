import type { WorkspaceWindowInitData } from "obsidian";

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelBounds {
  width: number;
  height: number;
}

export interface ClientPoint {
  x: number;
  y: number;
}

export function isOutsideWindow(point: ScreenPoint, bounds: ScreenBounds): boolean {
  return point.x < bounds.x
    || point.x > bounds.x + bounds.width
    || point.y < bounds.y
    || point.y > bounds.y + bounds.height;
}

export function isNearWindowEdge(point: ClientPoint, width: number, height: number, edge = 32): boolean {
  return point.x <= edge || point.x >= width - edge || point.y <= edge || point.y >= height - edge;
}

export function createPopoutWindowData(
  _point: ScreenPoint,
  panel: PanelBounds,
): WorkspaceWindowInitData {
  const width = Math.max(360, Math.min(640, Math.round(panel.width || 480)));
  const height = Math.max(520, Math.min(900, Math.round(panel.height || 720)));
  // Let Obsidian choose a visible display and position. Passing raw drag
  // coordinates can place a popout above or beyond a multi-monitor work area.
  return { size: { width, height } };
}
