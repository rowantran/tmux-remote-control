import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { controllerWindowArgs, openControllerWindow, GHOSTTY_WINDOW_SCRIPT, shellQuote } from "../bin/ghostty-window.mjs";

// Window tests must never read or overwrite the user's saved controller IDs.
const stateRoot = mkdtempSync(join(tmpdir(), "tmux-rc-window-state-"));
after(() => rmSync(stateRoot, { recursive: true, force: true }));
const options = { executable: "/a path/controller's executable", host: "dev'box", sessionId: "$42", cwd: "/project's directory",
  env: { XDG_STATE_HOME: stateRoot, PATH: "/custom/bin", TMUX_REMOTE_CONTROL_EDITOR: "code --wait", SSH_AUTH_SOCK: "/private/agent.sock" } };

test("Ghostty window configuration uses static AppleScript with separate data arguments", async () => {
  const calls = [];
  const id = await openControllerWindow(options, async (...args) => {
    calls.push(args);
    return { code: 0, stdout: "window-id\n" };
  });
  assert.equal(id, "window-id");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "osascript");
  const args = calls[0][1];
  assert.deepEqual(args.slice(0, 3), ["-e", GHOSTTY_WINDOW_SCRIPT, "--"]);
  assert.equal(args[4], options.cwd);
  assert.equal(args[5], "");
  assert.match(args[3], /^\/bin\/bash --noprofile --norc -c '/);
  assert.doesNotMatch(args[3], /^shell:/);
  assert.ok(!GHOSTTY_WINDOW_SCRIPT.includes(options.host));
  assert.match(GHOSTTY_WINDOW_SCRIPT, /if exists window id savedWindowId then return savedWindowId/);
  assert.ok(GHOSTTY_WINDOW_SCRIPT.indexOf("return savedWindowId") < GHOSTTY_WINDOW_SCRIPT.indexOf("new window with configuration cfg"));
  assert.match(GHOSTTY_WINDOW_SCRIPT, /new window with configuration cfg/);
  assert.match(GHOSTTY_WINDOW_SCRIPT, /environment variables of cfg to items 4 thru -1 of argv/);
  assert.match(GHOSTTY_WINDOW_SCRIPT, /wait after command of cfg to false/);
  assert.doesNotMatch(GHOSTTY_WINDOW_SCRIPT, /input text|send key|System Events/);
  assert.equal(calls[0][2].timeoutMs, 60_000);
});

test("repeated launches reuse a saved live window, but not closed windows or other destinations", async () => {
  const env = { ...options.env, XDG_STATE_HOME: join(stateRoot, "reuse") };
  const liveWindows = new Set();
  const savedIds = [];
  let created = 0;
  // Model Ghostty's existence check without automating the desktop.
  const run = async (_command, args) => {
    const savedId = args[5];
    savedIds.push(savedId);
    if (liveWindows.has(savedId)) return { code: 0, stdout: `${savedId}\n` };
    const id = `window-${++created}`;
    liveWindows.add(id);
    return { code: 0, stdout: `${id}\n` };
  };
  const open = (changes = {}) => openControllerWindow({ ...options, env, ...changes }, run);
  assert.equal(await open(), "window-1");
  assert.equal(await open(), "window-1", "retry after an SSH drop must keep the controller");
  assert.equal(created, 1);
  assert.equal(await open({ host: "other-host" }), "window-2");
  assert.equal(await open({ sessionId: "$43" }), "window-3");
  assert.equal(await open(), "window-1");
  liveWindows.delete("window-1");
  assert.equal(await open(), "window-4", "closed window IDs must not prevent a replacement");
  assert.equal(await open(), "window-4", "the replacement must be remembered");
  assert.deepEqual(savedIds, ["", "window-1", "", "", "window-1", "window-1", "window-4"]);
  const directory = join(env.XDG_STATE_HOME, "tmux-remote-control", "windows");
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const files = readdirSync(directory);
  assert.equal(files.length, 3);
  for (const file of files) assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
});

test("failure to save a window ID does not block attachment", async (t) => {
  const file = join(stateRoot, "not-a-directory");
  writeFileSync(file, "");
  const warning = t.mock.method(console, "error", () => {});
  const id = await openControllerWindow({ ...options, env: { XDG_STATE_HOME: file } }, async (_command, args) => {
    assert.equal(args[5], "");
    return { code: 0, stdout: "new-window\n" };
  });
  assert.equal(id, "new-window");
  assert.match(warning.mock.calls[0].arguments[0], /next start may open another window/);
});

test("only controller settings and required local environment are forwarded", () => {
  const args = controllerWindowArgs({ ...options, env: { ...options.env, SECRET_TOKEN: "not-for-Ghostty",
    GHOSTTY_WINDOW_ID: "old", TMUX: "old socket", SSH_CONNECTION: "remote", TMUX_REMOTE_CONTROL_TARGET: "%99" } });
  const values = args.slice(6);
  assert.ok(values.includes("PATH=/custom/bin"));
  assert.ok(values.includes("SSH_AUTH_SOCK=/private/agent.sock"));
  assert.ok(values.includes("TMUX_REMOTE_CONTROL_EDITOR=code --wait"));
  assert.ok(values.includes("TMUX_REMOTE_CONTROL_HISTORY_DIR="));
  assert.ok(values.includes("TMUX="));
  assert.ok(values.includes("SSH_CONNECTION="));
  assert.ok(values.includes("TMUX_REMOTE_CONTROL_TARGET="));
  assert.ok(!values.some((value) => /SECRET_TOKEN|GHOSTTY_WINDOW_ID/.test(value)));
});

test("window errors explain permissions and are never automatically retried", async () => {
  for (const result of [{ code: 1, stdout: "" }, { code: 0, stdout: "" }, new Error("timed out")]) {
    let calls = 0;
    await assert.rejects(openControllerWindow(options, async () => {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    }), /Ghostty 1.3\+.*Automation.*before retrying/);
    assert.equal(calls, 1);
  }
});

test("cancellation does not get misreported as an Automation permission failure", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(openControllerWindow({ ...options, signal: controller.signal }, async () => {
    throw new Error("launch cancelled");
  }), /^Error: launch cancelled$/);
});

test("invalid window destinations are rejected without invoking osascript", async () => {
  for (const change of [{ executable: "relative/path" }, { host: "-flag" }, { host: "bad host" },
    { sessionId: "$3; touch file" }, { executable: "/bad\0path" }]) {
    await assert.rejects(openControllerWindow({ ...options, ...change }, () => assert.fail("must not automate")));
  }
});

test("the complete AppleScript command survives Ghostty's exec wrapper and preserves literal argv", () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-rc-ghostty-test-"));
  const executable = join(root, "controller's \"name\"; false");
  const log = join(root, "argv.json");
  try {
    writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(`${executable}.mjs`)} "$@"\n`, { mode: 0o700 });
    writeFileSync(`${executable}.mjs`, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.FIXTURE_EXIT || 0));\n`);
    const host = "dev'box;false";
    const args = controllerWindowArgs({ ...options, executable, host });
    for (const code of [0, 7]) {
      // Match the macOS launcher shown in Ghostty's failure report. Do not
      // strip prefixes or otherwise pre-process the actual API command.
      // Ghostty execs it, so error handling must live in its own child shell.
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `exec -l ${args[3]}`], {
        env: { ...process.env, ARGV_LOG: log, FIXTURE_EXIT: String(code) }, encoding: "utf8", input: "\n", timeout: 5000,
      });
      assert.equal(result.status, code, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["attach", "--host", host, "--session", "$42"]);
      if (code) assert.match(result.stdout, /Controller exited \(7\).*Press Enter/);
      else assert.equal(result.stdout, "");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
