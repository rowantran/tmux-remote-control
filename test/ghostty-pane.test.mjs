import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ghosttyEnabled, resizeGhostty, GHOSTTY_SCRIPT } from "../bin/ghostty-pane.mjs";

function fixture({ rows = 35, cell = 19, total = 80, panes = 2, index = 1, vertical = true } = {}) {
  let height = rows * cell;
  const terminals = Array.from({ length: panes }, (_, i) => ({ id: `pane-${i}`, name: `original ${i}` }));
  const calls = [];
  const titles = [];
  const io = {
    snapshot: async () => structuredClone([{ terminals }]),
    title: (text) => { titles.push(text); if (terminals[index]) terminals[index].name = text; },
    rows: async () => Math.floor(height / cell),
    sleep: async () => {},
    action: async (state, action) => {
      calls.push({ id: state.id, siblingId: state.siblingId, action });
      if (action === "equalize_splits") height = total * cell / 2;
      else if (vertical) {
        const [, direction, pixels] = action.match(/^resize_split:(up|down),(\d+)$/);
        height = Math.max(total * cell * 0.1, Math.min(total * cell * 0.9,
          height + (direction === "up" ? 1 : -1) * Number(pixels)));
      }
      return true;
    },
  };
  return { io, calls, titles };
}

test("auto-sizing only runs in a direct, local macOS Ghostty TTY", () => {
  const env = { TERM_PROGRAM: "ghostty" };
  assert.equal(ghosttyEnabled(env, "darwin", true), true);
  for (const [key, value] of Object.entries({ TERM_PROGRAM: "other", TMUX_REMOTE_CONTROL_GHOSTTY_RESIZE: "0",
    TMUX: "/tmp/tmux", STY: "screen", SSH_TTY: "/dev/pts/0", SSH_CONNECTION: "remote" })) {
    assert.equal(ghosttyEnabled({ ...env, [key]: value }, "darwin", true), false, key);
  }
  assert.equal(ghosttyEnabled(env, "linux", true), false);
  assert.equal(ghosttyEnabled(env, "darwin", false), false);
});

test("compact sizing learns pixel-to-row conversion across font sizes and initial heights", async () => {
  for (const cell of [8, 13.5, 19, 24, 38, 60]) {
    for (const rows of [8, 16, 25, 60, 70]) {
      const { io, calls, titles } = fixture({ rows, cell });
      const state = {};
      assert.equal(await resizeGhostty(state, "compact", io), true);
      const result = await io.rows();
      assert.ok(Math.abs(result - 8) <= 1, `${cell}px cell, ${rows} initial rows: got ${result}`);
      assert.ok(calls.length <= 7);
      assert.equal(state.id, "pane-1");
      assert.equal(state.siblingId, "pane-0");
      assert.match(titles[0], /^tmux-remote-control-/);
      assert.equal(titles.at(-1), "original 1");
    }
  }
});

test("editor/history expand to half, then compact using the same pinned pane", async () => {
  const { io, calls, titles } = fixture();
  const state = {};
  await resizeGhostty(state, "compact", io);
  const titleCount = titles.length;
  // Changed titles/focus must never cause a new identity lookup.
  io.snapshot = async () => { throw new Error("must not identify again"); };
  await resizeGhostty(state, "expanded", io);
  assert.equal(await io.rows(), 40);
  await resizeGhostty(state, "compact", io);
  assert.ok(Math.abs(await io.rows() - 8) <= 1);
  assert.equal(titles.length, titleCount);
  assert.ok(calls.every((call) => call.id === "pane-1" && call.siblingId === "pane-0"));
});

test("editor-first establishes the pane identity before expanding", async () => {
  const { io, calls } = fixture({ total: 80 });
  assert.equal(await resizeGhostty({}, "expanded", io), true);
  assert.equal(await io.rows(), 40);
  assert.equal(calls.at(-1).action, "equalize_splits");
});

test("single panes, extra splits and the top pane are left unchanged", async () => {
  for (const options of [{ panes: 1, index: 0 }, { panes: 3 }, { index: 0 }]) {
    const { io, calls, titles } = fixture(options);
    assert.equal(await resizeGhostty({}, "expanded", io), false);
    assert.equal(calls.length, 0);
    assert.equal(titles.at(-1), `original ${options.index ?? 1}`);
  }
});

test("side-by-side panes are not equalized or horizontally resized", async () => {
  const { io, calls } = fixture({ vertical: false });
  assert.equal(await resizeGhostty({}, "expanded", io), false);
  assert.equal(await io.rows(), 35);
  assert.deepEqual(calls.map((call) => call.action), ["resize_split:up,64", "resize_split:down,64"]);
});

test("Ghostty minimum split ratio stops compact retries when 8 rows is impossible", async () => {
  const { io, calls } = fixture({ rows: 100, total: 300 });
  assert.equal(await resizeGhostty({}, "compact", io), true);
  assert.equal(await io.rows(), 30);
  assert.ok(calls.length <= 7);
});

test("small windows stop at Ghostty's maximum split ratio", async () => {
  const { io, calls } = fixture({ rows: 3, total: 6 });
  assert.equal(await resizeGhostty({}, "compact", io), true);
  assert.equal(await io.rows(), 5);
  assert.ok(calls.length <= 7);
});

test("automation failures propagate so the controller can disable further attempts", async () => {
  const { io, titles } = fixture();
  io.action = async () => false;
  await assert.rejects(resizeGhostty({}, "compact", io), /layout is unavailable/);
  assert.equal(titles.at(-1), "original 1");
});

test("failure during title discovery resets the temporary marker without resizing", async () => {
  const { io, calls, titles } = fixture();
  const snapshot = io.snapshot;
  let reads = 0;
  io.snapshot = () => { if (++reads > 1) throw new Error("denied"); return snapshot(); };
  await assert.rejects(resizeGhostty({}, "compact", io), /denied/);
  assert.equal(titles.at(-1), "");
  assert.equal(calls.length, 0);
});

test("a locked title fails closed rather than using the focused terminal", async () => {
  const { io, calls } = fixture();
  io.title = () => {};
  assert.equal(await resizeGhostty({}, "expanded", io), false);
  assert.equal(calls.length, 0);
});

test("native automation validates the exact two-pane pair before performing actions", () => {
  let ids = ["sibling", "controller"];
  const actions = [];
  const app = {
    running: () => true,
    windows: () => [{ tabs: () => [{ terminals: () => ids.map((id) => ({ id: () => id, name: () => `title ${id}` })) }] }],
    terminals: { byId: (id) => ({ id }) },
    performAction: (name, options) => { actions.push({ name, id: options.on.id }); return true; },
  };
  const context = { Application: (name) => { assert.equal(name, "Ghostty"); return app; } };
  runInNewContext(GHOSTTY_SCRIPT, context);
  const run = (...args) => JSON.parse(context.run(args));
  assert.deepEqual(run("snapshot"), [{ terminals: [
    { id: "sibling", name: "title sibling" }, { id: "controller", name: "title controller" },
  ] }]);
  assert.equal(run("action", "controller", "sibling", "equalize_splits"), true);
  assert.deepEqual(actions, [{ name: "equalize_splits", id: "controller" }]);
  // Missing/replaced panes, an extra split, or reversed order must never
  // resize another surface. Titles and focus are deliberately not consulted.
  for (const layout of [["controller"], ["sibling", "replacement"], ["new", "controller"],
    ["sibling", "controller", "new"], ["controller", "sibling"]]) {
    ids = layout;
    assert.equal(run("action", "controller", "sibling", "equalize_splits"), false);
  }
  assert.equal(actions.length, 1);
  ids = ["sibling", "controller"];
  app.performAction = () => false;
  assert.equal(run("action", "controller", "sibling", "resize_split:down,100"), false);
  assert.doesNotMatch(GHOSTTY_SCRIPT, /focused|frontWindow|\.focus\(/);
});
