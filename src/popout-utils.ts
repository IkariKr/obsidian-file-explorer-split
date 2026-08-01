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

export function isOutsideWindow(point: ScreenPoint, bounds: ScreenBounds): boolean {
  return point.x < bounds.x
    || point.x > bounds.x + bounds.width
    || point.y < bounds.y
    || point.y > bounds.y + bounds.height;
}

export function createPopoutWindowData(
  point: ScreenPoint,
  panel: PanelBounds,
): WorkspaceWindowInitData {
  const width = Math.max(360, Math.min(640, Math.round(panel.width || 480)));
  const height = Math.max(520, Math.min(900, Math.round(panel.height || 720)));
  return {
    x: Math.round(point.x - width / 2),
    y: Math.round(point.y - 32),
    size: { width, height },
  };
}
