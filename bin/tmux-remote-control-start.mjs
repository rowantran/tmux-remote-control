#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openControllerWindow, shellQuote } from "./ghostty-window.mjs";
import { runProcess } from "./launch-process.mjs";

const EXECUTABLE = fileURLToPath(new URL("./tmux-remote-control", import.meta.url));
export const START_USAGE = `Usage:
  tmux-remote-control start HOST SESSION [-- COMMAND [ARG...]]
  tmux-remote-control start --host HOST --session SESSION [-- COMMAND [ARG...]]

Run locally in a macOS Ghostty terminal. Create or reuse the named remote tmux
session, open a local controller window, then attach this terminal over SSH.
COMMAND runs only when creating a new session; otherwise it is ignored.
Without COMMAND, a new session uses tmux's default shell.

HOST and SESSION default to TMUX_REMOTE_CONTROL_HOST and
TMUX_REMOTE_CONTROL_SESSION. SESSION is an exact name, not a pane or session ID.
Ghostty 1.3+ and macOS Automation permission are required. Window placement and
Pi's editor display mode are unchanged. Use attach on other local terminals.
`;

export function parseStartArgs(args, env = process.env) {
  let host;
  let session;
  let command = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--") {
      command = args.slice(i + 1);
      if (!command.length || !command[0]) throw new Error("-- requires a command");
      break;
    }
    if (arg === "--host" || arg === "--session") {
      if (i + 1 === args.length) throw new Error(`${arg} requires a value`);
      if (arg === "--host") {
        if (host !== undefined) throw new Error("SSH host was specified more than once");
        host = args[++i];
      } else {
        if (session !== undefined) throw new Error("session was specified more than once");
        session = args[++i];
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown start option: ${arg}`);
    } else if (host === undefined) {
      host = arg;
    } else if (session === undefined) {
      session = arg;
    } else {
      throw new Error("unexpected start argument; put a startup command after --");
    }
  }
  host ??= env.TMUX_REMOTE_CONTROL_HOST ?? "";
  session ??= env.TMUX_REMOTE_CONTROL_SESSION ?? "";
  if (!host || /^-|[\s\x00-\x1f\x7f]/u.test(host)) throw new Error("start requires a valid SSH host");
  if (!session || /[.:\x00-\x1f\x7f]/u.test(session)) {
    throw new Error("start requires an exact session name without dots, colons, or control characters");
  }
  if (command.some((arg) => arg.includes("\0"))) throw new Error("invalid startup command argument");
  return { host, session, command };
}

export function requireLocalGhostty({ env = process.env, platform = process.platform,
  tty = process.stdin.isTTY && process.stdout.isTTY } = {}) {
  if (platform !== "darwin" || env.TERM_PROGRAM !== "ghostty" || !tty ||
    env.TMUX || env.STY || env.SSH_CONNECTION || env.SSH_TTY) {
    throw new Error("start requires a local macOS Ghostty terminal, outside tmux, screen, and SSH. Use tmux-remote-control attach HOST SESSION in other terminals.");
  }
}

// new-session -A can attach to an existing session even with -d, so it cannot
// be used in the noninteractive bootstrap. Exact lookup also prevents 'work'
// from silently resolving to 'work-other'. If another launcher creates the
// same name concurrently, reuse it without ever sending a startup command.
export const ENSURE_SESSION_SCRIPT = `
name="$1"
shift
target="=$name"
if ! tmux has-session -t "$target" 2>/dev/null; then
  if [ "$#" -gt 0 ]; then
    error=$(tmux new-session -d -s "$name" /bin/sh -c 'exec "$@"' tmux-remote-control "$@" 2>&1)
  else
    error=$(tmux new-session -d -s "$name" 2>&1)
  fi
  result=$?
  if [ "$result" -ne 0 ]; then
    if ! tmux has-session -t "$target" 2>/dev/null; then
      printf '%s\\n' "$error" >&2
      exit "$result"
    fi
  fi
fi
id=$(tmux display-message -p -t "$target:" '#{session_id}') || exit $?
printf '\\nTMUX_REMOTE_CONTROL_SESSION=%s\\n' "$id"
`;

export function ensureSessionCommand({ session, command = [] }) {
  // SSH invokes the account's login shell, which may be Fish or Nushell. Only
  // a simple, quoted sh invocation is exposed to that shell; all syntax and
  // startup argv handling live inside POSIX sh.
  return `sh -c ${[ENSURE_SESSION_SCRIPT, "tmux-remote-control", session, ...command].map(shellQuote).join(" ")}`;
}

export function sessionIdFromOutput(output) {
  const matches = [...output.matchAll(/^TMUX_REMOTE_CONTROL_SESSION=(\$[0-9]+)\r?$/gm)];
  if (matches.length !== 1) throw new Error("could not resolve the remote tmux session; the startup command may have exited");
  return matches[0][1];
}

export function sshConnection(host, { run = runProcess, signal, env = process.env } = {}) {
  // Keep ControlPath short enough for macOS Unix sockets. The controller uses
  // its own existing attach connection and remains independent of this one.
  const directory = mkdtempSync("/tmp/tmux-rc-start.");
  const controlPath = `${directory}/c`;
  const args = ["-o", "ControlMaster=auto", "-o", "ControlPersist=10m", "-o", `ControlPath=${controlPath}`];
  return {
    async ensureSession(options) {
      const result = await run("ssh", [...args, "-T", host, ensureSessionCommand(options)], { signal });
      if (result.code !== 0) throw new Error(`could not create or find the tmux session on ${host}`);
      return sessionIdFromOutput(result.stdout);
    },
    async attach(sessionId) {
      const command = `tmux attach-session -t ${shellQuote(sessionId)}`;
      // This invokes the SSH binary, not Ghostty's interactive-shell wrapper.
      // Use the widely available terminfo name rather than requiring Ghostty's
      // terminfo to be installed on the server just to attach the remote view.
      const terminalEnv = env.TERM === "xterm-ghostty" ? { ...env, TERM: "xterm-256color" } : env;
      const result = await run("ssh", [...args, "-t", host, command], { interactive: true, signal, env: terminalEnv });
      return result.code;
    },
    async close() {
      try {
        // Cleanup must run even after cancellation and must not ask to log in.
        await run("ssh", ["-o", `ControlPath=${controlPath}`, "-O", "exit", host], { timeoutMs: 5000, quiet: true });
      } catch {
        // A disconnected master may already be gone.
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

export async function startSession(options, { check = requireLocalGhostty, connect = sshConnection,
  openWindow = openControllerWindow, env = process.env, signal, executable = EXECUTABLE } = {}) {
  check({ env }); // Fail before creating anything remotely on unsupported terminals.
  const connection = connect(options.host, { signal, env });
  let sessionId;
  try {
    sessionId = await connection.ensureSession(options);
    if (signal?.aborted) throw new Error("launch cancelled");
    await openWindow({ executable, host: options.host, sessionId, env, signal });
    if (signal?.aborted) throw new Error("launch cancelled");
    return await connection.attach(sessionId);
  } catch (error) {
    // Never kill the remote session or close a potentially useful controller
    // window when launch/attachment fails. The operation may have succeeded
    // before SSH or AppleScript reported an error.
    if (sessionId && !signal?.aborted) {
      const fallback = ["tmux-remote-control", "attach", "--host", options.host, "--session", sessionId].map(shellQuote).join(" ");
      throw new Error(`${error.message}\nThe remote session was left running. To attach a controller manually:\n${fallback}`, { cause: error });
    }
    throw error;
  } finally {
    await connection.close();
  }
}

async function main() {
  const controller = new AbortController();
  let interrupted = 0;
  const handlers = new Map([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]].map(([signal, code]) => {
    const handler = () => { interrupted = code; controller.abort(); };
    process.on(signal, handler);
    return [signal, handler];
  }));
  try {
    const options = parseStartArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(START_USAGE);
    else process.exitCode = await startSession(options, { signal: controller.signal });
  } catch (error) {
    if (!interrupted) console.error(`tmux-remote-control: ${error.message}`);
    process.exitCode = interrupted || 1;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (interrupted) process.exitCode = interrupted;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
