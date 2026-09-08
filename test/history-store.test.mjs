import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getHistoryDirectory, loadHistory, markSubmission, recordSubmission } from "../bin/history-store.mjs";

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "tmux-history-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "history");
}
const message = { host: "devbox", session: "work", text: "message" };

test("history paths honor an explicit directory and XDG state location", () => {
  assert.equal(getHistoryDirectory({ TMUX_REMOTE_CONTROL_HISTORY_DIR: "/custom" }), "/custom");
  assert.equal(getHistoryDirectory({ XDG_STATE_HOME: "/state" }), "/state/tmux-remote-control/history");
  assert.equal(getHistoryDirectory({ HOME: "/home/test" }), "/home/test/.local/state/tmux-remote-control/history");
});

test("history preserves text, timestamp, duplicate submissions, and no pane metadata", (t) => {
  const dir = directory(t);
  assert.deepEqual(loadHistory(dir), []);
  const text = "  first\tline\r\nsecond\n\n";
  const first = recordSubmission(dir, { ...message, text, pane: "%17" });
  const second = recordSubmission(dir, { ...message, text });
  assert.notEqual(first.id, second.id);
  const entries = loadHistory(dir);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.text, text);
    assert.equal(entry.host, "devbox");
    assert.equal(entry.session, "work");
    assert.equal(entry.status, "unconfirmed");
    assert.deepEqual(Object.keys(entry).sort(), ["host", "id", "session", "status", "text", "timestamp"]);
    assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
  }
  assert.equal(markSubmission(dir, first.id, "sent").timestamp, first.timestamp);
  assert.equal(loadHistory(dir).find((entry) => entry.id === first.id).status, "sent");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const file of readdirSync(dir)) assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
});

test("retention removes old entries and ignores incomplete files", (t) => {
  const dir = directory(t);
  const old = recordSubmission(dir, message);
  writeFileSync(join(dir, `${old.id}.json`), JSON.stringify({ ...old, timestamp: "2000-01-01T00:00:00.000Z" }));
  recordSubmission(dir, { ...message, text: "new" }, 1);
  assert.deepEqual(loadHistory(dir).map((entry) => entry.text), ["new"]);
  const invalid = randomUUID();
  writeFileSync(join(dir, `${invalid}.json`), "{incomplete");
  writeFileSync(join(dir, "ignored.tmp"), "unfinished");
  writeFileSync(join(dir, "ignored.json"), "{}");
  assert.equal(loadHistory(dir).length, 1);
  assert.equal(recordSubmission(dir, { ...message, text: "" }), null);
  assert.throws(() => markSubmission(dir, "../../bad", "sent"), /Invalid history ID/);
  assert.throws(() => markSubmission(dir, invalid, "failed"), /Invalid history status/);
  assert.equal(markSubmission(dir, randomUUID(), "sent"), null);
});

test("concurrent controller writes do not overwrite other submissions", async (t) => {
  const dir = directory(t);
  const url = new URL("../bin/history-store.mjs", import.meta.url).href;
  await Promise.all(Array.from({ length: 8 }, (_, n) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { recordSubmission, markSubmission } from ${JSON.stringify(url)};
      const entry = recordSubmission(process.argv[1], {host:'host',session:'work',text:process.argv[2]});
      markSubmission(process.argv[1], entry.id, 'sent');
    `, dir, String(n)], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (data) => { error += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.deepEqual(loadHistory(dir).map((entry) => entry.text).sort(), ["0", "1", "2", "3", "4", "5", "6", "7"]);
  assert.ok(loadHistory(dir).every((entry) => entry.status === "sent"));
  for (const file of readdirSync(dir)) assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, file))));
});
