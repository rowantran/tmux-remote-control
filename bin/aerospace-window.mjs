#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMPACT_ROWS = 8;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function aerospaceEnabled(env = process.env, platform = process.platform, tty = process.stdin.isTTY && process.stdout.isTTY) {
  return platform === "darwin" && Boolean(tty) && env.TERM_PROGRAM === "ghostty" &&
    env.TMUX_REMOTE_CONTROL_AEROSPACE_RESIZE !== "0" &&
    !env.TMUX && !env.STY && !env.SSH_CONNECTION && !env.SSH_TTY;
}

// CoreGraphics reads window bounds in macOS points, not screenshots. AeroSpace's
// stable list-windows API does not expose bounds or tree order.
const READ_BOUNDS = `
function windowBounds(ids) {
  ObjC.import("CoreGraphics");
  ObjC.import("Foundation");
  return ObjC.deepUnwrap(ObjC.castRefToObject(
    $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID)
  )).filter(function (w) {
    return !ids.length || ids.indexOf(w.kCGWindowNumber) >= 0;
  }).map(function (w) {
    return {id: w.kCGWindowNumber, bounds: w.kCGWindowBounds, onScreen: w.kCGWindowIsOnscreen};
  });
}
`;

// Full discovery happens once. Later checks read only the pinned Ghostty window
// and terminal IDs, not every window/tab/title in the app. This remains read-only.
export const SNAPSHOT_SCRIPT = `${READ_BOUNDS}
function run(argv) {
  var app = Application("Ghostty");
  var windows = app.running() ? (argv.length ? [app.windows.byId(argv[0])] : app.windows()) : [];
  var terminals = windows.map(function (w) {
    return {id: w.id(), name: argv.length ? "" : w.name(), tabs: w.tabs().map(function (t) {
      return {terminals: t.terminals().map(function (p) {
        return {id: p.id(), name: argv.length ? "" : p.name()};
      })};
    })};
  });
  return JSON.stringify({bounds: windowBounds([]), terminals: terminals});
}
`;

// Query AppKit separately from Ghostty's scripting dictionary. It runs in
// parallel with the existing snapshot, so it adds no serial automation scan.
export const SCREEN_SCALES_SCRIPT = `
function run() {
  ObjC.import("AppKit");
  var screens = $.NSScreen.screens;
  var scales = [];
  for (var i = 0; i < screens.count; i++) scales.push(Number(screens.objectAtIndex(i).backingScaleFactor));
  return JSON.stringify(scales);
}
`;

// Post-resize measurement needs neither another Ghostty scan nor AeroSpace query.
export const BOUNDS_SCRIPT = `${READ_BOUNDS}
function run(argv) { return JSON.stringify(windowBounds(argv.map(Number))); }
`;

// macOS TIOCGWINSZ returns four native-endian unsigned shorts. Perl is supplied
// by macOS and gives access to ioctl without a compiled addon or terminal query.
// No read/sysread: this cannot consume typing or leave query replies in input.
export const TERMINAL_SIZE_SCRIPT = `
my $size = pack("S4", 0, 0, 0, 0);
ioctl(STDIN, 0x40087468, $size) or die "TIOCGWINSZ failed: $!";
print join(" ", unpack("S4", $size)), "\\n";
`;

export const WINDOW_FORMAT = ["window-id", "window-title", "app-bundle-id", "workspace", "monitor-id",
  "monitor-appkit-nsscreen-screens-id", "window-parent-container-layout", "workspace-root-container-layout", "window-is-fullscreen", "workspace-is-visible"]
  .map((field) => `%{${field}}`).join(" ");

function run(command, args, { terminalInput = false, timeout = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [terminalInput ? "inherit" : "ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output.trim());
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} timed out`));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      output += data;
      if (output.length > 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error(`${command} returned too much output`));
      }
    });
    // Don't display other window titles or raw automation errors.
    child.stderr.resume();
    child.on("error", finish);
    child.on("close", (code) => finish(code === 0 ? null : new Error(`${command} failed`)));
  });
}

export function systemIO(command = run) {
  return {
    snapshot: async (state) => {
      const [windows, native, scales] = await Promise.all([
        command("aerospace", ["list-windows", "--all", "--json", "--format", WINDOW_FORMAT]).then(JSON.parse),
        command("osascript", ["-l", "JavaScript", "-e", SNAPSHOT_SCRIPT, ...(state ? [state.ghosttyWindowId] : [])]).then(JSON.parse),
        command("osascript", ["-l", "JavaScript", "-e", SCREEN_SCALES_SCRIPT]).then(JSON.parse).catch(() => []),
      ]);
      const bounds = new Map(native.bounds.map((w) => [w.id, w]));
      return {
        terminals: native.terminals,
        windows: windows.map((w) => ({
          id: w["window-id"], title: w["window-title"], appId: w["app-bundle-id"],
          workspace: w.workspace, monitor: w["monitor-id"], scale: scales[w["monitor-appkit-nsscreen-screens-id"] - 1],
          layout: w["window-parent-container-layout"],
          rootLayout: w["workspace-root-container-layout"], fullscreen: w["window-is-fullscreen"],
          visible: w["workspace-is-visible"], bounds: bounds.get(w["window-id"])?.bounds,
          onScreen: bounds.get(w["window-id"])?.onScreen,
        })),
      };
    },
    bounds: async (state) => JSON.parse(await command("osascript", ["-l", "JavaScript", "-e", BOUNDS_SCRIPT,
      String(state.id), String(state.siblingId)])),
    // Explicit IDs only: never focus a window or balance an entire workspace.
    resize: async (id, points) => {
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(points) || !points || Math.abs(points) > 65535) {
        throw new Error("invalid AeroSpace resize");
      }
      await command("aerospace", ["resize", "--window-id", String(id), "height", `${points > 0 ? "+" : ""}${points}`]);
    },
    // stty reads kernel dimensions without consuming keyboard input or leaking
    // terminal size-query replies into the editor or history picker.
    rows: async () => {
      const [rows] = (await command("stty", ["size"], { terminalInput: true })).split(/\s+/).map(Number);
      if (!Number.isInteger(rows) || rows < 1 || rows > 65535) throw new Error("invalid terminal size");
      return rows;
    },
    terminalSize: async () => {
      const values = (await command("/usr/bin/perl", ["-e", TERMINAL_SIZE_SCRIPT], { terminalInput: true })).trim().split(/\s+/).map(Number);
      if (values.length !== 4 || values.some((n) => !Number.isInteger(n) || n < 1 || n >= 65535)) {
        throw new Error("invalid terminal pixel dimensions");
      }
      const [rows, columns, pixelWidth, pixelHeight] = values;
      return { rows, columns, pixelWidth, pixelHeight };
    },
    title: (title) => process.stdout.write(`\x1b]2;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x07`),
    sleep,
  };
}

function standalone(window, terminalId) {
  return window?.tabs.length === 1 && window.tabs[0].terminals.length === 1 &&
    window.tabs[0].terminals[0].id === terminalId;
}

function validBounds(bounds) {
  return bounds && [bounds.X, bounds.Y, bounds.Width, bounds.Height].every(Number.isFinite) &&
    bounds.Width > 0 && bounds.Height > 0;
}

// AeroSpace exposes each leaf's parent layout, but not parent IDs or the tree.
// Recognize only unambiguous full-height columns: two aligned v_tiles leaves,
// with other tiled windows beside the column or full-height accordion windows
// behind it. Merely choosing the nearest window above could pick a non-sibling,
// or miss a third child container whose windows would also be resized.
export function verticalPair(snapshot, id) {
  const window = snapshot.windows.find((w) => w.id === id);
  if (!window || window.appId !== "com.mitchellh.ghostty" || window.layout !== "v_tiles") return null;
  const layouts = ["h_tiles", "v_tiles", "h_accordion", "v_accordion"];
  const workspace = snapshot.windows.filter((w) => w.workspace === window.workspace);
  if (new Set(workspace.map((w) => w.id)).size !== workspace.length) return null;
  // Floating windows do not participate in AeroSpace's tiled resize operation.
  const tiled = workspace.filter((w) => w.layout !== "floating");
  if (tiled.some((w) => !Number.isSafeInteger(w.id) || w.id <= 0 || !layouts.includes(w.layout) ||
    !layouts.includes(w.rootLayout) || w.rootLayout !== window.rootLayout || w.fullscreen !== false ||
    w.visible !== true || w.onScreen !== true || w.monitor !== window.monitor || !validBounds(w.bounds))) return null;
  const column = tiled.filter((w) => w.layout === "v_tiles" &&
    Math.abs(w.bounds.X - window.bounds.X) <= 2 && Math.abs(w.bounds.Width - window.bounds.Width) <= 2);
  if (column.length !== 2) return null;
  const sibling = column.find((w) => w.id !== id);
  if (!sibling || !stacked(window, sibling)) return null;

  const top = sibling.bounds.Y;
  const bottom = window.bounds.Y + window.bounds.Height;
  const left = window.bounds.X;
  const right = left + window.bounds.Width;
  for (const other of tiled) {
    if (other.id === id || other.id === sibling.id) continue;
    const frame = other.bounds;
    // Require the pair to fill the workspace's vertical extent. Otherwise a
    // further child (possibly a nested horizontal/accordion group) above or
    // below this pair could share the same vertical parent and receive a resize.
    if (frame.Y < top - 2 || frame.Y + frame.Height > bottom + 2) return null;
    const overlap = Math.min(right, frame.X + frame.Width) - Math.max(left, frame.X);
    if (overlap <= 2) continue; // A separate column.
    // Accordion siblings can overlap the entire column. Partial-height or
    // tiled overlaps are ambiguous; never infer a safe pair through them.
    if (!["h_accordion", "v_accordion"].includes(other.layout) ||
        Math.abs(frame.Y - top) > 2 || Math.abs(frame.Y + frame.Height - bottom) > 2) return null;
  }
  return { window, sibling };
}

function stacked(window, sibling) {
  const top = sibling.bounds;
  const bottom = window.bounds;
  // Enumeration order is not spatial order. Check actual geometry before any
  // mutation, including top/bottom, aligned edges, and non-overlapping frames.
  return window.onScreen === true && sibling.onScreen === true && validBounds(top) && validBounds(bottom) &&
    Math.abs(top.X - bottom.X) <= 2 && Math.abs(top.Width - bottom.Width) <= 2 &&
    top.Y < bottom.Y && top.Y + top.Height <= bottom.Y + 2;
}

function currentPair(snapshot, state) {
  const native = snapshot.terminals.find((w) => w.id === state.ghosttyWindowId);
  const pair = verticalPair(snapshot, state.id);
  if (!standalone(native, state.terminalId) || !pair || pair.sibling.id !== state.siblingId ||
      pair.window.workspace !== state.workspace) throw new Error("AeroSpace window layout is unavailable");
  return pair;
}

async function identify(io) {
  const before = await io.snapshot();
  const oldTitles = new Map(before.terminals.flatMap((w) => w.tabs.flatMap((t) => t.terminals.map((p) => [p.id, p.name]))));
  const marker = `tmux-remote-control-${randomUUID()}`;
  let originalTitle = "";
  try {
    io.title(marker);
    for (let attempt = 0; attempt < 4; attempt++) {
      await io.sleep(50);
      const snapshot = await io.snapshot();
      const terminals = snapshot.terminals.flatMap((window) => window.tabs.flatMap((t) => t.terminals
        .filter((p) => p.name === marker).map((terminal) => ({ window, terminal }))));
      if (terminals.length !== 1) continue;
      const { window: native, terminal } = terminals[0];
      originalTitle = oldTitles.get(terminal.id) ?? "";
      if (!standalone(native, terminal.id)) return null;
      const matches = snapshot.windows.filter((w) => w.title === marker && w.appId === "com.mitchellh.ghostty");
      if (native.name !== marker || matches.length !== 1) continue;
      const pair = verticalPair(snapshot, matches[0].id);
      if (!pair) return null;
      return { id: pair.window.id, siblingId: pair.sibling.id, workspace: pair.window.workspace,
        ghosttyWindowId: native.id, terminalId: terminal.id, pointsPerRow: 16 };
    }
    return null;
  } finally {
    // Ghostty 1.3 does not implement xterm title push/pop sequences.
    io.title(originalTitle);
  }
}

async function inspect(io, state) {
  // Exactly one fresh identity/layout check before each resize command.
  const pair = currentPair(await io.snapshot(state), state);
  return { ...pair, rows: await io.rows() };
}

function context({ window, sibling }) {
  return JSON.stringify([window.monitor, window.scale, window.bounds.X, window.bounds.Width, sibling.bounds.Y,
    window.bounds.Height + sibling.bounds.Height, window.bounds.Y - sibling.bounds.Y - sibling.bounds.Height]);
}

const nearCompact = (rows) => Math.abs(rows - COMPACT_ROWS) <= 1;
const anchor = (position) => ({ height: position.window.bounds.Height, rows: position.rows });

function forgetCompact(state) {
  delete state.compact;
  state.pointsPerRow = 16;
  state.calibrated = false;
}

function rememberCompact(state, position) {
  if (nearCompact(position.rows)) {
    state.compact = { ...anchor(position), context: context(position), anchor: anchor(position) };
  }
}

function validCompact(cache, position) {
  return cache && Number.isFinite(cache.height) && cache.height > 0 && nearCompact(cache.rows) &&
    cache.context === context(position) && cache.anchor?.height === position.window.bounds.Height &&
    cache.anchor.rows === position.rows;
}

// Ghostty supplies the unpadded viewport size through TIOCGWINSZ. For R rows,
// pixelHeight = R * cellHeight + remainder, where 0 <= remainder < cellHeight.
// Scaling that viewport to 8/R gives eight rows without needing to infer the
// font metrics. Subtract only viewport height; keep title bars and padding.
// Source: Ghostty v1.3.1 src/termio/Termio.zig resize() and renderer/size.zig.
export function initialCompactDelta(position, size) {
  if (!size || !Number.isFinite(position.window.scale) || position.window.scale < 1 || position.window.scale > 4 ||
      ![size.rows, size.columns, size.pixelWidth, size.pixelHeight].every((n) => Number.isInteger(n) && n > 0 && n < 65535) ||
      size.rows !== position.rows || size.rows <= COMPACT_ROWS || size.pixelWidth < size.columns || size.pixelHeight < size.rows) return null;
  const viewportHeight = size.pixelHeight / position.window.scale;
  const viewportWidth = size.pixelWidth / position.window.scale;
  if (viewportHeight > position.window.bounds.Height || viewportWidth > position.window.bounds.Width ||
      viewportHeight / size.rows < 1) return null;
  // Round the shrink down so point rounding cannot remove an extra row.
  return -Math.floor(viewportHeight * (size.rows - COMPACT_ROWS) / size.rows);
}

async function move(io, state, before, points, verifiedTarget = false) {
  // An observed compact height or a target computed from kernel pixel dimensions
  // can bypass the half-height limit. Unknown sizes still use bounded calibration.
  const donor = points < 0 ? before.window : before.sibling;
  const limit = verifiedTarget ? 65535 : Math.floor(donor.bounds.Height / 2);
  points = Math.sign(points) * Math.min(Math.abs(points), limit, 65535);
  const height = before.window.bounds.Height + points;
  const siblingHeight = before.sibling.bounds.Height - points;
  if (!Number.isFinite(height) || height <= 0 || siblingHeight <= 0) throw new Error("invalid AeroSpace target height");
  if (!points) return before;
  await io.resize(state.id, points);

  // Measure only the two frames after resizing. No second native-window scan,
  // duplicate layout query, or unconditional 100ms sleep on the normal path.
  let after;
  let previousFrame;
  for (let attempt = 0; attempt < 5; attempt++) {
    const bounds = new Map((await io.bounds(state)).map((w) => [w.id, w]));
    after = { window: { ...before.window, bounds: bounds.get(state.id)?.bounds, onScreen: bounds.get(state.id)?.onScreen },
      sibling: { ...before.sibling, bounds: bounds.get(state.siblingId)?.bounds, onScreen: bounds.get(state.siblingId)?.onScreen } };
    if (!validBounds(after.window.bounds) || !validBounds(after.sibling.bounds)) throw new Error("AeroSpace window layout is unavailable");
    const frame = JSON.stringify([after.window.bounds, after.sibling.bounds]);
    const complete = Math.abs(after.window.bounds.Height - height) <= 1 && context(after) === context(before);
    // The two frames can arrive separately. Do not cache an intermediate frame;
    // accept either the complete target or a stable native minimum-size clamp.
    const moved = after.window.bounds.Height !== before.window.bounds.Height;
    if (stacked(after.window, after.sibling) && (complete || (frame === previousFrame && (moved || attempt === 4)))) break;
    if (attempt === 4) throw new Error("AeroSpace window resize did not settle");
    previousFrame = frame;
    await io.sleep(20);
  }
  after.rows = await io.rows();
  const heightDelta = after.window.bounds.Height - before.window.bounds.Height;
  // A terminal may deliver its new row count just after its frame changes. A
  // cached jump must reach compact rows before we accept it, not an intermediate
  // count. Never issue corrective shrinks using rows that failed to synchronize.
  const targetArrived = verifiedTarget && Math.abs(after.window.bounds.Height - height) <= 1 && context(after) === context(before);
  const mustChangeRows = Math.abs(heightDelta) >= before.window.bounds.Height / before.rows;
  const waitingForRows = () => targetArrived ? !nearCompact(after.rows) : mustChangeRows && after.rows === before.rows;
  for (let attempt = 0; attempt < 4 && waitingForRows(); attempt++) {
    await io.sleep(20);
    after.rows = await io.rows();
  }
  if (waitingForRows()) throw new Error("terminal row count did not settle");
  const rowDelta = after.rows - before.rows;
  if (heightDelta * points < 0 || rowDelta * points < 0) throw new Error("AeroSpace window layout changed");
  if (heightDelta && rowDelta) {
    // Integer row counts give only a lower bound on the true cell height.
    state.pointsPerRow = Math.abs(heightDelta) / (Math.abs(rowDelta) + 1);
    state.calibrated = true;
  }
  return after;
}

/** Mutates a private per-controller state object; false means disable sizing. */
export async function resizeAerospace(state, mode, io = systemIO()) {
  if (!["compact", "expanded"].includes(mode)) throw new Error("invalid AeroSpace size mode");
  if (!state.id) {
    const identified = await identify(io);
    if (!identified) return false;
    Object.assign(state, identified);
  }
  // Editor-first or legacy state can contain a conversion without an observed
  // compact frame. It has no font/display anchor, so recalibrate on this call.
  if (!state.compact) forgetCompact(state);
  let position = await inspect(io, state);
  // A different frame/row count or display geometry means the font, window, or
  // monitor may have changed. Never reuse a stale compact height in that case.
  if (state.compact && !validCompact(state.compact, position)) forgetCompact(state);
  rememberCompact(state, position);

  if (mode === "expanded") {
    const points = Math.round((position.sibling.bounds.Height - position.window.bounds.Height) / 2);
    position = await move(io, state, position, points);
    if (state.compact) {
      if (state.compact.context === context(position)) state.compact.anchor = anchor(position);
      else forgetCompact(state);
    }
    return true;
  }

  if (state.compact && !nearCompact(position.rows)) {
    const points = Math.round(state.compact.height - position.window.bounds.Height);
    position = await move(io, state, position, points, true);
    if (nearCompact(position.rows)) {
      rememberCompact(state, position);
      return true;
    }
    // Native limits or an in-flight font change can invalidate a cached target.
    // Recalibrate rather than saving a requested (but unobserved) frame height.
    forgetCompact(state);
    position = await inspect(io, state);
  }

  if (position.rows > COMPACT_ROWS + 1 && io.terminalSize) {
    let size;
    try { size = await io.terminalSize(); } catch { /* Older systems can use bounded calibration. */ }
    const points = initialCompactDelta(position, size);
    if (points !== null) {
      position = await move(io, state, position, points, true);
      // Native minimum sizes may clamp the requested height. Do not ratchet
      // further: the direct request already targeted eight rows safely.
      rememberCompact(state, position);
      return true;
    }
    // The size query may have raced a manual resize. Validate again before the
    // fallback rather than calibrating from a stale frame or row count.
    position = await inspect(io, state);
  }

  for (let attempt = 0; attempt < 5 && !nearCompact(position.rows); attempt++) {
    const delta = COMPACT_ROWS - position.rows;
    const limit = state.calibrated ? 65535 : 64;
    const points = Math.sign(delta) * Math.max(1, Math.min(limit, Math.round(Math.abs(delta) * state.pointsPerRow)));
    const after = await move(io, state, position, points);
    const moved = after.window.bounds.Height !== position.window.bounds.Height;
    position = after;
    if (!moved || nearCompact(position.rows) || attempt === 4) break;
    position = await inspect(io, state);
  }
  rememberCompact(state, position);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [statePath, mode] = process.argv.slice(2);
  if (!aerospaceEnabled()) process.exit(2);
  try {
    let state = {};
    try { state = JSON.parse(readFileSync(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!await resizeAerospace(state, mode)) process.exitCode = 2;
    else writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  } catch {
    process.stderr.write("tmux-remote-control: AeroSpace auto-sizing unavailable; continuing without resizing (check AeroSpace and Ghostty Automation access).\n");
    process.exitCode = 2;
  }
}
