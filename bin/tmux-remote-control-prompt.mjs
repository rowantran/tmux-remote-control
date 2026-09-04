#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import {
  Input,
  Key,
  ProcessTerminal,
  TuiMainScreen,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

const [draftPath, actionPath, controllerHost, controllerTarget] = process.argv.slice(2);
if (!draftPath || !actionPath || !controllerHost || !controllerTarget) {
  process.stderr.write(
    "Usage: tmux-remote-control-prompt DRAFT_FILE ACTION_FILE CONTROLLER_HOST CONTROLLER_TARGET\n",
  );
  process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("tmux-remote-control: the inline prompt requires a terminal\n");
  process.exit(2);
}

const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal);
const input = new Input();
let finished = false;

const colorsEnabled = !("NO_COLOR" in process.env);
const color = (red, green, blue, text) =>
  colorsEnabled ? `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m` : text;
const muted = (text) => color(146, 131, 116, text); // Gruvbox gray
const hostColor = (text) => color(142, 192, 124, text); // Gruvbox aqua
const targetColor = (text) => color(250, 189, 47, text); // Gruvbox yellow

class ControllerPrompt {
  constructor(inputComponent) {
    this.input = inputComponent;
  }

  render(width) {
    const safeWidth = Math.max(0, width);
    const status =
      `📡  ${muted("Controlling: ")}` +
      hostColor(controllerHost) +
      muted(" → ") +
      targetColor(controllerTarget);
    const border = "─".repeat(safeWidth);
    const inputLine = this.input.render(width)[0] ?? "";
    // Input uses a two-column `> ` prompt. Keep its width and replace only
    // the glyph so editing, horizontal scrolling, and cursor placement stay
    // under the control of pi-tui's Input component.
    const decoratedInput = `› ${inputLine.slice(2)}`;
    const content = [truncateToWidth(status, safeWidth), border, decoratedInput, border];
    const topPadding = Math.max(0, terminal.rows - content.length);
    return [...Array(topPadding).fill(""), ...content];
  }

  invalidate() {
    this.input.invalidate();
  }
}

function finish(action) {
  if (finished) return;
  finished = true;
  writeFileSync(draftPath, input.getValue());
  writeFileSync(actionPath, `${action}\n`);
  tui.stop();
}

const actions = [
  [Key.ctrl("g"), "editor"],
  [Key.ctrl("f"), "pane-zoom"],
  [Key.ctrl("h"), "pane-down"],
  [Key.ctrl("j"), "pane-left"],
  [Key.ctrl("k"), "pane-right"],
  [Key.ctrl("l"), "pane-up"],
  [Key.ctrl("p"), "window-previous"],
  [Key.ctrl("n"), "window-next"],
  ...Array.from({ length: 10 }, (_, index) => [Key.ctrl(String(index)), `window-${index}`]),
];

input.setValue(readFileSync(draftPath, "utf8"));
// Input.setValue preserves its cursor position. Use the component's own
// line-end keybinding to place the cursor after a restored draft.
input.handleInput("\x05");
input.onSubmit = () => finish("submit");

tui.addChild(new ControllerPrompt(input));
tui.setFocus(input);
tui.addInputListener((data) => {
  // A legacy terminal sends the same newline byte for Enter and Ctrl-J. Let
  // Input submit it; pane-left is available when Ctrl-J has a distinct code.
  if (data === "\n") return undefined;
  if (matchesKey(data, Key.ctrl("c"))) {
    input.setValue("");
    tui.requestRender();
    return { consume: true };
  }
  if (matchesKey(data, Key.ctrl("d"))) {
    finish("exit");
    return { consume: true };
  }
  if (matchesKey(data, Key.ctrl("z"))) {
    finish("suspend");
    return { consume: true };
  }
  for (const [key, action] of actions) {
    if (matchesKey(data, key)) {
      finish(action);
      return { consume: true };
    }
  }
  return undefined;
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!finished) tui.stop();
    process.exit(128 + (signal === "SIGHUP" ? 1 : signal === "SIGINT" ? 2 : 15));
  });
}

terminal.clearScreen();
tui.start();
