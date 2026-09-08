import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { HistoryInput, isHistoryShortcut } from "../bin/history-input.mjs";

const entries = [
  { id: "new", timestamp: "2026-06-01T12:32:00.000Z", text: "latest", status: "sent" },
  { id: "old", timestamp: "2026-06-01T12:18:00.000Z", text: "older", status: "unconfirmed" },
];
const tui = { terminal: { rows: 24 }, requestRender() {} };
const up = "\x1b[A";
const down = "\x1b[B";

function input(value = "", history = entries, state) {
  const component = new HistoryInput(tui, history, value, state);
  component.focused = true;
  component.render(80);
  return component;
}

test("Up/Down browse chronologically and restore the original draft", () => {
  const editor = input("unfinished");
  let sent = 0;
  editor.onSubmit = () => sent++;
  for (const expected of ["latest", "older", "older"]) {
    editor.handleInput(up);
    assert.equal(editor.getValue(), expected);
  }
  assert.equal(editor.render(120)[0], "─".repeat(120));
  assert.equal(editor.render(120).at(-1), "─".repeat(120));
  for (const expected of ["latest", "unfinished", "unfinished"]) {
    editor.handleInput(down);
    assert.equal(editor.getValue(), expected);
  }
  assert.equal(sent, 0);
  editor.handleInput("\r");
  assert.equal(sent, 1);
  assert.equal(editor.getValue(), "unfinished");
});

test("recalled edits are drafts, survive navigation, and do not mutate history", () => {
  let editor = input("saved draft");
  editor.handleInput(up);
  editor.handleInput("!");
  const state = JSON.parse(JSON.stringify(editor.getState()));
  editor = input(editor.getValue(), entries, state); // tmux pane/window action restarts helper
  assert.equal(editor.getValue(), "latest!");
  editor.handleInput(up);
  assert.equal(editor.getValue(), "older");
  editor.handleInput(down);
  assert.equal(editor.getValue(), "latest!");
  editor.handleInput(down);
  assert.equal(editor.getValue(), "saved draft");
  assert.equal(entries[0].text, "latest");
});

test("multiline recall and cursor movement preserve the exact payload", () => {
  const text = "  first\tline\r\nsecond line\n\n";
  const editor = input("", [{ ...entries[0], text }]);
  editor.handleInput(up);
  assert.equal(editor.getValue(), text);
  editor.handleInput(up);
  editor.handleInput("\x1b[D");
  assert.equal(editor.getValue(), text);
  assert.ok(editor.render(80).length > 3);
  let sent;
  editor.onSubmit = () => { sent = editor.getValue(); };
  editor.handleInput("\n");
  assert.equal(sent, text);
});

test("multiline editing and bracketed paste never submit implicitly", () => {
  const editor = input();
  let submitted = false;
  editor.onSubmit = () => { submitted = true; };
  editor.handleInput("\x1b[200~one\ntwo\x1b[201~");
  assert.equal(editor.getValue(), "one\ntwo");
  editor.handleInput("\x1b[13;2u"); // Shift-Enter
  editor.handleInput("three");
  assert.equal(editor.getValue(), "one\ntwo\nthree");
  assert.equal(submitted, false);
});

test("empty history, clear, and history boundary behavior", () => {
  const editor = input("keep", []);
  editor.handleInput(up);
  editor.handleInput(down);
  assert.equal(editor.getValue(), "keep");
  const populated = input();
  populated.handleInput(up);
  populated.clear();
  populated.handleInput(down);
  assert.equal(populated.getValue(), "");
  populated.handleInput(up);
  assert.equal(populated.getValue(), "latest");
});

test("history rendering fits narrow terminals and escapes control bytes", () => {
  const editor = input("", [{ ...entries[0], text: "\x1b]52;c;bad\x07\n界🙂" }]);
  editor.handleInput(up);
  for (const width of [0, 1, 2, 3, 10, 40, 80]) {
    const lines = editor.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.every((line) => !line.includes("\x1b]52")));
  }
  assert.equal(editor.getValue(), "\x1b]52;c;bad\x07\n界🙂");
});

test("scroll borders count hidden rows above and below without changing the draft", () => {
  const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const editor = input(text, []);
  const assertBorders = (above, below) => {
    const lines = editor.render(80);
    for (const [border, count, arrow] of [[lines[0], above, "↑"], [lines.at(-1), below, "↓"]]) {
      if (count) assert.ok(border.includes(`${arrow} ${count} more`), border);
      else assert.equal(border, "─".repeat(80));
    }
    assert.equal(lines.length, 9); // Seven visible text rows and two borders.
    assert.ok(lines.every((line) => visibleWidth(line) === 80));
    assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
    assert.equal(editor.getValue(), text);
  };
  assertBorders(5, 0);
  for (let index = 0; index < 7; index++) {
    editor.handleInput(up);
    editor.render(80);
  }
  assertBorders(4, 1);
  for (let index = 0; index < 4; index++) {
    editor.handleInput(up);
    editor.render(80);
  }
  assertBorders(0, 5);
  let submitted;
  editor.onSubmit = () => { submitted = editor.getValue(); };
  editor.handleInput("\r");
  assert.equal(submitted, text, "scroll labels are never submitted");
  editor.clear();
  assert.equal(editor.render(80)[0], "─".repeat(80));
  assert.equal(editor.render(80).at(-1), "─".repeat(80));
});

test("scroll counts include wrapped rows and update after width and height changes", () => {
  const terminal = { rows: 8 };
  const editor = new HistoryInput({ terminal, requestRender() {} }, [], "x".repeat(119));
  editor.focused = true;
  let lines = editor.render(23); // 20 text columns: six wrapped rows, five visible.
  assert.ok(lines[0].includes("↑ 1 more"));
  assert.equal(lines.length, 7);
  assert.equal(editor.editor.getLines().length, 1, "the draft has only one logical line");
  lines = editor.render(43);
  assert.equal(lines[0], "─".repeat(43));
  assert.equal(lines.at(-1), "─".repeat(43));
  assert.equal(lines.length, 5);
  assert.ok(editor.render(23)[0].includes("↑ 1 more"));
  terminal.rows = 40;
  lines = editor.render(23);
  assert.equal(lines[0], "─".repeat(23));
  assert.equal(lines.length, 8);
  terminal.rows = 8;
  assert.ok(editor.render(23)[0].includes("↑ 1 more"));
  assert.equal(editor.getValue(), "x".repeat(119));
});

test("recalled overflow keeps Pi's borders, text, and cursor within narrow widths", () => {
  const text = "界🙂\n".repeat(30);
  const editor = input("", [{ ...entries[0], text }]);
  editor.handleInput(up);
  for (const width of [0, 1, 2, 3, 4, 5, 6, 10, 15, 24, 80]) {
    const lines = editor.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
    if (width >= 5) {
      const normal = editor.editor.render(width - 2);
      assert.equal(lines[0], `──${normal[0]}`);
      assert.equal(lines.at(-1), `──${normal.at(-1)}`);
      assert.deepEqual(lines.slice(1, -1), normal.slice(1, -1).map((line, index) =>
        `${index === 0 ? "› " : "  "}${line}`));
      assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
    }
  }
  assert.equal(editor.getValue(), text);
});

test("single Esc opens history only on an empty prompt in legacy and extended modes", () => {
  for (const escape of ["\x1b", "\x1b[27u"]) {
    assert.equal(isHistoryShortcut(escape, ""), true);
    for (const draft of [" ", "\n", "unfinished"]) {
      assert.equal(isHistoryShortcut(escape, draft), false);
    }
  }
  for (const key of ["x", "\r", "\x1b[A", "\x1ba"]) {
    assert.equal(isHistoryShortcut(key, ""), false);
  }
});

test("prompt borders stay plain when empty, typed, and recalled messages fit", () => {
  const editor = input();
  const assertPlain = () => {
    for (const width of [0, 1, 3, 10, 80, 120]) {
      const lines = editor.render(width);
      assert.equal(lines[0], "─".repeat(width));
      assert.equal(lines.at(-1), "─".repeat(width));
    }
  };
  assertPlain();
  editor.handleInput("new draft");
  assertPlain();
  editor.handleInput(up);
  assertPlain();
  editor.handleInput(up); // Unconfirmed sends do not add annotations either.
  assertPlain();
});
