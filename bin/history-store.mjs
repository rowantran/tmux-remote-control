import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const validId = (id) => typeof id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id);
const validStatus = (status) => status === "sent" || status === "unconfirmed";

export function getHistoryDirectory(env = process.env) {
  return env.TMUX_REMOTE_CONTROL_HISTORY_DIR || join(
    env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"),
    "tmux-remote-control",
    "history",
  );
}

function sanitizeEntry(value, id) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { timestamp, text, host, session, status } = value;
  if (value.id !== id || !validId(id) || !validStatus(status) ||
      typeof text !== "string" || text === "" ||
      typeof host !== "string" || typeof session !== "string" ||
      typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp) return null;
  return { id, timestamp, text, host, session, status };
}

function readEntry(directory, id) {
  const path = join(directory, `${id}.json`);
  try {
    // Ignore directories and symlinks as well as malformed/incomplete records.
    if (!lstatSync(path).isFile()) return null;
    return sanitizeEntry(JSON.parse(readFileSync(path, "utf8")), id);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function loadHistory(directory) {
  let files;
  try {
    files = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const id = file.name.slice(0, -5);
    if (!validId(id)) continue;
    const entry = readEntry(directory, id);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

function removeEntry(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function writeEntry(directory, entry) {
  // History contains plaintext message text and destination names, not encrypted
  // secrets. Keep the directory private and publish only complete 0600 files.
  // Separate files avoid read/modify/write losses between controller processes.
  const temporary = join(directory, `.${entry.id}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(sanitizeEntry(entry, entry.id))}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(directory, `${entry.id}.json`));
  } finally {
    removeEntry(temporary);
  }
}

// Call before sending. Only a successful SSH command should be marked "sent";
// a failure (or an interrupted controller) leaves delivery "unconfirmed".
export function recordSubmission(directory, { text, host, session }, limit = 1000) {
  if (text === "") return null;
  if (typeof text !== "string" || typeof host !== "string" || typeof session !== "string") {
    throw new TypeError("History text, host, and session must be strings");
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("History limit must be a non-negative integer");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const entry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    text,
    host,
    session,
    status: "unconfirmed",
  };
  writeEntry(directory, entry);
  for (const old of loadHistory(directory).slice(limit)) {
    removeEntry(join(directory, `${old.id}.json`));
  }
  return entry;
}

export function markSubmission(directory, id, status) {
  if (!validId(id)) throw new TypeError("Invalid history ID");
  if (!validStatus(status)) throw new TypeError("Invalid history status");
  const entry = readEntry(directory, id);
  if (!entry) return null;
  chmodSync(directory, 0o700);
  entry.status = status;
  writeEntry(directory, entry);
  return entry;
}
