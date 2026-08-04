import assert from "node:assert/strict";
import { test } from "node:test";
import esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/explorer-selection.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const module = { exports: {} };
new Function("module", "exports", result.outputFiles[0].text)(module, module.exports);
const {
  ExplorerViewIsolationController,
  captureNativeExplorerSelection,
  captureNativeExplorerFolders,
  restoreNativeExplorerFolders,
  restoreNativeExplorerFoldersSettled,
  restoreNativeExplorerSelection,
} = module.exports;

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor() {
    this.nodeType = 1;
    this.isConnected = true;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.listeners = new Map();
    this.folders = [];
    this.folderTitle = null;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((value) => value !== handler));
  }

  dispatch(type, event) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }

  closest(selector) {
    if (selector === ".nav-file-title" && this.classList.contains("nav-file-title")) {
      return this;
    }
    if (selector === ".nav-folder-title" && this.classList.contains("nav-folder-title")) {
      return this;
    }
    return null;
  }

  querySelector(selector) {
    if (this.folderTitle && (selector.includes(".nav-folder-title") || selector.includes("[data-path]"))) {
      return this.folderTitle;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector === ".nav-folder") {
      return this.folders;
    }
    return [];
  }
}

function item(path) {
  const selfEl = new FakeElement();
  selfEl.dataset.path = path;
  selfEl.classList.add("nav-file-title");
  return { file: { path }, selfEl };
}

function folder(path, collapsed) {
  const folderEl = new FakeElement();
  const title = new FakeElement();
  folderEl.classList.add("nav-folder");
  title.classList.add("nav-folder-title");
  title.dataset.path = path;
  folderEl.folderTitle = title;
  if (collapsed) {
    folderEl.classList.add("is-collapsed");
  }
  title.click = () => {
    if (folderEl.classList.contains("is-collapsed")) {
      folderEl.classList.remove("is-collapsed");
    } else {
      folderEl.classList.add("is-collapsed");
    }
  };
  return folderEl;
}

function nativeFolderItem(path, collapsed, onSetCollapsed = () => undefined) {
  const selfEl = new FakeElement();
  selfEl.dataset.path = path;
  selfEl.classList.add("nav-folder-title");
  const item = {
    file: { path, children: [] },
    selfEl,
    collapsed,
    setCollapsed(value, updateFlag) {
      item.collapsed = value;
      return onSetCollapsed(value, updateFlag);
    },
  };
  return item;
}

function leaf(id, paths, folderStates = []) {
  const items = Object.fromEntries(paths.map((path) => [path, item(path)]));
  const tree = {
    activeDom: null,
    selectedDoms: new Set(),
    focusedItem: null,
    selectItem(value) {
      this.selectedDoms.add(value);
      value.selfEl.classList.add("is-selected");
    },
    clearSelectedDoms() {
      for (const value of this.selectedDoms) {
        value.selfEl.classList.remove("is-selected");
      }
      this.selectedDoms.clear();
    },
    setFocusedItem(value) {
      if (this.focusedItem) {
        this.focusedItem.selfEl.classList.remove("has-focus");
      }
      this.focusedItem = value;
      if (value) {
        value.selfEl.classList.add("has-focus");
      }
    },
  };
  const view = {
    containerEl: new FakeElement(),
    fileItems: items,
    tree,
    activeDom: null,
    autoRevealFile: true,
  };
  if (folderStates.length > 0) {
    view.navFileContainerEl = new FakeElement();
    view.navFileContainerEl.folders = folderStates.map(([path, collapsed]) => folder(path, collapsed));
  }
  return {
    id,
    view,
    getViewState: () => ({ type: "file-explorer" }),
  };
}

function folderState(leafValue) {
  const navigator = leafValue.view.navFileContainerEl;
  return [...(navigator?.folders ?? [])].map((folderEl) => ({
    path: folderEl.folderTitle.dataset.path,
    collapsed: folderEl.classList.contains("is-collapsed"),
  }));
}

function setFolderCollapsed(leafValue, path, collapsed) {
  const folderEl = (leafValue.view.navFileContainerEl?.folders ?? [])
    .find((value) => value.folderTitle.dataset.path === path);
  if (!folderEl) {
    throw new Error(`Unknown folder: ${path}`);
  }
  if (collapsed) {
    folderEl.classList.add("is-collapsed");
  } else {
    folderEl.classList.remove("is-collapsed");
  }
}

function setSelection(leafValue, activePath, selectedPaths = [], focusedPath = activePath) {
  const view = leafValue.view;
  view.tree.clearSelectedDoms();
  for (const path of selectedPaths) {
    view.tree.selectItem(view.fileItems[path]);
  }
  view.activeDom = activePath ? view.fileItems[activePath] : null;
  view.tree.activeDom = view.activeDom;
  if (view.activeDom) {
    view.activeDom.selfEl.classList.add("is-active");
  }
  view.tree.setFocusedItem(focusedPath ? view.fileItems[focusedPath] : null);
}

function simulateNativeFileOpen(leafValue, path) {
  const view = leafValue.view;
  const next = view.fileItems[path] ?? null;
  if (next !== view.tree.focusedItem) {
    view.tree.clearSelectedDoms();
  }
  if (view.activeDom) {
    view.activeDom.selfEl.classList.remove("is-active");
  }
  if (next) {
    next.selfEl.classList.add("is-active");
  }
  view.activeDom = next;
  view.tree.activeDom = next;
}

test("restores other views when one explorer opens a file", () => {
  const left = leaf("left", ["A.md", "A-2.md", "B.md", "B-2.md"]);
  const right = leaf("right", ["A.md", "A-2.md", "B.md", "B-2.md"]);
  setSelection(left, "A.md", ["A-2.md"], "A.md");
  setSelection(right, "B.md", ["B-2.md"], "B.md");

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  controller.beginFileOpenInteraction(left, "A-2.md");
  setSelection(left, "A.md", [], "A.md");
  simulateNativeFileOpen(left, "A-2.md");
  simulateNativeFileOpen(right, "A-2.md");
  controller.handleFileOpen("A-2.md");

  assert.equal(left.view.activeDom.file.path, "A-2.md");
  assert.equal(right.view.activeDom.file.path, "B.md");
  assert.deepEqual([...right.view.tree.selectedDoms].map((value) => value.file.path), ["B-2.md"]);
});

test("restores every view for an external file-open event", () => {
  const left = leaf("left", ["A.md", "B.md"]);
  const right = leaf("right", ["A.md", "B.md"]);
  setSelection(left, "A.md");
  setSelection(right, "B.md");

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  simulateNativeFileOpen(left, "B.md");
  simulateNativeFileOpen(right, "B.md");
  controller.handleFileOpen("B.md");

  assert.equal(left.view.activeDom.file.path, "A.md");
  assert.equal(right.view.activeDom.file.path, "B.md");
});

test("synchronizes the native tree active item after restoring another view", () => {
  const left = leaf("left", ["A.md", "B.md"]);
  const right = leaf("right", ["A.md", "B.md"]);
  setSelection(left, "A.md");
  setSelection(right, "A.md");

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  simulateNativeFileOpen(left, "B.md");
  simulateNativeFileOpen(right, "B.md");
  controller.handleFileOpen("B.md");

  assert.equal(right.view.activeDom.file.path, "A.md");
  assert.equal(right.view.tree.activeDom.file.path, "A.md");
  assert.equal(right.view.tree.activeDom, right.view.activeDom);
  assert.equal(right.view.fileItems["A.md"].selfEl.classList.contains("is-active"), true);

  simulateNativeFileOpen(right, "B.md");
  assert.equal(right.view.activeDom.file.path, "B.md");
  assert.equal(right.view.tree.activeDom.file.path, "B.md");
  assert.equal(right.view.fileItems["B.md"].selfEl.classList.contains("is-active"), true);
});

test("restores each explorer's folder expansion after a cross-view file-open", () => {
  const left = leaf("left", ["A.md"], [["Projects", false], ["Projects/Alpha", true]]);
  const right = leaf("right", ["A.md"], [["Projects", true], ["Projects/Alpha", true]]);

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  controller.beginFileOpenInteraction(left, "A.md");
  setFolderCollapsed(right, "Projects", false);
  controller.handleFileOpen("A.md");

  assert.deepEqual(folderState(left), [
    { path: "Projects", collapsed: false },
    { path: "Projects/Alpha", collapsed: true },
  ]);
  assert.deepEqual(folderState(right), [
    { path: "Projects", collapsed: true },
    { path: "Projects/Alpha", collapsed: true },
  ]);
});

test("suppresses non-source auto-reveal before the native file-open handler runs", () => {
  const left = leaf("left", ["A.md"], [["Projects", false]]);
  const right = leaf("right", ["A.md"], [["Projects", true]]);

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  controller.beginFileOpenInteraction(left, "A.md");

  assert.equal(left.view.autoRevealFile, true);
  assert.equal(right.view.autoRevealFile, false);
  if (right.view.autoRevealFile) {
    setFolderCollapsed(right, "Projects", false);
  }

  controller.handleFileOpen("A.md");

  assert.equal(right.view.autoRevealFile, true);
  assert.deepEqual(folderState(right), [{ path: "Projects", collapsed: true }]);
});

test("restores auto-reveal settings after rapid consecutive source changes", () => {
  const left = leaf("left", ["A.md", "B.md"]);
  const right = leaf("right", ["A.md", "B.md"]);

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  controller.beginFileOpenInteraction(left, "A.md");
  controller.beginFileOpenInteraction(right, "B.md");

  assert.equal(left.view.autoRevealFile, false);
  assert.equal(right.view.autoRevealFile, true);

  controller.handleFileOpen("A.md");
  assert.equal(left.view.autoRevealFile, false);
  controller.handleFileOpen("B.md");
  assert.equal(left.view.autoRevealFile, true);
  assert.equal(right.view.autoRevealFile, true);
});

test("restores every explorer's folder expansion for an external file-open", () => {
  const left = leaf("left", ["A.md"], [["Projects", false]]);
  const right = leaf("right", ["A.md"], [["Archive", false]]);

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  setFolderCollapsed(left, "Projects", true);
  setFolderCollapsed(right, "Archive", true);
  controller.handleFileOpen("A.md");

  assert.deepEqual(folderState(left), [{ path: "Projects", collapsed: false }]);
  assert.deepEqual(folderState(right), [{ path: "Archive", collapsed: false }]);
});

test("uses the newest manual folder state before a file-open", async () => {
  const left = leaf("left", ["A.md"], [["Projects", true]]);
  const right = leaf("right", ["A.md"], [["Projects", true]]);

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  setFolderCollapsed(right, "Projects", false);
  right.view.containerEl.dispatch("click", {});
  await Promise.resolve();

  controller.beginFileOpenInteraction(left, "A.md");
  setFolderCollapsed(right, "Projects", true);
  controller.handleFileOpen("A.md");

  assert.deepEqual(folderState(right), [{ path: "Projects", collapsed: false }]);
});

test("captures and restores nested folder expansion in shallow/deep order", () => {
  const explorer = leaf("explorer", ["A.md"], [
    ["Projects", false],
    ["Projects/Alpha", false],
    ["Projects/Alpha/Notes", true],
  ]);
  const snapshot = captureNativeExplorerFolders(explorer.view);

  setFolderCollapsed(explorer, "Projects", true);
  setFolderCollapsed(explorer, "Projects/Alpha", true);
  setFolderCollapsed(explorer, "Projects/Alpha/Notes", false);
  const report = restoreNativeExplorerFolders(explorer.view, snapshot);

  assert.equal(report.supported, true);
  assert.equal(report.expandedFoldersRestored, 2);
  assert.equal(report.collapsedFoldersRestored, 1);
  assert.deepEqual(folderState(explorer), snapshot);
});

test("captures virtualized folder states from fileItems outside the DOM", () => {
  const explorer = leaf("explorer", ["A.md"], [["Visible", false]]);
  explorer.view.fileItems["Visible"] = nativeFolderItem("Visible", false);
  explorer.view.fileItems["Offscreen"] = nativeFolderItem("Offscreen", true);

  const snapshot = captureNativeExplorerFolders(explorer.view);

  assert.deepEqual(snapshot, [
    { path: "Visible", collapsed: false },
    { path: "Offscreen", collapsed: true },
  ]);
});

test("settles native async folder restoration before the caller continues", async () => {
  let resolveCollapse;
  const explorer = leaf("explorer", ["A.md"], []);
  const itemValue = nativeFolderItem("Projects", true, () => new Promise((resolve) => {
    resolveCollapse = resolve;
  }));
  explorer.view.fileItems["Projects"] = itemValue;
  explorer.view.containerEl.scrollTop = 420;
  const task = restoreNativeExplorerFoldersSettled(explorer.view, [
    { path: "Projects", collapsed: false },
  ]);

  assert.equal(itemValue.collapsed, false);
  let settled = false;
  void task.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  resolveCollapse();
  await task;
  assert.equal(settled, true);
  assert.equal(itemValue.collapsed, false);
});

test("does not replay an async folder restore during repeated file-open corrections", async () => {
  let resolveRestore;
  let restoreCalls = 0;
  const explorer = leaf("explorer", ["A.md"], []);
  const itemValue = nativeFolderItem("Projects", true, () => {
    restoreCalls += 1;
    explorer.view.containerEl.scrollTop = 999;
    explorer.view.containerEl.dispatch("scroll", { target: explorer.view.containerEl });
    return new Promise((resolve) => {
      resolveRestore = resolve;
    });
  });
  explorer.view.fileItems["Projects"] = itemValue;
  explorer.view.containerEl.scrollTop = 700;

  const controller = new ExplorerViewIsolationController(() => [explorer]);
  controller.refresh();
  itemValue.collapsed = false;
  controller.handleFileOpen("A.md");
  controller.handleFileOpen("A.md");

  assert.equal(restoreCalls, 1);
  resolveRestore();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(explorer.view.containerEl.scrollTop, 700);
});

test("captures a user's virtualized folder toggle after native scrolling settles", async () => {
  const explorer = leaf("explorer", ["A.md"], []);
  const itemValue = nativeFolderItem("Projects", true);
  explorer.view.fileItems["Projects"] = itemValue;
  explorer.view.containerEl.scrollTop = 900;

  const controller = new ExplorerViewIsolationController(() => [explorer]);
  controller.refresh();
  explorer.view.containerEl.scrollTop = 760;
  explorer.view.containerEl.dispatch("scroll", { target: explorer.view.containerEl });
  assert.equal(controller.states.get("explorer").scrollTop, 760);
  itemValue.collapsed = false;
  explorer.view.containerEl.scrollTop = 680;
  explorer.view.containerEl.dispatch("pointerdown", {
    button: 0,
    target: itemValue.selfEl,
  });
  explorer.view.containerEl.dispatch("click", { target: itemValue.selfEl });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = controller.states.get("explorer");
  assert.equal(state.scrollTop, 680);
  assert.deepEqual(state.folders, [{ path: "Projects", collapsed: false }]);
});

test("ignores missing folder paths while restoring expansion", () => {
  const explorer = leaf("explorer", ["A.md"], [["Projects", false]]);
  const report = restoreNativeExplorerFolders(explorer.view, [
    { path: "Deleted", collapsed: true },
    { path: "Projects", collapsed: true },
  ]);

  assert.equal(report.supported, true);
  assert.deepEqual(report.missingPaths, ["Deleted"]);
  assert.deepEqual(folderState(explorer), [{ path: "Projects", collapsed: true }]);
});

test("does not overwrite a newer interaction while an earlier open is pending", () => {
  const left = leaf("left", ["A.md", "B.md"]);
  const right = leaf("right", ["A.md", "B.md"]);
  setSelection(left, "A.md");
  setSelection(right, "A.md");

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  controller.beginFileOpenInteraction(left, "A.md");
  setSelection(right, "B.md");
  controller.rememberLeaf(right);

  simulateNativeFileOpen(left, "A.md");
  simulateNativeFileOpen(right, "A.md");
  controller.handleFileOpen("A.md");

  assert.equal(right.view.activeDom.file.path, "B.md");
});

test("does not classify context-menu clicks or ordinary arrow navigation as file opens", () => {
  const left = leaf("left", ["A.md", "B.md"]);
  const right = leaf("right", ["A.md", "B.md"]);
  setSelection(left, "A.md");
  setSelection(right, "B.md", [], "A.md");

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  right.view.containerEl.dispatch("pointerdown", {
    button: 2,
    target: right.view.fileItems["A.md"].selfEl,
  });
  right.view.containerEl.dispatch("keydown", {
    key: "ArrowDown",
    ctrlKey: false,
    metaKey: false,
    target: right.view.fileItems["A.md"].selfEl,
  });

  simulateNativeFileOpen(left, "A.md");
  simulateNativeFileOpen(right, "A.md");
  controller.handleFileOpen("A.md");

  assert.equal(left.view.activeDom.file.path, "A.md");
  assert.equal(right.view.activeDom.file.path, "B.md");
});

test("captures and restores active, multi-selected, and focused paths", () => {
  const explorer = leaf("explorer", ["A.md", "B.md", "C.md"]);
  setSelection(explorer, "A.md", ["B.md", "C.md"], "C.md");
  const snapshot = captureNativeExplorerSelection(explorer);

  setSelection(explorer, "B.md", [], "B.md");
  const report = restoreNativeExplorerSelection(explorer, snapshot);

  assert.equal(report.supported, true);
  assert.deepEqual(snapshot, {
    activePath: "A.md",
    selectedPaths: ["B.md", "C.md"],
    focusedPath: "C.md",
  });
  assert.equal(explorer.view.activeDom.file.path, "A.md");
  assert.deepEqual([...explorer.view.tree.selectedDoms].map((value) => value.file.path), ["B.md", "C.md"]);
  assert.equal(explorer.view.tree.focusedItem.file.path, "C.md");
});

test("ignores selection paths that no longer exist in the rebuilt explorer", () => {
  const explorer = leaf("explorer", ["A.md"]);
  const report = restoreNativeExplorerSelection(explorer, {
    activePath: "deleted.md",
    selectedPaths: ["deleted.md", "A.md"],
    focusedPath: "renamed.md",
  });

  assert.equal(report.supported, true);
  assert.equal(report.selectedPathsRestored, 1);
  assert.deepEqual(report.missingPaths, ["deleted.md", "renamed.md"]);
  assert.equal(explorer.view.activeDom, null);
});

test("copies a source selection to a new view without coupling later changes", () => {
  const source = leaf("source", ["A.md", "B.md"]);
  const target = leaf("target", ["A.md", "B.md"]);
  setSelection(source, "A.md", ["B.md"], "B.md");
  setSelection(target, "B.md");
  source.view.containerEl.scrollTop = 240;
  target.view.containerEl.scrollTop = 20;

  const controller = new ExplorerViewIsolationController(() => [source, target]);
  controller.refresh();
  controller.initializeLeafFrom(source, target);
  setSelection(target, "B.md");
  controller.rememberLeaf(target);

  assert.equal(source.view.activeDom.file.path, "A.md");
  assert.deepEqual([...source.view.tree.selectedDoms].map((value) => value.file.path), ["B.md"]);
  assert.equal(source.view.containerEl.scrollTop, 240);
  assert.equal(target.view.activeDom.file.path, "B.md");
  assert.deepEqual([...target.view.tree.selectedDoms], []);
  assert.equal(target.view.containerEl.scrollTop, 240);
});

test("copies folder expansion to a new view without coupling later changes", () => {
  const source = leaf("source", ["A.md"], [["Projects", false]]);
  const target = leaf("target", ["A.md"], [["Projects", true]]);

  const controller = new ExplorerViewIsolationController(() => [source, target]);
  controller.refresh();
  controller.initializeLeafFrom(source, target);

  assert.deepEqual(folderState(target), [{ path: "Projects", collapsed: false }]);
  setFolderCollapsed(target, "Projects", true);
  target.view.containerEl.dispatch("click", {});

  assert.deepEqual(folderState(source), [{ path: "Projects", collapsed: false }]);
  assert.deepEqual(folderState(target), [{ path: "Projects", collapsed: true }]);
});

test("restores the source selection after a cross-view drop while keeping the target result", () => {
  const source = leaf("source", ["A.md", "B.md", "C.md"]);
  const target = leaf("target", ["A.md", "B.md", "C.md"]);
  const third = leaf("third", ["A.md", "B.md", "C.md"]);
  setSelection(source, "A.md", ["B.md", "C.md"], "C.md");
  setSelection(target, "A.md");
  setSelection(third, "C.md", ["A.md"], "C.md");

  const controller = new ExplorerViewIsolationController(() => [source, target, third]);
  controller.refresh();
  controller.beginDragSelection(source, ["B.md"]);
  controller.captureDragDrop(target);

  setSelection(source, "B.md", ["B.md"], "B.md");
  setSelection(target, "B.md", ["B.md"], "B.md");
  setSelection(third, "B.md", ["B.md"], "B.md");
  controller.restoreDragSelection();

  assert.equal(source.view.activeDom.file.path, "A.md");
  assert.deepEqual([...source.view.tree.selectedDoms].map((value) => value.file.path), ["B.md", "C.md"]);
  assert.equal(source.view.tree.focusedItem.file.path, "C.md");
  assert.equal(target.view.activeDom.file.path, "B.md");
  assert.deepEqual([...target.view.tree.selectedDoms].map((value) => value.file.path), ["B.md"]);
  assert.equal(third.view.activeDom.file.path, "C.md");
  assert.deepEqual([...third.view.tree.selectedDoms].map((value) => value.file.path), ["A.md"]);
});

test("cleans moved paths from the source selection without throwing", () => {
  const source = leaf("source", ["A.md", "B.md", "C.md"]);
  const target = leaf("target", ["A.md", "B.md", "C.md"]);
  setSelection(source, "A.md", ["B.md", "C.md"], "C.md");
  setSelection(target, "A.md");

  const controller = new ExplorerViewIsolationController(() => [source, target]);
  controller.refresh();
  controller.beginDragSelection(source, ["B.md"]);
  controller.captureDragDrop(target);
  setSelection(source, "B.md", ["B.md"], "B.md");
  delete source.view.fileItems["B.md"];

  assert.doesNotThrow(() => controller.restoreDragSelection());
  assert.equal(source.view.activeDom.file.path, "A.md");
  assert.deepEqual([...source.view.tree.selectedDoms].map((value) => value.file.path), ["C.md"]);
});

test("does not let a rename capture overwrite an active drag selection session", async () => {
  const source = leaf("source", ["A.md", "B.md"]);
  const target = leaf("target", ["A.md", "B.md"]);
  setSelection(source, "A.md", ["B.md"], "A.md");
  setSelection(target, "A.md");

  const controller = new ExplorerViewIsolationController(() => [source, target]);
  controller.refresh();
  controller.beginDragSelection(source, ["B.md"]);
  controller.captureDragDrop(target);
  setSelection(source, "B.md", ["B.md"], "B.md");
  controller.scheduleCapture();
  await Promise.resolve();

  controller.restoreDragSelection();
  assert.equal(source.view.activeDom.file.path, "A.md");
  assert.deepEqual([...source.view.tree.selectedDoms].map((value) => value.file.path), ["B.md"]);
});

test("keeps non-source explorer scroll positions when a source opens a file", async () => {
  const left = leaf("left", ["A.md", "B.md"]);
  const right = leaf("right", ["A.md", "B.md"]);
  setSelection(left, "A.md");
  setSelection(right, "B.md");
  left.view.containerEl.scrollTop = 100;
  right.view.containerEl.scrollTop = 420;

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  right.view.containerEl.scrollTop = 510;
  right.view.containerEl.dispatch("scroll", { target: right.view.containerEl });
  await Promise.resolve();

  controller.beginFileOpenInteraction(left, "B.md");
  simulateNativeFileOpen(left, "B.md");
  simulateNativeFileOpen(right, "B.md");
  left.view.containerEl.scrollTop = 260;
  right.view.containerEl.scrollTop = 30;
  controller.handleFileOpen("B.md");
  await Promise.resolve();

  assert.equal(left.view.containerEl.scrollTop, 260);
  assert.equal(right.view.containerEl.scrollTop, 510);
});

test("keeps every explorer scroll position for an external file-open", async () => {
  const left = leaf("left", ["A.md", "B.md"]);
  const right = leaf("right", ["A.md", "B.md"]);
  setSelection(left, "A.md");
  setSelection(right, "B.md");
  left.view.containerEl.scrollTop = 150;
  right.view.containerEl.scrollTop = 375;

  const controller = new ExplorerViewIsolationController(() => [left, right]);
  controller.refresh();
  left.view.containerEl.scrollTop = 5;
  right.view.containerEl.scrollTop = 10;
  controller.handleFileOpen("B.md");
  await Promise.resolve();

  assert.equal(left.view.containerEl.scrollTop, 150);
  assert.equal(right.view.containerEl.scrollTop, 375);
});

test("reapplies the non-source scroll position after delayed native auto-reveal", async () => {
  const left = leaf("left", ["A.md", "B.md"]);
  const right = leaf("right", ["A.md", "B.md"]);
  setSelection(left, "A.md");
  setSelection(right, "B.md");
  left.view.containerEl.scrollTop = 100;
  right.view.containerEl.scrollTop = 600;

  const animationFrames = [];
  const previousWindow = globalThis.window;
  globalThis.window = {
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
  };
  try {
    const controller = new ExplorerViewIsolationController(() => [left, right]);
    controller.refresh();
    controller.beginFileOpenInteraction(left, "B.md");
    simulateNativeFileOpen(left, "B.md");
    simulateNativeFileOpen(right, "B.md");
    left.view.containerEl.scrollTop = 250;
    right.view.containerEl.scrollTop = 30;
    controller.handleFileOpen("B.md");
    await Promise.resolve();

    right.view.containerEl.scrollTop = 75;
    animationFrames.shift()();
    animationFrames.shift()();

    assert.equal(left.view.containerEl.scrollTop, 250);
    assert.equal(right.view.containerEl.scrollTop, 600);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("degrades safely when an explorer has no scrollable container", () => {
  const explorer = leaf("explorer", ["A.md"]);
  explorer.view.containerEl = undefined;
  const controller = new ExplorerViewIsolationController(() => [explorer]);

  assert.doesNotThrow(() => {
    controller.refresh();
    controller.handleFileOpen("A.md");
  });
});
