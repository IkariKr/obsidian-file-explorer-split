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
const { swapLeftSidebarLeafNodes } = module.exports;

const leaf = (id, type = "file-explorer") => ({ id, type: "leaf", state: { type } });
const tabs = (...children) => ({ type: "tabs", children });
const split = (...children) => ({ type: "split", children });

test("swaps sibling file-explorer panes in a horizontal or vertical split", () => {
  const layout = { left: split(tabs(leaf("left")), tabs(leaf("right"))) };

  assert.equal(swapLeftSidebarLeafNodes(layout, "left", "right"), true);
  assert.equal(layout.left.children[0].children[0].id, "right");
  assert.equal(layout.left.children[1].children[0].id, "left");
});

test("swaps leaves across nested 2x2 branches without moving other tabs", () => {
  const layout = {
    left: split(
      split(tabs(leaf("a"), leaf("bookmarks", "bookmarks")), tabs(leaf("b"))),
      split(tabs(leaf("c")), tabs(leaf("d"), leaf("search", "search"))),
    ),
  };

  assert.equal(swapLeftSidebarLeafNodes(layout, "a", "d"), true);
  assert.equal(layout.left.children[0].children[0].children[0].id, "d");
  assert.equal(layout.left.children[0].children[0].children[1].id, "bookmarks");
  assert.equal(layout.left.children[1].children[1].children[0].id, "a");
  assert.equal(layout.left.children[1].children[1].children[1].id, "search");
});

test("swaps only the two file-explorer leaves inside one tab group", () => {
  const layout = { left: tabs(leaf("one"), leaf("bookmarks", "bookmarks"), leaf("two")) };

  assert.equal(swapLeftSidebarLeafNodes(layout, "one", "two"), true);
  assert.deepEqual(layout.left.children.map((node) => node.id), ["two", "bookmarks", "one"]);
});

test("does not mutate layout for invalid or identical leaf ids", () => {
  const layout = { left: tabs(leaf("one"), leaf("two")) };
  const snapshot = JSON.stringify(layout);

  assert.equal(swapLeftSidebarLeafNodes(layout, "one", "one"), false);
  assert.equal(swapLeftSidebarLeafNodes(layout, "one", "missing"), false);
  assert.equal(JSON.stringify(layout), snapshot);
});
