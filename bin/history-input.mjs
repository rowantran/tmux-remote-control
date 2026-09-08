import { Editor, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const identity = (text) => text;
const theme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

// History is data, not terminal output. Keep control bytes out of the display.
// The original payload remains available unchanged until the user edits it.
function displayText(text) {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, (char) =>
    `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/** Esc opens history only on a truly empty prompt. */
export function isHistoryShortcut(data, text) {
  return text === "" && matchesKey(data, Key.escape);
}

/** A Pi editor with exact-payload recall and history that survives helper restarts. */
export class HistoryInput {
  constructor(tui, entries, value = "", state = {}) {
    this.editor = new Editor(tui, theme);
    // The controller handles Enter itself: Editor's submit path trims text.
    this.editor.disableSubmit = true;
    this.entries = entries;
    this.index = entries.findIndex((entry) => entry.id === state.selectedId);
    this.draft = typeof state.draft === "string" ? state.draft : value;
    this.edits = new Map(Object.entries(state.edits ?? {}).filter(([, text]) => typeof text === "string"));
    this.setValue(value);
  }

  get focused() { return this.editor.focused; }
  set focused(value) { this.editor.focused = value; }

  setValue(value) {
    this.editor.setText(displayText(value));
    this.original = value;
    // Pi normalizes tabs and CRLF for editing. Merely recalling, moving the
    // cursor, or opening the external editor must still use the exact payload.
    this.displayed = this.editor.getExpandedText();
  }

  getValue() {
    const text = this.editor.getExpandedText();
    return text === this.displayed ? this.original : text;
  }

  clear() {
    this.index = -1;
    this.draft = "";
    this.edits.clear();
    this.setValue("");
  }

  getState() {
    if (this.index >= 0) this.edits.set(this.entries[this.index].id, this.getValue());
    return {
      selectedId: this.entries[this.index]?.id ?? null,
      draft: this.index < 0 ? this.getValue() : this.draft,
      edits: Object.fromEntries(this.edits),
    };
  }

  navigate(direction) {
    const next = this.index + direction;
    if (next < -1 || next >= this.entries.length || next === this.index) return;
    if (this.index < 0) this.draft = this.getValue();
    else this.edits.set(this.entries[this.index].id, this.getValue());
    this.index = next;
    const entry = this.entries[next];
    this.setValue(entry ? (this.edits.get(entry.id) ?? entry.text) : this.draft);
  }

  handleInput(data) {
    if (data === "\n" || matchesKey(data, Key.enter)) {
      this.onSubmit?.();
      return;
    }
    const { line } = this.editor.getCursor();
    if (matchesKey(data, Key.up) && line === 0) {
      this.navigate(1);
    } else if (matchesKey(data, Key.down) && line === this.editor.getLines().length - 1 && this.index >= 0) {
      this.navigate(-1);
    } else {
      this.editor.handleInput(data);
    }
  }

  render(width) {
    // Pi's word wrapper needs room for a wide grapheme plus the cursor.
    if (width < 5) return [
      "─".repeat(Math.max(0, width)),
      truncateToWidth(`› ${this.editor.getText().split("\n")[0]}`, Math.max(0, width), ""),
      "─".repeat(Math.max(0, width)),
    ];
    const lines = this.editor.render(width - 2);
    const border = "─".repeat(width);
    return [
      border,
      ...lines.slice(1, -1).map((text, index) => `${index === 0 ? "› " : "  "}${text}`),
      border,
    ];
  }

  invalidate() { this.editor.invalidate(); }
}
