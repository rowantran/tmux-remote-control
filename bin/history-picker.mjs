import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Input, Key, ProcessTerminal, SelectList, TuiMainScreen,
  fuzzyFilter, matchesKey, truncateToWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const modulePath = fileURLToPath(import.meta.url);
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

export function safeDisplay(text) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (char) =>
    char === "\r" ? "" : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  ).replace(/\t/g, "    ");
}

function historyTime(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

export function entryLabel(entry) {
  const status = entry.status === "sent" ? "" : " [send unconfirmed]";
  return safeDisplay(`${historyTime(entry.timestamp)}  ${entry.host} → ${entry.session}${status}  ${entry.text}`)
    .replace(/\n/g, " ↵ ");
}

export function scopedEntries(entries, host, session, all = false) {
  return all ? entries : entries.filter((entry) => entry.host === host && entry.session === session);
}

/** A selector, not an action menu: the only result is text to restore. */
export class HistoryPicker {
  constructor(entries, { host, session, terminal, done }) {
    this.entries = entries;
    this.host = host;
    this.session = session;
    this.terminal = terminal;
    this.done = done;
    this.input = new Input();
    this.all = false;
    this.previewOffset = 0;
    this.refresh();
  }

  get focused() { return this.input.focused; }
  set focused(value) { this.input.focused = value; }

  refresh(selected = 0) {
    this.matches = fuzzyFilter(scopedEntries(this.entries, this.host, this.session, this.all), this.input.getValue(), entryLabel);
    this.listRows = Math.max(1, Math.floor(this.terminal.rows / 3));
    const identity = (text) => text;
    this.list = new SelectList(this.matches.map((entry) => ({ value: entry.id, label: entryLabel(entry) })), this.listRows, {
      selectedPrefix: identity,
      selectedText: (text) => "NO_COLOR" in process.env ? text : `\x1b[7m${text}\x1b[27m`,
      description: identity, scrollInfo: identity, noMatch: () => "  No matching history",
    });
    this.list.setSelectedIndex(selected);
    this.list.onSelect = ({ value }) => this.done(this.matches.find((entry) => entry.id === value));
    this.list.onSelectionChange = () => { this.previewOffset = 0; };
  }

  handleInput(data) {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
      this.done(null);
    } else if (matchesKey(data, Key.tab)) {
      this.all = !this.all;
      this.previewOffset = 0;
      this.refresh();
    } else if (matchesKey(data, Key.shift("up")) || matchesKey(data, Key.shift("down"))) {
      this.previewOffset = Math.max(0, this.previewOffset + (matchesKey(data, Key.shift("up")) ? -1 : 1));
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      const index = this.matches.findIndex((entry) => entry.id === this.list.getSelectedItem()?.value);
      this.list.setSelectedIndex(index + (matchesKey(data, Key.pageUp) ? -this.listRows : this.listRows));
      this.previewOffset = 0;
    } else if (data === "\n" || [Key.up, Key.down, Key.enter].some((key) => matchesKey(data, key))) {
      this.list.handleInput(data === "\n" ? "\r" : data);
    } else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (previous !== this.input.getValue()) {
        this.previewOffset = 0;
        this.refresh();
      }
    }
  }

  render(width) {
    if (width < 3) return [""];
    const rows = Math.max(1, this.terminal.rows);
    if (this.listRows !== Math.max(1, Math.floor(rows / 3))) {
      this.refresh(this.matches.findIndex((entry) => entry.id === this.list.getSelectedItem()?.value));
    }
    const scope = this.all ? "all local history" : `${this.host} → ${this.session}`;
    const lines = [
      `Message history · ${safeDisplay(scope)}`,
      "Enter restores a draft; it does not send.",
      ...this.input.render(width),
      "─".repeat(width),
      ...this.list.render(width),
      "── Preview · Shift-↑↓ scroll " + "─".repeat(width),
    ];
    const entry = this.matches.find((item) => item.id === this.list.getSelectedItem()?.value);
    const preview = wrapTextWithAnsi(safeDisplay(entry?.text ?? ""), width);
    const room = Math.max(0, rows - lines.length - 1);
    this.previewOffset = Math.min(this.previewOffset, Math.max(0, preview.length - room));
    lines.push(...preview.slice(this.previewOffset, this.previewOffset + room));
    while (lines.length < rows - 1) lines.push("");
    lines.push("↑↓ select · Enter restore · Esc cancel · Tab scope · PgUp/PgDn page");
    return lines.slice(0, rows).map((line) => truncateToWidth(line, width, ""));
  }

  invalidate() { this.input.invalidate(); this.list.invalidate(); }
}

async function builtinPick(entries, options) {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  let done;
  const result = new Promise((resolve) => { done = resolve; });
  const picker = new HistoryPicker(entries, { ...options, terminal, done });
  const cancel = () => done(null);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, cancel);
  try {
    tui.addChild(picker);
    tui.setFocus(picker);
    terminal.clearScreen();
    tui.start();
    return await result;
  } finally {
    tui.stop();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, cancel);
  }
}

function runFzf(args, candidates) {
  return new Promise((resolve, reject) => {
    // User fzf configuration must not add multi-select, automatic acceptance,
    // commands, or output fields to this restore-only picker.
    const env = { ...process.env, FZF_DEFAULT_OPTS: "", FZF_DEFAULT_OPTS_FILE: "", SHELL: "/bin/sh" };
    const child = spawn("fzf", args, { env, stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    const cancel = () => child.kill("SIGTERM");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, cancel);
    const cleanup = () => {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, cancel);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => { output += data; });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code, signal) => { cleanup(); resolve({ code, signal, output }); });
    child.stdin.end(candidates);
  });
}

async function fzfPick(entries, { host, session }) {
  const directory = mkdtempSync(join(tmpdir(), "tmux-rc-history-"));
  chmodSync(directory, 0o700);
  const snapshot = join(directory, "entries.json");
  try {
    writeFileSync(snapshot, JSON.stringify(entries), { mode: 0o600 });
    let all = false;
    let query = "";
    for (;;) {
      const choices = new Set(scopedEntries(entries, host, session, all));
      const candidates = entries.map((entry, index) => choices.has(entry) ? `${index}\t${entryLabel(entry)}\0` : "").join("");
      const scope = all ? "all local history" : `${host} → ${session}`;
      const { code, signal, output } = await runFzf([
        "--read0", "--print0", "--print-query", "--expect=tab", "--no-multi", "--layout=reverse", "--border",
        "--delimiter=\t", "--with-nth=2..", "--tiebreak=index", "--prompt=Search> ", `--query=${query}`,
        `--header=Message history · ${safeDisplay(scope)}\nEnter restore (does not send) · Esc cancel · Tab scope · Shift-↑↓ preview`,
        `--preview=${quote(process.execPath)} ${quote(modulePath)} --preview ${quote(snapshot)} {1}`,
        "--preview-window=down:50%:wrap",
        "--bind=enter:accept,esc:abort,ctrl-c:abort,shift-up:preview-up,shift-down:preview-down",
      ], candidates);
      if (signal || code === 130) return null;
      if (code !== 0 && code !== 1) throw new Error(`fzf exited with code ${code}`);
      const [nextQuery, key, selected] = output.split("\0");
      if (key === "tab") {
        query = nextQuery;
        all = !all;
        continue;
      }
      if (code !== 0 || !selected) return null;
      const index = selected.split("\t", 1)[0];
      const entry = /^\d+$/.test(index) ? entries[Number(index)] : undefined;
      return choices.has(entry) ? entry : null;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function pickHistory(entries, { host, session, backend = process.env.TMUX_REMOTE_CONTROL_HISTORY_PICKER || "auto" }) {
  if (!["auto", "fzf", "builtin"].includes(backend)) throw new Error("history picker must be auto, fzf, or builtin");
  if (backend !== "builtin") {
    try { return await fzfPick(entries, { host, session }); }
    catch (error) {
      if (backend === "fzf") throw error;
      process.stderr.write(`tmux-remote-control: fzf unavailable (${error.message}); using built-in history\n`);
    }
  }
  return builtinPick(entries, { host, session });
}

// Only the snapshot path and a generated numeric index reach the preview shell.
if (process.argv[1] === modulePath && process.argv[2] === "--preview") {
  const index = process.argv[4];
  if (/^\d+$/.test(index ?? "")) {
    const entry = JSON.parse(readFileSync(process.argv[3], "utf8"))[Number(index)];
    if (entry) process.stdout.write(safeDisplay(entry.text));
  }
}
