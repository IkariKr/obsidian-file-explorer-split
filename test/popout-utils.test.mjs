import assert from "node:assert/strict";
import { test } from "node:test";
import esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/popout-utils.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const module = { exports: {} };
new Function("module", "exports", result.outputFiles[0].text)(module, module.exports);
const { createPopoutWindowData, isNearWindowEdge, isOutsideWindow } = module.exports;

test("recognizes a drop outside any edge of the main window", () => {
  const bounds = { x: 100, y: 200, width: 800, height: 600 };

  assert.equal(isOutsideWindow({ x: 100, y: 200 }, bounds), false);
  assert.equal(isOutsideWindow({ x: 99, y: 400 }, bounds), true);
  assert.equal(isOutsideWindow({ x: 901, y: 400 }, bounds), true);
  assert.equal(isOutsideWindow({ x: 400, y: 199 }, bounds), true);
  assert.equal(isOutsideWindow({ x: 400, y: 801 }, bounds), true);
});

test("recognizes the in-window edge activation zone used when Electron drops outside drag coordinates", () => {
  assert.equal(isNearWindowEdge({ x: 31, y: 400 }, 1200, 800), true);
  assert.equal(isNearWindowEdge({ x: 600, y: 769 }, 1200, 800), true);
  assert.equal(isNearWindowEdge({ x: 600, y: 400 }, 1200, 800), false);
});

test("creates a visible, bounded popout window and lets Obsidian choose its display position", () => {
  assert.deepEqual(
    createPopoutWindowData({ x: 1200, y: 700 }, { width: 240, height: 1200 }),
    { size: { width: 360, height: 900 } },
  );
  assert.deepEqual(
    createPopoutWindowData({ x: 1200, y: 700 }, { width: 2000, height: 200 }),
    { size: { width: 640, height: 520 } },
  );
});
