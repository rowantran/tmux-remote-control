#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import {
  Key,
  ProcessTerminal,
  TuiMainScreen,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { HistoryInput, isHistoryShortcut } from "./history-input.mjs";
import { getHistoryDirectory, loadHistory } from "./history-store.mjs";
import { NavigationChannel } from "./navigation-channel.mjs";
import { remoteKey } from "./remote-key.mjs";

const [
  draftPath,
  actionPath,
  controllerHost,
  controllerTarget,
  controllerSession,
  statePath,
  controlPath,
  navigationSessionId,
] = process.argv.slice(2);
if (!draftPath || !actionPath || !controllerHost || !controllerTarget) {
  process.stderr.write(
    "Usage: tmux-remote-control-prompt DRAFT_FILE ACTION_FILE CONTROLLER_HOST CONTROLLER_TARGET " +
      "[SESSION_NAME STATE_FILE CONTROL_PATH SESSION_ID]\n",
  );
  process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("tmux-remote-control: the inline prompt requires a terminal\n");
  process.exit(2);
}

const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal);
let entries = [];
try {
  if (process.env.TMUX_REMOTE_CONTROL_HISTORY !== "0") entries = loadHistory(getHistoryDirectory());
} catch (error) {
  process.stderr.write(`tmux-remote-control: could not read history: ${error.message}\n`);
}
let state = {};
if (statePath) {
  const text = readFileSync(statePath, "utf8");
  if (text) state = JSON.parse(text);
}
const input = new HistoryInput(
  tui,
  entries.filter((entry) => entry.host === controllerHost && entry.session === controllerSession),
  readFileSync(draftPath, "utf8"),
  state,
);
let finished = false;
// The remote check confirms entry; keep pending keys routed to tmux while
// that check is in flight. Saved state survives history/editor prompt restarts.
let scrollback = state.scrollback === true ? "on" : "off";
// The prefix is shown as sent right away; a failed remote check clears it.
let prefix = state.prefix === true;
// Prefix+x asks tmux to confirm before it kills the pane. Until y, n, or Esc
// answers that prompt, those keys go to tmux instead of the draft.
let confirm = state.confirm === true;
const setScrollback = (value) => {
  scrollback = value;
  tui.requestRender();
};
const setPrefix = (value) => {
  prefix = value;
  tui.requestRender();
};
const setConfirm = (value) => {
  confirm = value;
  tui.requestRender();
};

// Keys typed in scrollback go to tmux without the prefix, as tmux key names.
// Only q leaves copy mode.
const scrollbackKeys = new Set([
  "q", "v", "h", "j", "k", "l", "b", "w", "e", "0", "$",
  "Enter", "C-u", "C-d", "PageUp", "PageDown",
]);
// Pane navigation keys go to tmux without the prefix, for root-table bindings
// such as vim-tmux-navigator.
const directKeys = ["h", "j", "k", "l"].map((key) => [Key.ctrl(key), `C-${key}`]);
const matchingKey = (data, keys) => keys.find(([pattern]) => matchesKey(data, pattern))?.[1];

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
      targetColor(controllerTarget) +
      (prefix ? `${muted("  · ")}${targetColor("prefix sent")}` : "") +
      (confirm ? `${muted("  · ")}${targetColor("confirm close: y / n")}` : "") +
      (scrollback === "off" ? "" : `${muted("  · ")}${targetColor(scrollback === "pending" ? "checking scrollback" : "scrollback keys: q, v, hjkl, bwe0$, Enter, Ctrl-U/D, PageUp/Down")}`);
    const content = [truncateToWidth(status, safeWidth), ...this.input.render(safeWidth)];
    const topPadding = Math.max(0, terminal.rows - content.length);
    return [...Array(topPadding).fill(""), ...content];
  }

  invalidate() {
    this.input.invalidate();
  }
}

const bell = () => process.stdout.write("\x07");

// Remote keys go through one persistent SSH channel without leaving this
// prompt. Fixed-pane mode has no session to control through a client. Without
// a control path (for example, when this helper runs alone), bash sends keys.
const navigation =
  navigationSessionId && controlPath
    ? new NavigationChannel({
        host: controllerHost,
        sessionId: navigationSessionId,
        sshOptions: ["-o", "ControlMaster=auto", "-o", "ControlPersist=10m", "-o", `ControlPath=${controlPath}`],
        onSuccess: (action) => {
          if (action === "prefix-key:[" && scrollback === "pending") setScrollback("on");
        },
        onFailure: (action) => {
          if (action.startsWith("prefix-")) setPrefix(false);
          if (action === "prefix-key:x") setConfirm(false);
          if (action === "prefix-key:[" || action.startsWith("copy-")) setScrollback("off");
          bell();
        },
        // The channel could not start, so no queued key reached the remote
        // shell. Let bash run them in order through interactive SSH instead.
        onFallback: (queued) => finish(queued.at(-1), queued.slice(0, -1)),
      })
    : undefined;

async function finish(action, leadingActions = []) {
  if (finished) return;
  finished = true;
  // Stop reading first, so keys typed while navigation drains stay in the
  // terminal buffer for the next prompt instead of being discarded here.
  tui.stop();
  // Apply earlier remote keys before a submission or editor action can use
  // the focused pane. Unsent keys are passed to bash, in order.
  const unsent = navigation ? await navigation.drain() : [];
  navigation?.close();
  writeFileSync(draftPath, input.getValue());
  if (statePath) writeFileSync(statePath, JSON.stringify({ ...input.getState(), scrollback: scrollback !== "off", prefix, confirm }));
  const actions = [...leadingActions, ...unsent, action];
  writeFileSync(actionPath, actions.map((name) => `${name}\n`).join(""));
}

// Send over the persistent channel, or let bash send it after this prompt.
function sendRemote(action) {
  if (navigation) navigation.send(action);
  else finish(action);
}

input.onSubmit = () => finish("submit");

tui.addChild(new ControllerPrompt(input));
tui.setFocus(input);
tui.addInputListener((data) => {
  if (finished) return { consume: true };
  // Kitty key releases match the same shortcuts as presses. The TUI already
  // drops them before the editor; never let them repeat a controller action.
  if (isKeyRelease(data)) return undefined;
  if (prefix) {
    if (matchesKey(data, Key.escape)) {
      setPrefix(false);
      sendRemote("prefix-cancel");
      return { consume: true };
    }
    const key = remoteKey(data);
    if (!key) {
      bell(); // A paste or unknown sequence is not one key. Keep the prefix.
      return { consume: true };
    }
    setPrefix(false);
    if (key === "[") setScrollback("pending");
    if (key === "x") setConfirm(true);
    sendRemote(`prefix-key:${key}`);
    return { consume: true };
  }
  if (confirm) {
    const key = matchingKey(data, [["y", "y"], ["n", "n"], [Key.escape, "Escape"]]);
    if (key) {
      setConfirm(false);
      sendRemote(`send-key:${key}`);
    } else bell(); // Keep the draft unchanged until tmux gets its answer.
    return { consume: true };
  }
  if (scrollback !== "off") {
    const key = remoteKey(data);
    if (scrollbackKeys.has(key)) {
      // q returns control to the draft immediately; the remote command still
      // runs in order and refuses to send q if the pane has left copy mode.
      if (key === "q") setScrollback("off");
      sendRemote(`copy-key:${key}`);
      return { consume: true };
    }
  }
  if (matchesKey(data, Key.ctrl("a"))) {
    if (navigationSessionId) {
      setPrefix(true);
      sendRemote("prefix-start");
    } else bell();
    return { consume: true };
  }
  if (isHistoryShortcut(data, input.getValue())) {
    finish("history");
    return { consume: true };
  }
  // A legacy terminal sends the same newline byte for Enter and Ctrl-J.
  if (data === "\n") return undefined;
  const directKey = matchingKey(data, directKeys);
  if (directKey) {
    if (navigationSessionId) sendRemote(`send-key:${directKey}`);
    else bell();
    return { consume: true };
  }
  if (matchesKey(data, Key.ctrl("c"))) {
    input.clear();
    tui.requestRender();
    return { consume: true };
  }
  if (matchesKey(data, Key.ctrl("d"))) {
    finish("exit");
    return { consume: true };
  }
  if (matchesKey(data, Key.ctrl("g"))) {
    finish("editor");
    return { consume: true };
  }
  return undefined;
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!finished) tui.stop();
    navigation?.close();
    process.exit(128 + (signal === "SIGHUP" ? 1 : signal === "SIGINT" ? 2 : 15));
  });
}

terminal.clearScreen();
tui.start();
// Open the channel now so it is usually ready before the first navigation key.
navigation?.start();
