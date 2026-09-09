import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { aerospaceEnabled, resizeAerospace, systemIO, SNAPSHOT_SCRIPT, BOUNDS_SCRIPT, WINDOW_FORMAT } from "../bin/aerospace-window.mjs";

function fixture({ rows = 35, cell = 19, total = 80, minimum = 3, chrome = 28, partial = 0, clamp = true } = {}) {
  let height = rows * cell + chrome + partial;
  const totalHeight = total * cell + 2 * chrome;
  const calls = [];
  const titles = [];
  const stats = { snapshots: [], bounds: 0, sleeps: [], heights: [] };
  const window = { id: 22, title: "original", appId: "com.mitchellh.ghostty", workspace: "work", monitor: 1,
    layout: "v_tiles", rootLayout: "v_tiles", fullscreen: false, visible: true, onScreen: true };
  const sibling = { ...window, id: 11, title: "other app", appId: "org.mozilla.firefox" };
  const terminal = { id: "terminal", name: "original" };
  const native = { id: "native", name: "original", tabs: [{ terminals: [terminal] }] };
  const snapshot = { windows: [window, sibling], terminals: [native] }; // Deliberately not spatial order.
  const updateBounds = () => {
    sibling.bounds = { X: 10, Y: 30, Width: 1000, Height: totalHeight - height };
    window.bounds = { X: 10, Y: 30 + sibling.bounds.Height + 12, Width: 1000, Height: height };
  };
  updateBounds();
  const io = {
    snapshot: async (state) => { stats.snapshots.push(state?.ghosttyWindowId); return structuredClone(snapshot); },
    bounds: async () => {
      stats.bounds++;
      return structuredClone(snapshot.windows.map(({ id, bounds, onScreen }) => ({ id, bounds, onScreen })));
    },
    title: (text) => { titles.push(text); terminal.name = text; native.name = text; window.title = text; },
    rows: async () => Math.floor((height - chrome) / cell),
    sleep: async (ms) => { stats.sleeps.push(ms); },
    resize: async (id, points) => {
      calls.push({ id, points });
      assert.equal(id, 22);
      assert.ok(Number.isInteger(points) && points !== 0);
      const nextHeight = height + points;
      assert.ok(nextHeight > 0 && nextHeight < totalHeight, "both tile heights must stay positive");
      height = clamp ? Math.max(minimum * cell + chrome, Math.min(totalHeight - minimum * cell - chrome, nextHeight)) : nextHeight;
      updateBounds();
      stats.heights.push(height);
    },
  };
  return { io, calls, titles, stats, snapshot, window, sibling, native, terminal,
    setFont: (size) => { cell = size; },
    setHeight: (size) => { height = size; updateBounds(); },
    setMinimum: (rows) => { minimum = rows; },
  };
}

test("enabled only in a direct local macOS Ghostty TTY with the new opt-out", () => {
  const env = { TERM_PROGRAM: "ghostty" };
  assert.equal(aerospaceEnabled(env, "darwin", true), true);
  for (const [key, value] of Object.entries({ TERM_PROGRAM: "other", TMUX_REMOTE_CONTROL_AEROSPACE_RESIZE: "0",
    TMUX: "/tmp/tmux", STY: "screen", SSH_TTY: "/dev/pts/0", SSH_CONNECTION: "remote" })) {
    assert.equal(aerospaceEnabled({ ...env, [key]: value }, "darwin", true), false, key);
  }
  assert.equal(aerospaceEnabled(env, "linux", true), false);
  assert.equal(aerospaceEnabled(env, "darwin", false), false);
});

test("compact learns points per row across font sizes, window heights and chrome", async () => {
  for (const cell of [8, 13.5, 19, 24, 38, 60]) {
    for (const rows of [3, 8, 10, 16, 25, 60, 70]) {
      for (const chrome of [0, 28, 80]) {
        const { io, calls, titles } = fixture({ rows, cell, chrome });
        const state = {};
        assert.equal(await resizeAerospace(state, "compact", io), true);
        const result = await io.rows();
        assert.ok(Math.abs(result - 8) <= 1, `${cell}px cell, ${rows} initial rows, ${chrome} chrome: got ${result}`);
        assert.ok(calls.length <= 5);
        if (calls.length) assert.ok(Math.abs(calls[0].points) <= 64, "initial calibration step must be small");
        assert.equal(state.id, 22);
        assert.equal(state.siblingId, 11);
        assert.equal(state.terminalId, "terminal");
        assert.match(titles[0], /^tmux-remote-control-/);
        assert.equal(titles.at(-1), "original");
      }
    }
  }
});

test("partial rows never overestimate cell height or request invalid unclamped tile weights", async () => {
  for (const cell of [8, 13.5, 19, 24, 38, 60]) {
    for (const rows of [10, 25, 70]) {
      for (const partial of [cell * 0.25, cell * 0.5, cell * 0.9]) {
        const f = fixture({ rows, cell, partial, clamp: false });
        const resize = f.io.resize;
        f.io.resize = (id, points) => {
          const donor = points < 0 ? f.window : f.sibling;
          assert.ok(Math.abs(points) <= donor.bounds.Height / 2, "retain half of the shrinking window");
          return resize(id, points);
        };
        const state = {};
        assert.equal(await resizeAerospace(state, "compact", f.io), true);
        assert.ok(Math.abs(await f.io.rows() - 8) <= 1, `${cell}px cell, ${rows} rows, ${partial} spare points`);
        assert.ok(state.pointsPerRow <= cell, "calibration must be conservative");
        assert.ok(f.calls.length <= 5);
      }
    }
  }
  // Regression: a -64 probe changes 25 -> 24 rows, not two rows. Dividing by
  // that one row used to request -1024 next, taking a 944-point tile negative.
  const f = fixture({ rows: 25, cell: 38, partial: 30, clamp: false });
  await resizeAerospace({}, "compact", f.io);
  assert.ok(Math.abs(await f.io.rows() - 8) <= 1);
});

test("editor/history use half the available tile height and keep identity after focus/title changes", async () => {
  const { io, calls, titles, window, sibling, terminal } = fixture();
  const state = {};
  await resizeAerospace(state, "compact", io);
  const titleCount = titles.length;
  window.title = terminal.name = "changed while another app has focus";
  // No focus lookup exists; the two explicit IDs remain the only targets.
  await resizeAerospace(state, "expanded", io);
  assert.equal(await io.rows(), 40);
  assert.equal(window.bounds.Height, sibling.bounds.Height);
  await resizeAerospace(state, "compact", io);
  assert.ok(Math.abs(await io.rows() - 8) <= 1);
  assert.equal(titles.length, titleCount);
  assert.ok(calls.every((call) => call.id === 22));
});

test("steady transitions use one resize, one targeted check, one frame measurement and no fixed sleeps", async () => {
  for (const options of [{ total: 56, rows: 20 }, { cell: 38, partial: 30 }, { cell: 13.5, chrome: 80 }]) {
    const f = fixture(options);
    let state = {};
    await resizeAerospace(state, "compact", f.io);
    const compactHeight = f.window.bounds.Height;
    const compactRows = await f.io.rows();
    assert.ok(state.compact);
    for (const mode of ["expanded", "compact", "expanded", "compact"]) {
      // The real controller starts a new Node helper for each transition.
      state = JSON.parse(JSON.stringify(state));
      const beforeCalls = f.calls.length;
      f.stats.snapshots.length = f.stats.sleeps.length = f.stats.heights.length = 0;
      f.stats.bounds = 0;
      await resizeAerospace(state, mode, f.io);
      assert.equal(f.calls.length - beforeCalls, 1, mode);
      assert.deepEqual(f.stats.snapshots, ["native"], mode);
      assert.equal(f.stats.bounds, 1, mode);
      assert.deepEqual(f.stats.sleeps, [], mode);
      if (mode === "compact") {
        assert.deepEqual(f.stats.heights, [compactHeight], "no intermediate 13-row frame");
        assert.equal(await f.io.rows(), compactRows);
      } else {
        assert.ok(Math.abs(f.window.bounds.Height - f.sibling.bounds.Height) <= 1);
      }
    }
  }
});

test("a window already near 8 rows is remembered before the first expansion", async () => {
  const f = fixture({ rows: 8 });
  const state = {};
  const height = f.window.bounds.Height;
  await resizeAerospace(state, "expanded", f.io);
  assert.equal(state.compact.height, height);
  const count = f.calls.length;
  await resizeAerospace(state, "compact", f.io);
  assert.equal(f.calls.length - count, 1);
  assert.equal(f.window.bounds.Height, height);
});

test("font, frame and display changes invalidate cached sizing and retain bounded calibration", async () => {
  const changes = [
    (f) => f.setFont(38),
    (f) => f.setHeight(f.window.bounds.Height + 60),
    (f) => { f.window.monitor = f.sibling.monitor = 2; },
  ];
  for (const change of changes) {
    const f = fixture();
    const state = {};
    await resizeAerospace(state, "compact", f.io);
    await resizeAerospace(state, "expanded", f.io);
    change(f);
    const count = f.calls.length;
    await resizeAerospace(state, "compact", f.io);
    assert.ok(Math.abs(f.calls[count].points) <= 64, "stale cache must not bypass calibration");
    assert.ok(Math.abs(await f.io.rows() - 8) <= 1);
    assert.equal(state.compact.height, f.window.bounds.Height);
  }
});

test("a native minimum must not cache an unobserved requested compact height", async () => {
  const f = fixture();
  const state = {};
  await resizeAerospace(state, "compact", f.io);
  await resizeAerospace(state, "expanded", f.io);
  f.setMinimum(15);
  await resizeAerospace(state, "compact", f.io);
  assert.equal(await f.io.rows(), 15);
  assert.equal(state.compact, undefined);
});

test("late terminal row updates are awaited without repeating native scans", async () => {
  const f = fixture({ rows: 8 });
  const state = {};
  await resizeAerospace(state, "compact", f.io);
  const realRows = f.io.rows;
  let delayed = 0;
  const resize = f.io.resize;
  f.io.resize = async (...args) => { await resize(...args); delayed = 2; };
  f.io.rows = async () => delayed-- > 0 ? 8 : realRows();
  f.stats.snapshots.length = f.stats.sleeps.length = 0;
  await resizeAerospace(state, "expanded", f.io);
  assert.equal(state.compact.anchor.rows, await realRows());
  assert.deepEqual(f.stats.snapshots, ["native"]);
  assert.deepEqual(f.stats.sleeps, [20, 20]);
});

test("cached shrinking waits through intermediate row counts without another resize", async () => {
  const f = fixture({ rows: 8 });
  const state = {};
  await resizeAerospace(state, "expanded", f.io);
  const realRows = f.io.rows;
  const oldRows = await realRows();
  const resize = f.io.resize;
  let delayed = [];
  f.io.resize = async (...args) => { await resize(...args); delayed = [oldRows, 13]; };
  f.io.rows = async () => delayed.length ? delayed.shift() : realRows();
  const count = f.calls.length;
  f.stats.sleeps.length = 0;
  await resizeAerospace(state, "compact", f.io);
  assert.equal(f.calls.length - count, 1);
  assert.equal(await realRows(), 8);
  assert.deepEqual(f.stats.sleeps, [20, 20]);
});

test("row synchronization timeout stops rather than applying extra shrinks", async () => {
  for (const cached of [false, true]) {
    const f = fixture({ rows: cached ? 8 : 35 });
    const state = {};
    if (cached) await resizeAerospace(state, "expanded", f.io);
    const oldRows = await f.io.rows();
    f.io.rows = async () => oldRows; // Kernel dimensions never catch up.
    const count = f.calls.length;
    await assert.rejects(resizeAerospace(state, "compact", f.io), /row count did not settle/);
    assert.equal(f.calls.length - count, 1, "must not calibrate from stale rows");
    if (cached) assert.equal(f.window.bounds.Height, state.compact.height);
  }
});

test("late frame updates do not cache an intermediate height or repeat the resize", async () => {
  const f = fixture({ rows: 8 });
  const state = {};
  await resizeAerospace(state, "compact", f.io);
  const oldFrames = await f.io.bounds();
  const realBounds = f.io.bounds;
  let delayed = 2;
  f.io.bounds = async () => delayed-- > 0 ? oldFrames : realBounds();
  f.stats.snapshots.length = f.stats.sleeps.length = 0;
  const count = f.calls.length;
  await resizeAerospace(state, "expanded", f.io);
  assert.equal(f.calls.length - count, 1);
  assert.equal(state.compact.anchor.height, f.window.bounds.Height);
  assert.equal(state.compact.anchor.rows, await f.io.rows());
  assert.deepEqual(f.stats.snapshots, ["native"]);
  assert.deepEqual(f.stats.sleeps, [20, 20]);
  await resizeAerospace(state, "compact", f.io);
  assert.equal(f.calls.length - count, 2, "cache remains usable after a delayed expansion");
});

test("post-resize frame measurement failures propagate without a blind second resize", async () => {
  const f = fixture({ rows: 8 });
  const state = {};
  await resizeAerospace(state, "compact", f.io);
  f.io.bounds = async () => [];
  const count = f.calls.length;
  await assert.rejects(resizeAerospace(state, "expanded", f.io), /layout is unavailable/);
  assert.equal(f.calls.length - count, 1);
});

test("editor-first identifies the window and expands without a probing resize", async () => {
  const { io, calls } = fixture();
  assert.equal(await resizeAerospace({}, "expanded", io), true);
  assert.equal(await io.rows(), 40);
  assert.equal(calls.length, 1);
});

test("editor-first calibration without a compact anchor is reset across helper invocations", async () => {
  const f = fixture();
  let state = {};
  await resizeAerospace(state, "expanded", f.io);
  assert.equal(state.compact, undefined);
  assert.equal(state.calibrated, true);
  state = JSON.parse(JSON.stringify(state));
  f.setFont(38);
  const count = f.calls.length;
  await resizeAerospace(state, "compact", f.io);
  assert.ok(Math.abs(f.calls[count].points) <= 64);
  assert.ok(Math.abs(await f.io.rows() - 8) <= 1);
});

const unsupported = {
  "single window": (f) => f.snapshot.windows.pop(),
  "third window": (f) => f.snapshot.windows.push({ ...f.sibling, id: 33 }),
  "native split": (f) => f.native.tabs[0].terminals.push({ id: "split", name: "split" }),
  "native tab": (f) => f.native.tabs.push({ terminals: [{ id: "tab", name: "tab" }] }),
  "top window": (f) => { [f.window.bounds, f.sibling.bounds] = [f.sibling.bounds, f.window.bounds]; },
  "horizontal tiles": (f) => { f.window.layout = f.sibling.layout = "h_tiles"; },
  "horizontal root": (f) => { f.window.rootLayout = "h_tiles"; },
  "accordion": (f) => { f.window.layout = "v_accordion"; },
  "floating sibling": (f) => { f.sibling.layout = "floating"; },
  "fullscreen controller": (f) => { f.window.fullscreen = true; },
  "fullscreen sibling": (f) => { f.sibling.fullscreen = true; },
  "hidden workspace": (f) => { f.window.visible = false; },
  "off-screen window": (f) => { f.window.onScreen = false; },
  "different monitor": (f) => { f.sibling.monitor = 2; },
  "overlapping frames": (f) => { f.window.bounds.Y = f.sibling.bounds.Y; },
  "unaligned frames": (f) => { f.window.bounds.X += 1000; },
  "different widths": (f) => { f.window.bounds.Width /= 2; },
  "missing bounds": (f) => { delete f.window.bounds; },
  "invalid bounds": (f) => { f.window.bounds.Height = NaN; },
};

test("unsupported layouts never resize or rebalance anything", async () => {
  for (const [label, change] of Object.entries(unsupported)) {
    const f = fixture();
    change(f);
    assert.equal(await resizeAerospace({}, "expanded", f.io), false, label);
    assert.equal(f.calls.length, 0, label);
    assert.equal(f.titles.at(-1), "original", label);
  }
});

test("every later action rechecks the pair, workspace and standalone terminal", async () => {
  const changes = { ...unsupported,
    "replaced sibling": (f) => { f.sibling.id = 33; },
    "replaced controller": (f) => { f.window.id = 44; },
    "moved workspace": (f) => { f.window.workspace = f.sibling.workspace = "new"; },
    "replaced terminal": (f) => { f.terminal.id = "new"; },
    "replaced native window": (f) => { f.native.id = "new"; },
  };
  for (const [label, change] of Object.entries(changes)) {
    const f = fixture();
    const state = {};
    await resizeAerospace(state, "compact", f.io);
    const count = f.calls.length;
    change(f);
    await assert.rejects(resizeAerospace(state, "expanded", f.io), /layout is unavailable/, label);
    assert.equal(f.calls.length, count, label);
  }
});

test("a single fresh identity/layout check rejects changed windows before either transition", async () => {
  for (const mode of ["expanded", "compact"]) {
    const f = fixture();
    const state = {};
    await resizeAerospace(state, "compact", f.io);
    if (mode === "compact") await resizeAerospace(state, "expanded", f.io);
    const count = f.calls.length;
    const snapshot = f.io.snapshot;
    let reads = 0;
    f.io.snapshot = async (state) => { reads++; f.sibling.id = 33; return snapshot(state); };
    await assert.rejects(resizeAerospace(state, mode, f.io), /layout is unavailable/);
    assert.equal(f.calls.length, count);
    assert.equal(reads, 1);
  }
});

test("minimum sizes and small displays bound compact retries", async () => {
  for (const options of [{ rows: 100, total: 300, minimum: 30 }, { rows: 3, total: 6, minimum: 1 }]) {
    const { io, calls } = fixture(options);
    assert.equal(await resizeAerospace({}, "compact", io), true);
    assert.equal(await io.rows(), options.total === 6 ? 5 : 30);
    assert.ok(calls.length <= 5);
  }
});

test("locked or ambiguous titles fail closed, never using focus or inherited AEROSPACE_WINDOW_ID", async () => {
  for (const ambiguous of [false, true]) {
    const f = fixture();
    if (!ambiguous) f.io.title = () => {};
    else {
      const title = f.io.title;
      f.snapshot.windows.push({ ...f.window, id: 33, workspace: "elsewhere" });
      f.io.title = (text) => { title(text); f.snapshot.windows.at(-1).title = text; };
    }
    assert.equal(await resizeAerospace({}, "expanded", f.io), false);
    assert.equal(f.calls.length, 0);
  }
});

test("automation failures restore the title and propagate to disable further attempts", async () => {
  const f = fixture();
  f.io.resize = async () => { throw new Error("denied"); };
  await assert.rejects(resizeAerospace({}, "compact", f.io), /denied/);
  assert.equal(f.titles.at(-1), "original");
  const snapshot = f.io.snapshot;
  let reads = 0;
  f.io.snapshot = () => { if (++reads > 1) throw new Error("unavailable"); return snapshot(); };
  await assert.rejects(resizeAerospace({}, "expanded", f.io), /unavailable/);
  assert.equal(f.titles.at(-1), "");
  assert.equal(f.calls.length, 0);
});

test("system IO uses JSON discovery and explicit ID height commands, not focus or balance-sizes", async () => {
  const calls = [];
  const io = systemIO(async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "osascript") {
      const bounds = [{ id: 22, bounds: { Height: 500 }, onScreen: true }];
      return JSON.stringify(args[3] === BOUNDS_SCRIPT ? bounds : { terminals: [], bounds });
    }
    if (command === "stty") return "8 100";
    if (args[0] === "list-windows") return JSON.stringify([{ "window-id": 22, "window-title": "quotes ' \" and\nnewlines",
      "app-bundle-id": "com.mitchellh.ghostty", workspace: "work", "monitor-id": 1,
      "window-parent-container-layout": "v_tiles", "workspace-root-container-layout": "v_tiles",
      "window-is-fullscreen": false, "workspace-is-visible": true }]);
    return "";
  });
  const snapshot = await io.snapshot();
  assert.equal(snapshot.windows[0].title, "quotes ' \" and\nnewlines");
  assert.equal(snapshot.windows[0].bounds.Height, 500);
  assert.equal(snapshot.windows[0].onScreen, true);
  assert.deepEqual(calls[0].args, ["list-windows", "--all", "--json", "--format", WINDOW_FORMAT]);
  const state = { id: 22, siblingId: 11, ghosttyWindowId: "native" };
  await io.snapshot(state);
  assert.deepEqual(calls.at(-1).args, ["-l", "JavaScript", "-e", SNAPSHOT_SCRIPT, "native"]);
  assert.deepEqual(await io.bounds(state), [{ id: 22, bounds: { Height: 500 }, onScreen: true }]);
  assert.deepEqual(calls.at(-1).args, ["-l", "JavaScript", "-e", BOUNDS_SCRIPT, "22", "11"]);
  await io.resize(22, -100);
  await io.resize(22, 100);
  assert.deepEqual(calls.slice(-2).map((c) => c.args), [
    ["resize", "--window-id", "22", "height", "-100"], ["resize", "--window-id", "22", "height", "+100"],
  ]);
  assert.equal(await io.rows(), 8);
  assert.equal(calls.at(-1).options.terminalInput, true);
  for (const [id, points] of [["22;focus", 1], [0, 1], [22, 0], [22, NaN], [22, 1e6]]) {
    await assert.rejects(io.resize(id, points), /invalid AeroSpace resize/);
  }
});

test("system IO rejects invalid terminal sizes and propagates CLI failures", async () => {
  for (const size of ["0 100", "NaN 100", "1.5 100", "65536 100", ""]) {
    await assert.rejects(systemIO(async () => size).rows(), /invalid terminal size/);
  }
  const io = systemIO(async () => { throw new Error("CLI unavailable"); });
  await assert.rejects(io.snapshot(), /CLI unavailable/);
  await assert.rejects(io.resize(22, -10), /CLI unavailable/);
});

test("opposite resize movement disables sizing instead of repeatedly adjusting", async () => {
  const f = fixture();
  const resize = f.io.resize;
  f.io.resize = (id, points) => resize(id, -points);
  await assert.rejects(resizeAerospace({}, "compact", f.io), /layout changed/);
  assert.equal(f.calls.length, 1);
});

test("native snapshot reads bounds and terminal structure without mutating Ghostty", () => {
  const native = { id: () => "native", name: () => "title", tabs: () => [{
    terminals: () => [{ id: () => "terminal", name: () => "title" }],
  }] };
  const context = {
    ObjC: { import: () => {}, castRefToObject: (x) => x, deepUnwrap: (x) => x },
    $: { CGWindowListCopyWindowInfo: () => [{ kCGWindowNumber: 22, kCGWindowBounds: { Height: 500 }, kCGWindowIsOnscreen: true }] },
    Application: (name) => { assert.equal(name, "Ghostty"); return { running: () => true, windows: () => [native] }; },
  };
  runInNewContext(SNAPSHOT_SCRIPT, context);
  assert.deepEqual(JSON.parse(context.run([])), {
    bounds: [{ id: 22, bounds: { Height: 500 }, onScreen: true }],
    terminals: [{ id: "native", name: "title", tabs: [{ terminals: [{ id: "terminal", name: "title" }] }] }],
  });
  assert.doesNotMatch(SNAPSHOT_SCRIPT, /performAction|\.focus\(|frontWindow|resize_split|equalize_splits/);

  const windows = () => { throw new Error("must not enumerate unrelated Ghostty windows"); };
  windows.byId = (id) => { assert.equal(id, "native"); return native; };
  native.name = () => { throw new Error("must not read titles after discovery"); };
  context.Application = () => ({ running: () => true, windows });
  assert.equal(JSON.parse(context.run(["native"])).terminals[0].id, "native");
  assert.equal(JSON.parse(context.run(["native"])).terminals[0].name, "");

  context.Application = () => { throw new Error("frame measurements must not query Ghostty"); };
  runInNewContext(BOUNDS_SCRIPT, context);
  assert.deepEqual(JSON.parse(context.run(["22", "11"])), [{ id: 22, bounds: { Height: 500 }, onScreen: true }]);
  assert.deepEqual(JSON.parse(context.run(["33"])), []);
});
