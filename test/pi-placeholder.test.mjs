import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
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
const label = "📡 remote control active";

async function setup(initialText = "") {
  let toggle;
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const theme = { borderColor: text => `\x1b[34m${text}\x1b[0m` };
  const originalFactory = () => new Editor(tui, theme);
  const notices = [], clipboard = [];
  const ui = {
    factory: originalFactory,
    editor: originalFactory(),
    theme: { fg: (_color, text) => `\x1b[90m${text}\x1b[39m` },
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
  return { ui, editor: ui.editor, baseline: originalFactory(), originalFactory, disable: () => toggle(ctx) };
}

test("empty editor keeps its borders and cursor with a display-only placeholder", async () => {
  const { editor, baseline } = await setup();
  baseline.focused = true;
  const changes = [];
  editor.onChange = text => changes.push(text);
  const lines = editor.render(80);
  const normal = baseline.render(80);
  assert.equal(lines.length, normal.length);
  assert.equal(lines[0], normal[0]);
  assert.equal(lines.at(-1), normal.at(-1));
  assert.ok(stripTerminalSequences(lines[1]).includes(label));
  assert.ok(lines[1].includes(CURSOR_MARKER));
  assert.ok(lines[1].includes(`\x1b[0m\x1b[90m${label}`), "placeholder must not inherit the inverted cursor style");
  assert.equal(editor.getText(), "");
  assert.equal(editor.getExpandedText(), "");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  assert.deepEqual(changes, []);
});

test("any entered text, including whitespace and multiple lines, renders normally", async () => {
  const { editor, baseline } = await setup();
  baseline.focused = true;
  for (const text of ["hello", " ", "\n", "first\nsecond", "世界 📡", "x".repeat(200)]) {
    editor.setText(text);
    baseline.setText(text);
    assert.deepEqual(editor.render(40), baseline.render(40));
    assert.equal(editor.getText(), text);
  }
});

test("typing, clearing, and submission never include the placeholder", async () => {
  const { editor } = await setup();
  const submitted = [];
  editor.onSubmit = text => submitted.push(text);
  editor.handleInput("hello");
  assert.equal(editor.getText(), "hello");
  assert.ok(!editor.render(80).join("").includes(label));
  editor.handleInput("\r");
  assert.deepEqual(submitted, ["hello"]);
  assert.equal(editor.getText(), "");
  assert.ok(editor.render(80)[1].includes(label));
  editor.handleInput("x");
  editor.handleInput("\x7f");
  assert.equal(editor.getText(), "");
  assert.ok(editor.render(80)[1].includes(label));
  editor.handleInput("\r");
  assert.ok(submitted.every(text => !text.includes(label)));
});

test("bracketed paste remains visible and submits through the normal editor", async () => {
  const { editor } = await setup();
  let submitted;
  editor.onSubmit = text => { submitted = text; };
  editor.handleInput("\x1b[200~first\nsecond\x1b[201~");
  assert.equal(editor.getText(), "first\nsecond");
  assert.ok(!editor.render(80).join("").includes(label));
  editor.handleInput("\r");
  assert.equal(submitted, "first\nsecond");
  assert.ok(editor.render(80)[1].includes(label));
});

test("placeholder respects narrow widths, padding, and focus", async () => {
  const { editor, baseline } = await setup();
  for (const width of [1, 2, 3, 5, 10, 24, 40, 80]) {
    for (const padding of [0, 1, 3, 100]) {
      for (const focused of [false, true]) {
        editor.setPaddingX(padding);
        baseline.setPaddingX(padding);
        editor.focused = baseline.focused = focused;
        const lines = editor.render(width);
        const normal = baseline.render(width);
        assert.ok(lines.every(line => visibleWidth(line) === width));
        assert.equal(lines[0], normal[0]);
        assert.equal(lines.at(-1), normal.at(-1));
        assert.equal(lines[1].includes(CURSOR_MARKER), focused);
        if (focused) {
          assert.equal(visibleWidth(lines[1].split(CURSOR_MARKER)[0]), visibleWidth(normal[1].split(CURSOR_MARKER)[0]));
        }
      }
    }
  }
});

test("toggling remote mode preserves existing and newly entered drafts", async () => {
  const { ui, editor, originalFactory, disable } = await setup("existing draft");
  assert.equal(editor.getText(), "existing draft");
  assert.ok(!editor.render(80).join("").includes(label));
  editor.handleInput(" plus text");
  await disable();
  assert.equal(ui.factory, originalFactory);
  assert.equal(ui.editor.getText(), "existing draft plus text");
  ui.editor.setText("");
  assert.ok(!ui.editor.render(80).join("").includes(label));
});
