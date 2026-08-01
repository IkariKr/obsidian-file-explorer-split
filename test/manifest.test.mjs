import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

test("plugin manifest identifies a desktop-only native file explorer plugin", async () => {
  const manifestPath = new URL("manifest.json", root);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.equal(manifest.id, "file-explorer-split");
  assert.equal(manifest.isDesktopOnly, true);
  assert.equal(manifest.minAppVersion, "1.12.0");
});

test("source contains native explorer split, Ctrl-copy, drag-move, and final-explorer guard adapters", async () => {
  const main = await readFile(new URL("src/main.ts", root), "utf8");
  const adapter = await readFile(new URL("src/native-explorer.ts", root), "utf8");
  const moveAdapter = await readFile(new URL("src/explorer-reorder.ts", root), "utf8");
  const diagnostics = await readFile(new URL("src/diagnostics.ts", root), "utf8");
  const closeGuard = await readFile(new URL("src/last-explorer-close-guard.ts", root), "utf8");

  assert.match(main, /createLeafBySplit/);
  assert.match(main, /LastExplorerCloseGuard/);
  assert.match(main, /file-explorer/);
  assert.match(adapter, /event\.ctrlKey/);
  assert.match(adapter, /CopyDragController/);
  assert.match(adapter, /captureNativeExplorerState/);
  assert.match(adapter, /restoreNativeExplorerState/);
  assert.match(moveAdapter, /ExplorerTabMoveController/);
  assert.match(moveAdapter, /"bottom"/);
  assert.match(moveAdapter, /"right"/);
  assert.match(moveAdapter, /"tab"/);
  assert.match(main, /move\.snapshot/);
  assert.match(main, /move\.restore-complete/);
  assert.match(diagnostics, /debug\.log/);
  assert.match(closeGuard, /leaf\.detach/);
  assert.match(closeGuard, /至少保留一个左侧文件列表/);
  assert.ok(fileURLToPath(root).endsWith("obsidian-file-explorer-split\\") || fileURLToPath(root).endsWith("obsidian-file-explorer-split/"));
});
