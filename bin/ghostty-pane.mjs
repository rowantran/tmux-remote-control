#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMPACT_ROWS = 8;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function ghosttyEnabled(env = process.env, platform = process.platform, tty = process.stdin.isTTY && process.stdout.isTTY) {
  return platform === "darwin" && Boolean(tty) && env.TERM_PROGRAM === "ghostty" &&
    env.TMUX_REMOTE_CONTROL_GHOSTTY_RESIZE !== "0" &&
    !env.TMUX && !env.STY && !env.SSH_CONNECTION && !env.SSH_TTY;
}

// JXA uses Ghostty's native AppleScript dictionary, not Accessibility or
// simulated keystrokes. Arguments never become executable script text.
export const GHOSTTY_SCRIPT = `
function run(argv) {
  var app = Application("Ghostty");
  if (!app.running()) return JSON.stringify([]);
  var tabs = [];
  app.windows().forEach(function (w) {
    w.tabs().forEach(function (t) {
      tabs.push({terminals: t.terminals().map(function (p) {
        return {id: p.id(), name: p.name()};
      })});
    });
  });
  if (argv[0] === "snapshot") return JSON.stringify(tabs);
  // Recheck BOTH pane IDs on every action. Never equalize an unrelated tab,
  // a newly added split, or whichever terminal happens to have focus now.
  var pair = tabs.some(function (t) {
    return t.terminals.length === 2 &&
      t.terminals[0].id === argv[2] && t.terminals[1].id === argv[1];
  });
  if (!pair) return "false";
  return JSON.stringify(app.performAction(argv[3], {on: app.terminals.byId(argv[1])}));
}
`;

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
    // Drain errors, but don't display terminal titles or raw automation errors.
    child.stderr.resume();
    child.on("error", finish);
    child.on("close", (code) => finish(code === 0 ? null : new Error(`${command} failed`)));
  });
}

export function systemIO() {
  const script = (...args) => run("osascript", ["-l", "JavaScript", "-e", GHOSTTY_SCRIPT, ...args]);
  return {
    snapshot: async () => JSON.parse(await script("snapshot")),
    action: async (state, action) => JSON.parse(await script("action", state.id, state.siblingId, action)),
    // stty reads the kernel's terminal dimensions, not keyboard input. Avoid
    // terminal size queries that could consume early typing or leak replies
    // into the editor/history picker.
    rows: async () => {
      const [rows] = (await run("stty", ["size"], { terminalInput: true })).split(/\s+/).map(Number);
      if (!Number.isInteger(rows) || rows < 1 || rows > 65535) throw new Error("invalid terminal size");
      return rows;
    },
    title: (title) => process.stdout.write(`\x1b]2;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x07`),
    sleep,
  };
}

async function identify(io) {
  const before = await io.snapshot();
  const oldTitles = new Map(before.flatMap((tab) => tab.terminals.map((pane) => [pane.id, pane.name])));
  const marker = `tmux-remote-control-${randomUUID()}`;
  let originalTitle = "";
  try {
    io.title(marker);
    for (let attempt = 0; attempt < 4; attempt++) {
      await io.sleep(50);
      const tabs = await io.snapshot();
      const matches = tabs.flatMap((tab) => tab.terminals
        .filter((pane) => pane.name === marker).map((pane) => ({ tab, pane })));
      if (matches.length !== 1) continue;
      const { tab, pane } = matches[0];
      originalTitle = oldTitles.get(pane.id) ?? "";
      // Ghostty enumerates leaves top-to-bottom / left-to-right. A row-change
      // check below distinguishes a bottom pane from a right-hand pane.
      if (tab.terminals.length !== 2 || tab.terminals[1].id !== pane.id) return null;
      return { id: pane.id, siblingId: tab.terminals[0].id, pixelsPerRow: 16 };
    }
    return null;
  } finally {
    // Ghostty 1.3 does not implement the xterm title push/pop sequences.
    io.title(originalTitle);
  }
}

async function action(io, state, name) {
  if (await io.action(state, name) !== true) throw new Error("Ghostty pane layout is unavailable");
  await io.sleep(100);
}

async function move(io, state, direction, pixels) {
  const before = await io.rows();
  await action(io, state, `resize_split:${direction},${pixels}`);
  let after = before;
  for (let attempt = 0; attempt < 4; attempt++) {
    after = await io.rows();
    if (after !== before) break;
    await io.sleep(50);
  }
  return { before, after };
}

async function verifyVertical(io, state) {
  // An up action grows the bottom pane. A side-by-side pair has no vertical
  // boundary, so neither action changes its rows and we leave it alone.
  for (const direction of ["up", "down"]) {
    const pixels = 64;
    const { before, after } = await move(io, state, direction, pixels);
    if (before === after) continue;
    const delta = direction === "up" ? after - before : before - after;
    if (delta < 0) return false;
    state.pixelsPerRow = pixels / delta;
    return true;
  }
  return false;
}

async function compact(io, state) {
  // Ghostty resizes in pixels (macOS view coordinates), not rows. Learn the
  // conversion from observed changes, including font size and display scale.
  // Bound retries: Ghostty clamps split ratios, so 8 rows is not always possible.
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await io.rows();
    const delta = COMPACT_ROWS - rows;
    if (Math.abs(delta) <= 1) break;
    const pixels = Math.max(1, Math.min(65535, Math.round(Math.abs(delta) * state.pixelsPerRow)));
    const { before, after } = await move(io, state, delta > 0 ? "up" : "down", pixels);
    if (after === before) {
      // A clamped first movement can underestimate the cell height. Retry
      // with a larger step before deciding the target cannot be reached.
      state.pixelsPerRow *= 2;
      continue;
    }
    if ((after - before) * delta < 0) throw new Error("Ghostty pane layout changed");
    state.pixelsPerRow = pixels / Math.abs(after - before);
  }
}

/** Mutates a private per-controller state object; false means disable sizing. */
export async function resizeGhostty(state, mode, io = systemIO()) {
  if (!["compact", "expanded"].includes(mode)) throw new Error("invalid Ghostty size mode");
  if (!state.id) {
    const identified = await identify(io);
    if (!identified) return false;
    Object.assign(state, identified);
    if (!await verifyVertical(io, state)) return false;
  }
  if (mode === "expanded") await action(io, state, "equalize_splits");
  else await compact(io, state);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [statePath, mode] = process.argv.slice(2);
  if (!ghosttyEnabled()) process.exit(2);
  try {
    let state = {};
    try { state = JSON.parse(readFileSync(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!await resizeGhostty(state, mode)) process.exitCode = 2;
    else writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  } catch {
    process.stderr.write("tmux-remote-control: Ghostty auto-sizing unavailable; continuing without resizing (check macOS Automation permission).\n");
    process.exitCode = 2;
  }
}
