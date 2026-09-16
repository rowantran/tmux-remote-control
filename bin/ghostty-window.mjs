import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./launch-process.mjs";

export function shellQuote(value) {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("invalid command argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Arguments are AppleScript data, not script source. In particular, neither
// the host nor the local executable path may inject AppleScript or shell code.
export const GHOSTTY_WINDOW_SCRIPT = `
on run argv
  tell application "Ghostty"
    set savedWindowId to item 3 of argv
    if savedWindowId is not "" then
      if exists window id savedWindowId then return savedWindowId
    end if
    set cfg to new surface configuration
    set command of cfg to item 1 of argv
    set initial working directory of cfg to item 2 of argv
    set environment variables of cfg to items 4 thru -1 of argv
    set wait after command of cfg to false
    set win to new window with configuration cfg
    return id of win
  end tell
end run
`;

const FORWARDED_ENV = [
  "PATH", "SSH_AUTH_SOCK", "EDITOR", "VISUAL", "XDG_STATE_HOME", "TMPDIR",
  "TMUX_REMOTE_CONTROL_EDITOR", "TMUX_REMOTE_CONTROL_TMPDIR",
  "TMUX_REMOTE_CONTROL_HISTORY", "TMUX_REMOTE_CONTROL_HISTORY_DIR",
  "TMUX_REMOTE_CONTROL_HISTORY_PICKER", "TMUX_REMOTE_CONTROL_AEROSPACE_RESIZE",
];

export function controllerWindowArgs({ executable, host, sessionId, windowId = "", env = process.env, cwd = process.cwd() }) {
  if (!executable.startsWith("/") || !/^\$[0-9]+$/.test(sessionId) || !host || /^-|[\s\x00-\x1f\x7f]/u.test(host)) {
    throw new Error("invalid controller window destination");
  }
  const attach = [executable, "attach", "--host", host, "--session", sessionId].map(shellQuote).join(" ");
  // Close normally on Ctrl-D, but keep connection/startup errors visible until
  // acknowledged. A new terminal process is started directly; no keystrokes
  // are sent to an existing shell or application.
  const controllerScript = `${attach}; status=$?; if [ "$status" -ne 0 ]; then printf '\\nController exited (%s). Press Enter to close.\\n' "$status"; IFS= read -r reply; fi; exit "$status"`;
  // The embedded/AppleScript API already treats command as shell text. It
  // does not parse the config file's shell: prefix. On macOS Ghostty prepends
  // `exec -l`, so the compound script needs its own shell or the exit/error
  // handling after attach is lost. Skip profiles to preserve the supplied env.
  const command = `/bin/bash --noprofile --norc -c ${shellQuote(controllerScript)}`;
  const environment = FORWARDED_ENV.map((key) => `${key}=${env[key] ?? ""}`);
  // Do not inherit stale remote/nested-terminal context or target defaults
  // from the process that originally launched the Ghostty app.
  for (const key of ["TMUX", "TMUX_PANE", "STY", "SSH_CONNECTION", "SSH_TTY",
    "TMUX_REMOTE_CONTROL_HOST", "TMUX_REMOTE_CONTROL_SESSION", "TMUX_REMOTE_CONTROL_TARGET"]) {
    environment.push(`${key}=`);
  }
  return ["-e", GHOSTTY_WINDOW_SCRIPT, "--", command, cwd, windowId, ...environment];
}

export async function openControllerWindow(options, run = runProcess) {
  const env = options.env ?? process.env;
  const directory = join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"),
    "tmux-remote-control", "windows");
  // Match the SSH alias and resolved tmux ID, not a mutable window title or a
  // session name that may have been reused for a different remote session.
  const key = createHash("sha256").update(JSON.stringify([options.host, options.sessionId])).digest("hex");
  const stateFile = join(directory, key);
  let windowId = "";
  try { windowId = readFileSync(stateFile, "utf8").trim(); }
  catch { /* No saved window (or unreadable state): open one normally. */ }
  const args = controllerWindowArgs({ ...options, windowId });
  try {
    // Allow time for the first macOS Automation permission prompt. Never retry:
    // a timeout can occur after a window was already created.
    const result = await run("osascript", args, { signal: options.signal, timeoutMs: 60_000 });
    if (result.code !== 0 || !result.stdout.trim()) throw new Error("window creation failed");
    windowId = result.stdout.trim();
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(stateFile, `${windowId}\n`, { mode: 0o600 });
    } catch {
      // Saving a reuse hint must not prevent attachment after opening a window.
      console.error("tmux-remote-control: could not save the controller window ID; the next start may open another window.");
    }
    return windowId;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error("Could not open the controller window. Use Ghostty 1.3+ with macos-applescript enabled and allow macOS Automation access to Ghostty. Check for an existing controller window before retrying.", { cause: error });
  }
}
