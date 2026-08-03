import assert from "node:assert/strict";
import { test } from "node:test";
import esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/drag-scroll-guard.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const module = { exports: {} };
new Function("module", "exports", result.outputFiles[0].text)(module, module.exports);
const { ExplorerDragScrollGuard } = module.exports;

class FakeElement {
  constructor(scrollTop = 0) {
    this.nodeType = 1;
    this.scrollTop = scrollTop;
  }
}

function leaf(id, scrollTop) {
  return {
    id,
    view: {
      containerEl: new FakeElement(scrollTop),
    },
  };
}

function createWindowScheduler() {
  const frames = [];
  const timers = [];
  return {
    frames,
    timers,
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout() {},
  };
}

test("restores every explorer to its scroll position at drop time", async () => {
  const source = leaf("source", 100);
  const target = leaf("target", 220);
  const leaves = [source, target];
  const scheduler = createWindowScheduler();
  const previousWindow = globalThis.window;
  globalThis.window = scheduler;
  try {
    const restored = [];
    const guard = new ExplorerDragScrollGuard(() => leaves, () => restored.push(true));
    guard.beginDrag();
    target.view.containerEl.scrollTop = 360;
    guard.captureDrop();

    source.view.containerEl.scrollTop = 900;
    target.view.containerEl.scrollTop = 20;
    await Promise.resolve();

    assert.equal(source.view.containerEl.scrollTop, 100);
    assert.equal(target.view.containerEl.scrollTop, 360);
    assert.equal(restored.length, 1);

    source.view.containerEl.scrollTop = 901;
    target.view.containerEl.scrollTop = 21;
    scheduler.frames.shift()();
    scheduler.frames.shift()();
    assert.equal(source.view.containerEl.scrollTop, 100);
    assert.equal(target.view.containerEl.scrollTop, 360);

    guard.completeDrop();
    for (const callback of [...scheduler.timers]) {
      callback();
    }
    assert.equal(source.view.containerEl.scrollTop, 100);
    assert.equal(target.view.containerEl.scrollTop, 360);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("does not let an older drag restore over a newer drag", async () => {
  const source = leaf("source", 100);
  const target = leaf("target", 220);
  const leaves = [source, target];
  const scheduler = createWindowScheduler();
  const previousWindow = globalThis.window;
  globalThis.window = scheduler;
  try {
    const guard = new ExplorerDragScrollGuard(() => leaves);
    guard.beginDrag();
    guard.captureDrop();
    source.view.containerEl.scrollTop = 1;

    guard.beginDrag();
    source.view.containerEl.scrollTop = 500;
    target.view.containerEl.scrollTop = 600;
    guard.captureDrop();
    source.view.containerEl.scrollTop = 2;
    target.view.containerEl.scrollTop = 3;
    await Promise.resolve();

    assert.equal(source.view.containerEl.scrollTop, 500);
    assert.equal(target.view.containerEl.scrollTop, 600);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("cancels trailing restoration after user input", async () => {
  const source = leaf("source", 100);
  const target = leaf("target", 220);
  const scheduler = createWindowScheduler();
  const previousWindow = globalThis.window;
  globalThis.window = scheduler;
  try {
    const guard = new ExplorerDragScrollGuard(() => [source, target]);
    guard.beginDrag();
    guard.captureDrop();
    guard.cancelPendingRestore();
    source.view.containerEl.scrollTop = 700;
    target.view.containerEl.scrollTop = 800;
    await Promise.resolve();

    assert.equal(source.view.containerEl.scrollTop, 700);
    assert.equal(target.view.containerEl.scrollTop, 800);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("skips leaves without a scroll container", () => {
  const explorer = leaf("explorer", 100);
  explorer.view.containerEl = undefined;
  const guard = new ExplorerDragScrollGuard(() => [explorer]);

  assert.doesNotThrow(() => {
    guard.beginDrag();
    guard.captureDrop();
    guard.completeDrop();
  });
});
