import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HistoryPicker, entryLabel, pickHistory, safeDisplay, scopedEntries } from "../bin/history-picker.mjs";

const entries = [
  { id: "a", timestamp: "2026-06-01T12:00:00.000Z", text: "review authentication\n" + "more details\n".repeat(30), host: "devbox", session: "work", status: "sent" },
  { id: "b", timestamp: "2026-06-01T11:00:00.000Z", text: "fix authentication tests", host: "other", session: "other", status: "unconfirmed" },
  { id: "c", timestamp: "2026-06-01T10:00:00.000Z", text: "run lint", host: "devbox", session: "work", status: "sent" },
];

test("picker filters fuzzily and toggles scope without losing the search", () => {
  let selected;
  const picker = new HistoryPicker(entries, { host: "devbox", session: "work", terminal: { rows: 24 }, done: (entry) => { selected = entry; } });
  picker.focused = true;
  picker.handleInput("fix ath");
  assert.equal(picker.matches.length, 0);
  picker.handleInput("\t");
  assert.equal(picker.input.getValue(), "fix ath");
  assert.deepEqual(picker.matches.map((entry) => entry.id), ["b"]);
  assert.equal(selected, undefined);
  picker.handleInput("\r");
  assert.equal(selected, entries[1]);
  picker.handleInput("\x1b");
  assert.equal(selected, null);
  assert.equal(scopedEntries(entries, "devbox", "work").length, 2);
});

test("picker has a scrollable multiline preview and fits resized terminals", () => {
  const terminal = { rows: 24 };
  const picker = new HistoryPicker(entries, { host: "devbox", session: "work", terminal, done() {} });
  picker.render(80);
  picker.handleInput("\x1b[1;2B");
  assert.equal(picker.previewOffset, 1);
  for (const rows of [3, 10, 24, 40]) {
    terminal.rows = rows;
    for (const width of [0, 1, 2, 3, 10, 80]) {
      const lines = picker.render(width);
      assert.ok(lines.length <= rows);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `${rows} rows, ${width} columns`);
    }
  }
});

test("display escapes terminal controls without changing stored text", () => {
  const raw = "\x1b]52;clipboard\x07\ntext\tend";
  assert.equal(safeDisplay(raw), "\\x1b]52;clipboard\\x07\ntext    end");
  assert.doesNotMatch(entryLabel({ ...entries[0], text: raw }), /[\x00-\x1f]/);
  assert.match(entryLabel(entries[1]), /send unconfirmed/);
});

function fakeFzf(t, source) {
  const root = mkdtempSync(join(tmpdir(), "tmux-fzf-test-"));
  const old = { ...process.env };
  process.env.PATH = `${root}:${process.env.PATH}`;
  process.env.FZF_TEST_ROOT = root;
  process.env.FZF_DEFAULT_OPTS = "--select-1 --multi --bind=enter:abort";
  process.env.FZF_DEFAULT_OPTS_FILE = "/untrusted-options";
  writeFileSync(join(root, "fzf"), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  t.after(() => {
    for (const key of ["PATH", "FZF_TEST_ROOT", "FZF_DEFAULT_OPTS", "FZF_DEFAULT_OPTS_FILE"]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("fzf selects by index, isolates defaults, and keeps private previews", async (t) => {
  const root = fakeFzf(t, `
    const fs = require('node:fs');
    const path = require('node:path');
    const input = fs.readFileSync(0, 'utf8').split('\\0').filter(Boolean);
    if (process.env.FZF_DEFAULT_OPTS || process.env.FZF_DEFAULT_OPTS_FILE) process.exit(4);
    fs.writeFileSync(path.join(process.env.FZF_TEST_ROOT, 'args.json'), JSON.stringify(process.argv.slice(2)));
    process.stdout.write('query\\0\\0' + input[1] + '\\0');
  `);
  const selected = await pickHistory(entries, { host: "devbox", session: "work", backend: "fzf" });
  assert.equal(selected, entries[2]);
  const args = JSON.parse(readFileSync(join(root, "args.json")));
  assert.ok(args.includes("--no-multi"));
  assert.ok(args.find((arg) => arg.startsWith("--preview=")).endsWith(" {1}"));
  assert.ok(!args.some((arg) => arg.includes(entries[0].text)));
});

test("fzf scope switching retains query and cannot send or restore out-of-scope output", async (t) => {
  fakeFzf(t, `
    const fs = require('node:fs');
    const path = require('node:path');
    const input = fs.readFileSync(0, 'utf8').split('\\0').filter(Boolean);
    const state = path.join(process.env.FZF_TEST_ROOT, 'state');
    if (!fs.existsSync(state)) {
      if (input.length !== 2) process.exit(4);
      fs.writeFileSync(state, '1');
      process.stdout.write('authentication\\0tab\\0');
    } else {
      if (input.length !== 3 || !process.argv.includes('--query=authentication')) process.exit(5);
      process.stdout.write('authentication\\0\\0' + input[1] + '\\0');
    }
  `);
  assert.equal(await pickHistory(entries, { host: "devbox", session: "work", backend: "fzf" }), entries[1]);
});

test("fzf cancellation returns no message", async (t) => {
  fakeFzf(t, "process.exit(130);");
  assert.equal(await pickHistory(entries, { host: "devbox", session: "work", backend: "fzf" }), null);
});

test("preview subprocess treats messages as data, never shell or terminal commands", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tmux-preview-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = join(root, "entries.json");
  writeFileSync(snapshot, JSON.stringify([{ text: "$(touch unsafe)\n\x1b]52;c;evil\x07" }]));
  const output = execFileSync(process.execPath, [new URL("../bin/history-picker.mjs", import.meta.url).pathname, "--preview", snapshot, "0"], { encoding: "utf8" });
  assert.equal(output, "$(touch unsafe)\n\\x1b]52;c;evil\\x07");
});
