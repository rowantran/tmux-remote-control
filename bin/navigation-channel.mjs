import { spawn } from "node:child_process";

export const READY_MARKER = "tmux-remote-control-ready";
export const STATUS_MARKER = "tmux-remote-control-status";
// The login shell parses this once. Every later command goes to POSIX sh.
export const CHANNEL_COMMAND = `sh -c 'echo ${READY_MARKER} && exec sh'`;

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/** Split a `KIND:KEY` action. The key itself may contain a colon. */
function splitAction(action) {
  const separator = action.indexOf(":");
  return separator < 0 ? [action, ""] : [action.slice(0, separator), action.slice(separator + 1)];
}

/** Map a controller key action to a remote tmux command for one session. */
export function navigationCommand(sessionId, action) {
  const session = shellQuote(sessionId);
  // -K sends through an attached client's key table (including copy mode),
  // rather than typing into the pane. Resolve the client at keypress time.
  const client = `client=$(tmux list-clients -t ${session} -F '#{client_tty}' | head -n 1) && test -n "$client"`;
  const keys = (key) => `${client} && tmux send-keys -K -c "$client" ${shellQuote(key)}`;
  const inCopyMode = `test "$(tmux display-message -p -t ${session} '#{pane_mode}')" = copy-mode`;
  // Append a dynamic, session-scoped status marker once. It vanishes when
  // copy mode ends, even if the attached keyboard exits it independently.
  const statusSuffix = "#{?#{==:#{pane_mode},copy-mode}, [scrollback],}";
  const status = `current=$(tmux show-options -v -t ${session} status-right) && case "$current" in *${shellQuote(statusSuffix)}*) : ;; *) tmux set-option -t ${session} status-right "$current${statusSuffix}" ;; esac`;
  const inPrefix = `test "$(tmux display-message -p -c "$client" '#{client_key_table}')" = prefix`;
  switch (action) {
    case "prefix-start": return `${keys("C-a")} && ${inPrefix}`;
    case "prefix-cancel": return `${client} && tmux switch-client -c "$client" -T root`;
    default: {
      const [kind, key] = splitAction(action);
      if (!key) return undefined;
      switch (kind) {
        case "prefix-key": {
          const command = `${client} && ${inPrefix} && tmux send-keys -K -c "$client" ${shellQuote(key)}`;
          return key === "[" ? `${command} && ${inCopyMode} && (${status} || :)` : command;
        }
        // Never leak a scrollback key to the application after copy mode ends.
        case "copy-key": return `${inCopyMode} && ${keys(key)}`;
        // Unprefixed keys, such as Ctrl-H/J/K/L or an answer to a tmux
        // confirmation prompt, go through the client's current key handling.
        case "send-key": return keys(key);
        default: return undefined;
      }
    }
  }
}

/**
 * One long-lived SSH channel running a remote POSIX shell. Each navigation key
 * writes one line to it, so a key costs half a network round trip, like a
 * tmux key binding, instead of a new SSH session, login shell, and prompt.
 *
 * Commands are written only after the remote shell reports that it is ready.
 * If the channel exits before that, no command can have run, and the queued
 * actions are handed back through `onFallback` for the interactive SSH path.
 */
export class NavigationChannel {
  constructor({ host, sessionId, sshOptions = [], spawnProcess = spawn, onSuccess = () => {}, onFailure = () => {}, onFallback = () => {} }) {
    this.host = host;
    this.sessionId = sessionId;
    this.sshOptions = sshOptions;
    this.spawnProcess = spawnProcess;
    this.onSuccess = onSuccess;
    this.onFailure = onFailure;
    this.onFallback = onFallback;
    this.child = undefined;
    this.ready = false;
    this.queued = [];
    this.sent = [];
    this.output = "";
    this.idleWaiters = [];
    this.draining = false;
    this.drainFallback = [];
  }

  start() {
    if (this.child) return;
    // BatchMode keeps SSH from prompting on the controller's raw-mode terminal.
    // If the control master is gone and SSH needs a password, the channel exits
    // before it is ready and the caller falls back to interactive SSH.
    const child = this.spawnProcess(
      "ssh",
      [...this.sshOptions, "-o", "BatchMode=yes", "-T", this.host, CHANNEL_COMMAND],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    this.child = child;
    this.ready = false;
    this.output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => this.#receive(child, data));
    child.stdin.on("error", () => {}); // Reported through the exit handler.
    child.on("error", () => this.#exited(child));
    child.on("close", () => this.#exited(child));
  }

  /** Queue one action. Returns false when the action has no remote command. */
  send(action) {
    const command = navigationCommand(this.sessionId, action);
    if (!command) return false;
    this.queued.push({ action, command });
    this.start();
    this.#flush();
    return true;
  }

  /**
   * Wait until every queued action is confirmed or the channel exits. Resolves
   * with actions that never reached the remote shell, in their original order.
   */
  drain() {
    this.draining = true;
    if (this.#idle()) return Promise.resolve(this.#takeDrainFallback());
    return new Promise((resolve) => this.idleWaiters.push(() => resolve(this.#takeDrainFallback())));
  }

  close() {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.end();
    child.stdout.destroy();
    child.kill();
    child.unref();
  }

  #idle() {
    return this.queued.length === 0 && this.sent.length === 0;
  }

  #takeDrainFallback() {
    const actions = this.drainFallback;
    this.drainFallback = [];
    return actions;
  }

  #flush() {
    if (!this.ready || !this.child) return;
    for (const entry of this.queued) {
      // Keep the command stream on stdin: tmux must never read from it.
      this.child.stdin.write(`${entry.command} </dev/null >/dev/null 2>&1; echo "${STATUS_MARKER} $?"\n`);
      this.sent.push(entry);
    }
    this.queued = [];
  }

  #receive(child, data) {
    if (child !== this.child) return;
    this.output += data;
    let newline;
    while ((newline = this.output.indexOf("\n")) >= 0) {
      const line = this.output.slice(0, newline).replace(/\r$/, "");
      this.output = this.output.slice(newline + 1);
      if (!this.ready) {
        if (line === READY_MARKER) {
          this.ready = true;
          this.#flush();
        }
      } else if (line.startsWith(`${STATUS_MARKER} `)) {
        const entry = this.sent.shift();
        if (entry) {
          if (line === `${STATUS_MARKER} 0`) this.onSuccess(entry.action);
          else this.onFailure(entry.action);
        }
      }
    }
    this.#notifyIdle();
  }

  #exited(child) {
    if (child !== this.child && this.child !== undefined) return;
    if (child === this.child) this.child = undefined;
    const wasReady = this.ready;
    this.ready = false;
    // A sent command may or may not have run. Never resend it.
    for (const entry of this.sent) this.onFailure(entry.action);
    this.sent = [];
    if (!wasReady && this.queued.length > 0) {
      const actions = this.queued.map((entry) => entry.action);
      this.queued = [];
      if (this.draining) this.drainFallback.push(...actions);
      else this.onFallback(actions);
    }
    this.#notifyIdle();
  }

  #notifyIdle() {
    if (!this.#idle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
