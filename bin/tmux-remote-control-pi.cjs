#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { TextDecoder } = require("node:util");
const MAX_STDIN_BYTES = 1024 * 1024;
const hasControl = (value) => /[\x00-\x1f\x7f]/.test(value);
const validSocket = (value) => typeof value === "string" && value.startsWith("/") && !hasControl(value);
const validPid = (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));

function parseArgs(args) {
  const options = Object.create(null);
  const names = new Set(["--tmux-socket", "--tmux-server-pid", "--session", "--target", "--rpc-dir"]);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!names.has(name)) throw new Error(`unknown pi-send option: ${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`${name} was specified more than once`);
    const value = args[i + 1];
    if (!value || hasControl(value)) throw new Error(`${name} requires a valid nonempty value`);
    options[name] = value;
  }
  if (!validSocket(options["--tmux-socket"])) throw new Error("invalid or missing tmux socket path");
  if (!validPid(options["--tmux-server-pid"])) throw new Error("invalid or missing tmux server PID");
  if (Boolean(options["--session"]) === Boolean(options["--target"])) {
    throw new Error("pi-send requires exactly one of --session or --target");
  }
  if (options["--session"] && !/^\$[0-9]+$/.test(options["--session"])) {
    throw new Error("--session must be a stable tmux session ID ($ followed by digits)");
  }
  if (options["--target"] && !/^%[0-9]+$/.test(options["--target"])) {
    throw new Error("--target must be a tmux pane ID (% followed by digits)");
  }
  return options;
}

async function readPrompt() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_STDIN_BYTES) throw new Error("prompt exceeds the 1 MiB stdin limit");
    chunks.push(chunk);
  }
  if (length === 0) throw new Error("prompt is empty");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
  } catch {
    throw new Error("prompt is not valid UTF-8");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const text = await readPrompt();
  const { getIdentity, getRuntimeDir, sendToPane } = require("../lib/pi-remote.cjs");
  const target = options["--session"] || options["--target"];
  let snapshot;
  try {
    // One query snapshots both focus and server identity. Never resolve focus
    // again after selecting the RPC recipient, even if the user navigates.
    snapshot = execFileSync("tmux", [
      "-S", options["--tmux-socket"], "display-message", "-p", "-t", target,
      "#{socket_path}\t#{pid}\t#{pane_id}",
    ], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`could not identify the target tmux pane: ${detail}`);
  }
  const fields = snapshot.replace(/\n$/, "").split("\t");
  const [socketPath, serverPid, paneId] = fields;
  if (fields.length !== 3 || !validSocket(socketPath) || !validPid(serverPid) || !/^%[0-9]+$/.test(paneId || "")) {
    throw new Error("tmux returned an invalid server/pane identity");
  }
  if (serverPid !== options["--tmux-server-pid"]) {
    throw new Error(`tmux server PID changed: expected ${options["--tmux-server-pid"]}, got ${serverPid}; generate a new controller command`);
  }
  const identity = getIdentity({ TMUX: `${socketPath},${serverPid},0`, TMUX_PANE: paneId });
  if (!identity || !validSocket(identity.socketPath) || String(identity.serverPid) !== serverPid || identity.paneId !== paneId || !identity.serverKey) {
    throw new Error("could not construct the Pi pane identity");
  }
  const runtimeEnv = { ...process.env };
  if (options["--rpc-dir"]) runtimeEnv.TMUX_REMOTE_CONTROL_RPC_DIR = options["--rpc-dir"];
  const runtimeDir = getRuntimeDir(runtimeEnv);
  await sendToPane({ identity, runtimeDir, text, deliverAs: "steer", timeoutMs: 5000 });
}

main().catch((error) => {
  process.stdin.destroy();
  console.error(`tmux-remote-control pi-send: ${error.message || error}`);
  process.exitCode = 1;
});
