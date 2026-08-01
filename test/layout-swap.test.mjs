import assert from "node:assert/strict";
import { test } from "node:test";
import esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/layout-swap.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const module = { exports: {} };
new Function("module", "exports", result.outputFiles[0].text)(module, module.exports);
const { moveLeftSidebarLeaf } = module.exports;

const leaf = (id, type = "file-explorer") => ({ id, type: "leaf", state: { type } });
const tabs = (...children) => ({ id: `tabs-${children[0]?.id ?? "empty"}`, type: "tabs", children });
const split = (...children) => ({ id: "split-root", type: "split", direction: "vertical", children });

test("moves a source explorer to the target's right while preserving both tab groups", () => {
  const sourceGroup = tabs(leaf("source"), leaf("source-bookmarks", "bookmarks"));
  const targetGroup = tabs(leaf("target"), leaf("target-search", "search"));
  const layout = { left: split(sourceGroup, targetGroup) };

  assert.equal(moveLeftSidebarLeaf(layout, "source", "target", "right"), true);
  assert.deepEqual(sourceGroup.children.map((node) => node.id), ["source-bookmarks"]);
  const movedSplit = layout.left.children[1];
  assert.equal(movedSplit.type, "split");
  assert.equal(movedSplit.direction, "vertical");
  assert.deepEqual(movedSplit.children[0].children.map((node) => node.id), ["target", "target-search"]);
  assert.deepEqual(movedSplit.children[1].children.map((node) => node.id), ["source"]);
});

test("moves a source explorer below the target tab group", () => {
  const layout = { left: split(tabs(leaf("source"), leaf("bookmarks", "bookmarks")), tabs(leaf("target"))) };

  assert.equal(moveLeftSidebarLeaf(layout, "source", "target", "bottom"), true);
  const movedSplit = layout.left.children[1];
  assert.equal(movedSplit.type, "split");
  assert.equal(movedSplit.direction, "horizontal");
  assert.equal(movedSplit.children[0].children[0].id, "target");
  assert.equal(movedSplit.children[1].children[0].id, "source");
});

test("merges the source into the target tab group directly after the target leaf", () => {
  const layout = {
    left: split(
      tabs(leaf("source"), leaf("source-bookmarks", "bookmarks")),
      tabs(leaf("target"), leaf("target-search", "search")),
    ),
  };

  assert.equal(moveLeftSidebarLeaf(layout, "source", "target", "tab"), true);
  assert.deepEqual(layout.left.children[0].children.map((node) => node.id), ["source-bookmarks"]);
  assert.deepEqual(layout.left.children[1].children.map((node) => node.id), ["target", "source", "target-search"]);
  assert.equal(layout.left.children[1].currentTab, 1);
});

test("reorders an explorer after the target inside its existing tab group", () => {
  const group = tabs(leaf("source"), leaf("target"), leaf("search", "search"));
  const layout = { left: split(group) };

  assert.equal(moveLeftSidebarLeaf(layout, "source", "target", "tab"), true);
  assert.deepEqual(group.children.map((node) => node.id), ["target", "source", "search"]);
  assert.equal(group.currentTab, 1);
});

test("moves an explorer within its own tab group into a nested split", () => {
  const targetGroup = tabs(leaf("source"), leaf("target"), leaf("bookmarks", "bookmarks"));
  const layout = { left: split(targetGroup) };

  assert.equal(moveLeftSidebarLeaf(layout, "source", "target", "right"), true);
  const movedSplit = layout.left.children[0];
  assert.equal(movedSplit.type, "split");
  assert.deepEqual(movedSplit.children[0].children.map((node) => node.id), ["target", "bookmarks"]);
  assert.deepEqual(movedSplit.children[1].children.map((node) => node.id), ["source"]);
});

test("removes an empty source tab group and keeps the left root split", () => {
  const layout = { left: split(tabs(leaf("source")), tabs(leaf("target"))) };

  assert.equal(moveLeftSidebarLeaf(layout, "source", "target", "bottom"), true);
  assert.equal(layout.left.type, "split");
  assert.equal(layout.left.children.length, 1);
  assert.equal(layout.left.children[0].type, "split");
  assert.equal(layout.left.children[0].children[1].children[0].id, "source");
});

test("does not mutate layout for invalid or identical leaf ids", () => {
  const layout = { left: split(tabs(leaf("one")), tabs(leaf("two"))) };
  const snapshot = JSON.stringify(layout);

  assert.equal(moveLeftSidebarLeaf(layout, "one", "one", "right"), false);
  assert.equal(moveLeftSidebarLeaf(layout, "one", "missing", "tab"), false);
  assert.equal(JSON.stringify(layout), snapshot);
});
