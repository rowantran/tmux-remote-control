import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { CURSOR_MARKER, Editor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// The extension only changes rendering, not CustomEditor's app shortcuts.
// Use the real pi-tui Editor for geometry, editing, paste, and submission tests
// without requiring the optional pi-coding-agent peer or an API key.
const tuiUrl = import.meta.resolve("@earendil-works/pi-tui");
const source = stripTypeScriptTypes(readFileSync(new URL("../pi-extension.ts", import.meta.url), "utf8"), { mode: "transform" })
  .replace(/import .* from "@earendil-works\/pi-coding-agent";/, `import { Editor as CustomEditor } from ${JSON.stringify(tuiUrl)};`)
  .replaceAll('from "@earendil-works/pi-tui"', `from ${JSON.stringify(tuiUrl)}`);
const { default: extension } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const label = "📡 ── text entered ";
const accent = text => `\x1b[36m${text}\x1b[39m`;
const warning = text => `\x1b[33m${text}\x1b[39m`;
const plain = lines => lines.map(stripTerminalSequences);

async function setup(initialText = "") {
  let toggle;
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const identity = text => text;
  const theme = {
    borderColor: text => `\x1b[34m${text}\x1b[0m`,
    selectList: {
      selectedPrefix: identity, selectedText: identity, description: identity,
      scrollInfo: identity, noMatch: identity,
    },
  };
  const originalFactory = () => new Editor(tui, theme);
  const notices = [], clipboard = [];
  const ui = {
    factory: originalFactory,
    editor: originalFactory(),
    theme: { fg: (color, text) => ({ accent, warning })[color](text) },
    getEditorComponent() { return this.factory; },
    setEditorComponent(factory) {
      const text = this.editor.getText();
      this.factory = factory;
      this.editor = factory(tui, theme, {});
      this.editor.setText(text);
      this.editor.focused = true;
    },
    notify: (...args) => notices.push(args),
  };
  ui.editor.setText(initialText);
  const pi = {
    registerShortcut: (_key, spec) => { toggle = spec.handler; },
    registerCommand() {},
    async exec(command, args) {
      assert.equal(command, "tmux-remote-control");
      assert.deepEqual(args, ["--print-controller-command"]);
      return { code: 0, stdout: "tmux-remote-control attach host --session %1", stderr: "" };
    },
  };
  extension(pi);
  const ctx = { mode: "tui", ui };
  const stdoutWrite = process.stdout.write;
  try {
    process.stdout.write = chunk => { clipboard.push(chunk); return true; };
    await toggle(ctx);
  } finally {
    process.stdout.write = stdoutWrite;
  }
  assert.equal(clipboard.length, 1);
  assert.match(notices[0][0], /Copied the local controller command/);
  const baseline = originalFactory();
  baseline.focused = true;
  baseline.borderColor = warning;
  return { ui, editor: ui.editor, baseline, originalFactory, disable: () => toggle(ctx) };
}

function assertCollapsed(editor, width = 80) {
  const lines = editor.render(width);
  assert.deepEqual(plain(lines), ["📡 " + "─".repeat(width - 3)]);
  assert.ok(lines[0].includes(accent("📡 ")));
  assert.ok(!lines[0].includes("\x1b[7m"), "collapsed editor has no fake text cursor");
}

function assertExpanded(editor, baseline, width = 80) {
  baseline.setText(editor.getText());
  const lines = editor.render(width);
  const normal = baseline.render(width);
  assert.equal(lines.length, normal.length);
  assert.ok(stripTerminalSequences(lines[0]).startsWith(label));
  assert.ok(lines[0].includes(warning(label)));
  assert.deepEqual(lines.slice(1), normal.slice(1), "text, cursor, bottom border, and menus stay intact");
  return lines;
}

test("empty editor collapses to one accent-colored line without changing input", async () => {
  const { editor } = await setup();
  const changes = [];
  editor.onChange = text => changes.push(text);
  assertCollapsed(editor);
  const [line] = editor.render(80);
  assert.ok(line.includes(CURSOR_MARKER));
  assert.equal(visibleWidth(line.split(CURSOR_MARKER)[0]), 3);
  assert.equal(editor.getText(), "");
  assert.equal(editor.getExpandedText(), "");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  assert.deepEqual(changes, []);
});

test("any entered text expands with warning borders and the text-entered label", async () => {
  const { editor, baseline } = await setup();
  for (const text of ["hello", " ", "\n", "first\nsecond", "世界 📡", "x".repeat(200)]) {
    editor.setText(text);
    assertExpanded(editor, baseline, 40);
    assert.equal(editor.getText(), text);
    assert.equal(editor.getExpandedText(), text);
  }
  editor.setText("hello");
  assert.deepEqual(plain(editor.render(40)), [
    label + "─".repeat(40 - visibleWidth(label)),
    "hello" + " ".repeat(35),
    "─".repeat(40),
  ]);
});

test("typing, clearing, and submission never include the indicator", async () => {
  const { editor } = await setup();
  const submitted = [];
  editor.onSubmit = text => submitted.push(text);
  editor.handleInput("hello");
  assert.equal(editor.getText(), "hello");
  assert.equal(editor.render(80).length, 3);
  assert.ok(editor.render(80)[0].includes(label));
  editor.handleInput("\r");
  assert.deepEqual(submitted, ["hello"]);
  assert.equal(editor.getText(), "");
  assertCollapsed(editor);
  editor.handleInput("x");
  editor.handleInput("\x7f");
  assert.equal(editor.getText(), "");
  assertCollapsed(editor);
  editor.handleInput("\r");
  assert.ok(submitted.every(text => !text.includes("📡") && !text.includes("text entered")));
});

test("bracketed paste stays visible and submits through the normal editor", async () => {
  const { editor, baseline } = await setup();
  let submitted;
  editor.onSubmit = text => { submitted = text; };
  for (const text of ["first\nsecond", "long pasted line\n".repeat(30).trimEnd()]) {
    editor.handleInput(`\x1b[200~${text}\x1b[201~`);
    assert.equal(editor.getExpandedText(), text);
    assertExpanded(editor, baseline);
    editor.handleInput("\r");
    assert.equal(submitted, text);
    assertCollapsed(editor);
  }
});

test("collapsed border respects narrow widths, padding, and focus", async () => {
  const { editor } = await setup();
  for (const width of [0, 1, 2, 3, 5, 10, 24, 40, 80]) {
    for (const padding of [0, 1, 3, 100]) {
      for (const focused of [false, true]) {
        editor.setPaddingX(padding);
        editor.focused = focused;
        const lines = editor.render(width);
        assert.equal(lines.length, 1);
        assert.equal(visibleWidth(lines[0]), width);
        assert.equal(lines[0].includes(CURSOR_MARKER), focused && width > 0);
        if (focused && width > 0) {
          assert.ok(visibleWidth(lines[0].split(CURSOR_MARKER)[0]) < width);
        }
        if (width >= 3) assertCollapsed(editor, width);
      }
    }
  }
});

test("expanded editor preserves padding, wrapping, cursor, and focus on resize", async () => {
  const { editor, baseline } = await setup();
  for (const width of [3, 5, 10, 24, 40, 80]) {
    for (const padding of [0, 1, 3, 100]) {
      for (const focused of [false, true]) {
        editor.setPaddingX(padding);
        baseline.setPaddingX(padding);
        editor.focused = baseline.focused = focused;
        editor.setText("hello\nworld");
        baseline.setText(editor.getText());
        const lines = editor.render(width);
        const normal = baseline.render(width);
        assert.ok(lines.every(line => visibleWidth(line) === width));
        assert.deepEqual(lines.slice(1), normal.slice(1));
        assert.ok(visibleWidth(lines[0]) <= width);
        assert.equal(lines.join("").includes(CURSOR_MARKER), focused);
        assert.ok(!lines[0].includes(CURSOR_MARKER));
      }
    }
  }
});

test("scroll counts remain visible with warning borders", async () => {
  const { editor, baseline } = await setup();
  const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  editor.setText(text);
  baseline.setText(text);
  let lines = assertExpanded(editor, baseline);
  assert.match(stripTerminalSequences(lines[0]), /text entered .*↑ \d+ more/);
  for (let i = 0; i < 30; i++) {
    editor.handleInput("\x1b[A");
    baseline.handleInput("\x1b[A");
  }
  lines = editor.render(80);
  assert.deepEqual(lines.slice(1), baseline.render(80).slice(1));
  assert.match(stripTerminalSequences(lines.at(-1)), /↓ \d+ more/);
  assert.ok(lines.at(-1).includes("\x1b[33m"));
});

test("autocomplete remains below the collapsed or expanded editor", async () => {
  const { editor, baseline } = await setup();
  const provider = {
    getSuggestions: () => ({
      prefix: "",
      items: [{ value: "alpha", label: "alpha" }, { value: "beta", label: "beta" }],
    }),
    applyCompletion: (_lines, _line, _col, item) => ({ lines: [item.value], cursorLine: 0, cursorCol: item.value.length }),
  };
  for (const text of ["", "/"]) {
    for (const input of [editor, baseline]) {
      input.setAutocompleteProvider(provider);
      input.setText(text);
      input.handleInput("\t");
    }
    await setImmediate();
    assert.ok(editor.isShowingAutocomplete());
    const lines = editor.render(80);
    const normal = baseline.render(80);
    assert.deepEqual(lines.slice(1), normal.slice(text ? 1 : 3));
    assert.ok(lines.some(line => line.includes("alpha")));
    assert.equal(lines.filter(line => line.includes(CURSOR_MARKER)).length, 1);
    editor.handleInput("\x1b");
    baseline.handleInput("\x1b");
  }
});

test("history recall expands and restoring an empty draft collapses", async () => {
  const { editor } = await setup();
  editor.addToHistory("previous prompt");
  editor.handleInput("\x1b[A");
  assert.equal(editor.getText(), "previous prompt");
  assert.equal(editor.render(80).length, 3);
  editor.handleInput("\x1b[B");
  assert.equal(editor.getText(), "");
  assertCollapsed(editor);
});

test("render uses current theme colors and restores Pi's border color", async () => {
  const { ui, editor } = await setup();
  const originalBorder = editor.borderColor;
  editor.render(80);
  assert.equal(editor.borderColor, originalBorder);
  const colors = { accent: "\x1b[96m", warning: "\x1b[93m" };
  ui.theme = { fg: (color, text) => `${colors[color]}${text}\x1b[39m` };
  editor.invalidate();
  assert.ok(editor.render(80)[0].includes(colors.accent));
  editor.setText("x");
  const lines = editor.render(80);
  assert.ok(lines[0].includes(colors.warning));
  assert.ok(lines.at(-1).includes(colors.warning));
  assert.equal(editor.borderColor, originalBorder);
});

test("toggling remote mode preserves existing and newly entered drafts", async () => {
  const { ui, editor, originalFactory, disable } = await setup("existing draft");
  assert.equal(editor.getText(), "existing draft");
  assert.ok(editor.render(80)[0].includes(label));
  editor.handleInput(" plus text");
  await disable();
  assert.equal(ui.factory, originalFactory);
  assert.equal(ui.editor.getText(), "existing draft plus text");
  assert.ok(!ui.editor.render(80).join("").includes(label));
  ui.editor.setText("");
  assert.equal(ui.editor.render(80).length, 3);
  assert.ok(!ui.editor.render(80).join("").includes("📡"));
});
