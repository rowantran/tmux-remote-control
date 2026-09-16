import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseStartArgs, requireLocalGhostty, ensureSessionCommand, sessionIdFromOutput,
  sshConnection, startSession } from "../bin/tmux-remote-control-start.mjs";

const options = { host: "devbox", session: "work", command: [] };

test("start arguments support positionals, flags, defaults, and literal command argv", () => {
  assert.deepEqual(parseStartArgs(["devbox", "work"], {}), options);
  assert.deepEqual(parseStartArgs(["--session", "work", "devbox"], {}), options);
  assert.deepEqual(parseStartArgs([], { TMUX_REMOTE_CONTROL_HOST: "devbox", TMUX_REMOTE_CONTROL_SESSION: "work" }), options);
  const defaults = { TMUX_REMOTE_CONTROL_HOST: "other", TMUX_REMOTE_CONTROL_SESSION: "other", TMUX_REMOTE_CONTROL_TARGET: "%7" };
  assert.deepEqual(parseStartArgs(["devbox", "work"], defaults), options);
  assert.deepEqual(parseStartArgs(["--host", "devbox", "--session", "work"], defaults), options);
  assert.deepEqual(parseStartArgs(["devbox", "work", "--", "pi", "--help", "", "a\nb"], {}), {
    ...options, command: ["pi", "--help", "", "a\nb"],
  });
  assert.equal(parseStartArgs(["--help"], {}).help, true);
  assert.equal(parseStartArgs(["-h"], {}).help, true);
  assert.deepEqual(parseStartArgs(["dev'box", "team's work"], {}), {
    host: "dev'box", session: "team's work", command: [],
  });
});

test("start rejects invalid and ambiguous arguments before launching anything", () => {
  for (const args of [[], ["devbox"], ["--host"], ["--session"], ["-bad", "work"],
    ["dev box", "work"], ["dev\nbox", "work"], ["devbox", ""], ["devbox", "work:0"],
    ["devbox", "work.0"], ["devbox", "work\n"], ["devbox", "work", "pi"],
    ["devbox", "work", "--"], ["devbox", "work", "--", ""], ["--target", "%7"],
    ["devbox", "--host", "other", "work"], ["devbox", "work", "--session", "other"],
    ["devbox", "work", "--", "pi", "bad\0arg"]]) {
    assert.throws(() => parseStartArgs(args, {}), undefined, JSON.stringify(args));
  }
});

test("start requires a direct local macOS Ghostty terminal", () => {
  const local = { platform: "darwin", tty: true, env: { TERM_PROGRAM: "ghostty" } };
  assert.doesNotThrow(() => requireLocalGhostty(local));
  for (const change of [{ platform: "linux" }, { tty: false }, { env: {} },
    ...["TMUX", "STY", "SSH_CONNECTION", "SSH_TTY"].map((key) => ({ env: { ...local.env, [key]: "set" } }))]) {
    assert.throws(() => requireLocalGhostty({ ...local, ...change }), /local macOS Ghostty terminal/);
  }
});

test("session discovery accepts one stable ID and ignores login banners", () => {
  assert.equal(sessionIdFromOutput("Welcome\r\n\nTMUX_REMOTE_CONTROL_SESSION=$42\r\n"), "$42");
  for (const text of ["$3\n", "TMUX_REMOTE_CONTROL_SESSION=work\n", "TMUX_REMOTE_CONTROL_SESSION=$3; evil\n",
    "TMUX_REMOTE_CONTROL_SESSION=$3\nTMUX_REMOTE_CONTROL_SESSION=$4\n", "TMUX_REMOTE_CONTROL_SESSION=\n"]) {
    assert.throws(() => sessionIdFromOutput(text), /could not resolve/);
  }
});

function fixture({ failAt, code = 0, signal } = {}) {
  const calls = [];
  const step = async (name, value) => {
    calls.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
    return value;
  };
  const connection = {
    ensureSession: (value) => { assert.deepEqual(value, options); return step("ensure", "$3"); },
    attach: (id) => { assert.equal(id, "$3"); return step("attach", code); },
    close: () => step("close"),
  };
  const io = {
    check: () => { calls.push("check"); if (failAt === "check") throw new Error("unsupported"); },
    connect: (host) => { assert.equal(host, "devbox"); calls.push("connect"); return connection; },
    openWindow: async (value) => {
      assert.equal(value.host, "devbox");
      assert.equal(value.sessionId, "$3");
      assert.ok(value.executable.startsWith("/"));
      await step("window");
    },
    signal,
  };
  return { calls, io };
}

test("start ensures the session, opens one controller, then attaches the current terminal", async () => {
  for (const code of [0, 255]) {
    const f = fixture({ code });
    assert.equal(await startSession(options, f.io), code);
    assert.deepEqual(f.calls, ["check", "connect", "ensure", "window", "attach", "close"]);
  }
});

test("start cleans up connection failures without killing sessions or retrying windows", async () => {
  for (const failAt of ["check", "ensure", "window", "attach"]) {
    const f = fixture({ failAt });
    await assert.rejects(startSession(options, f.io), failAt === "check" ? /unsupported/ : new RegExp(`${failAt} failed`));
    if (failAt === "check") assert.deepEqual(f.calls, ["check"]);
    else assert.equal(f.calls.at(-1), "close");
    if (failAt === "ensure") assert.ok(!f.calls.includes("window"));
    if (failAt === "window") assert.ok(!f.calls.includes("attach"));
    assert.ok(f.calls.filter((name) => name === "window").length <= 1);
  }
  const f = fixture({ failAt: "window" });
  await assert.rejects(startSession(options, f.io), /left running.*\n.*--session.*\$3/s);
});

test("cancellation between launch stages prevents further work and still cleans up", async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  f.io.openWindow = async () => { f.calls.push("window"); controller.abort(); };
  await assert.rejects(startSession(options, f.io), /cancelled/);
  assert.deepEqual(f.calls, ["check", "connect", "ensure", "window", "close"]);
});

test("SSH bootstrap and terminal attachment share a short private control socket", async () => {
  const calls = [];
  const controller = new AbortController();
  const connection = sshConnection("dev'box", { signal: controller.signal, run: async (...args) => {
    calls.push(args);
    return { code: 0, stdout: "TMUX_REMOTE_CONTROL_SESSION=$3\n" };
  } });
  await connection.ensureSession(options);
  await connection.attach("$3");
  const pathArg = calls[0][1].find((arg) => arg.startsWith("ControlPath="));
  const directory = pathArg.slice("ControlPath=".length, -2);
  assert.match(pathArg, /^ControlPath=\/tmp\/tmux-rc-start\.[^/]+\/c$/);
  assert.ok(pathArg.length < 80);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(calls[0][0], "ssh");
  assert.ok(calls[0][1].includes("-T"));
  assert.equal(calls[0][1].at(-2), "dev'box");
  assert.ok(calls[1][1].includes(pathArg));
  assert.ok(calls[1][1].includes("-t"));
  assert.equal(calls[1][1].at(-1), "tmux attach-session -t '$3'");
  assert.equal(calls[1][2].interactive, true);
  controller.abort();
  await connection.close();
  assert.ok(!existsSync(directory));
  assert.deepEqual(calls[2][1], ["-o", pathArg, "-O", "exit", "dev'box"]);
  assert.equal(calls[2][2].signal, undefined, "cancellation must not prevent cleanup");
});

test("remote attachment does not require Ghostty-specific terminfo on the server", async () => {
  for (const term of ["xterm-ghostty", "xterm-256color", "custom-term"]) {
    const env = { TERM: term, PATH: "/custom/bin" };
    const calls = [];
    const connection = sshConnection("devbox", { env, run: async (...args) => {
      calls.push(args);
      return { code: 0, stdout: "" };
    } });
    try {
      await connection.attach("$3");
      assert.equal(calls[0][2].env.TERM, term === "xterm-ghostty" ? "xterm-256color" : term);
      assert.equal(calls[0][2].env.PATH, "/custom/bin");
      assert.equal(env.TERM, term, "the local terminal environment is unchanged");
    } finally { await connection.close(); }
  }
});

test("bootstrap failures and malformed IDs stop before opening a window", async () => {
  for (const result of [{ code: 255, stdout: "" }, { code: 0, stdout: "not an ID" }]) {
    const connection = sshConnection("devbox", { run: async () => result });
    try { await assert.rejects(connection.ensureSession(options)); }
    finally { await connection.close(); }
  }
});

test("the Bash entrypoint finds start helpers through relative symlink chains", () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-rc-start-links-"));
  try {
    symlinkSync(resolve("bin/tmux-remote-control"), join(root, "actual"));
    symlinkSync("actual", join(root, "tmux-remote-control"));
    const result = spawnSync("/bin/bash", [join(root, "tmux-remote-control"), "start", "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /start HOST SESSION/);
    assert.match(result.stdout, /COMMAND runs only/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("remote bootstrap creates/reuses exact sessions and preserves command argv with real tmux", async (t) => {
  const which = spawnSync("which", ["tmux"], { encoding: "utf8" });
  if (which.status !== 0) return t.skip("tmux is not installed");
  const tmux = which.stdout.trim();
  const root = mkdtempSync("/tmp/tmux-rc-start-test.");
  const socket = join(root, "socket");
  const config = join(root, "tmux.conf");
  const env = { ...process.env, HOME: root, ENV: "", BASH_ENV: "", TMUX: "", TMUX_PANE: "", PATH: `${root}:${process.env.PATH}` };
  const control = (...args) => spawnSync(tmux, ["-S", socket, "-f", config, ...args], { env, encoding: "utf8", timeout: 5000 });
  writeFileSync(config, "set -g default-shell /bin/sh\n");
  writeFileSync(join(root, "tmux"), `#!/bin/sh\nexec ${JSON.stringify(tmux)} -S ${JSON.stringify(socket)} -f ${JSON.stringify(config)} "$@"\n`);
  chmodSync(join(root, "tmux"), 0o700);
  const remote = (session, command = []) => {
    const result = spawnSync("/bin/sh", ["-c", ensureSessionCommand({ session, command })], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return sessionIdFromOutput(result.stdout);
  };
  try {
    const probe = control("new-session", "-d", "-s", "probe", "/bin/sh");
    if (probe.status !== 0) return t.skip(`cannot create an isolated tmux socket: ${probe.stderr.trim()}`);
    const workOther = remote("work-other");
    const work = remote("work");
    assert.notEqual(work, workOther, "prefix matching must not reuse work-other");
    assert.equal(remote("work", ["/definitely-not-a-command"]), work, "a reused session must ignore the command");
    assert.equal(remote("work*"), remote("work*"), "wildcards are literal session names");
    const file = join(root, "argv.json");
    const argv = ["quote'\"", "$(touch SHOULD_NOT_EXIST)", "; exit 42", "", "line\nnext", " spaces "];
    const program = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))); setInterval(() => {}, 1000)";
    const special = remote("team's work", [process.execPath, "-e", program, file, ...argv]);
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), argv);
    assert.equal(remote("team's work", ["/definitely-not-a-command"]), special);
    assert.ok(!existsSync(join(root, "SHOULD_NOT_EXIST")));
    const sessions = control("list-sessions", "-F", "#{session_name}").stdout.trim().split("\n");
    assert.ok(sessions.includes("team's work"));
    const launches = join(root, "launches");
    const launchProgram = "require('node:fs').appendFileSync(process.argv[1], 'started\\n'); setInterval(() => {}, 1000)";
    const launchCommand = ensureSessionCommand({ session: "concurrent", command: [process.execPath, "-e", launchProgram, launches] });
    const concurrent = await Promise.all([1, 2].map(() => promisify(execFile)("/bin/sh", ["-c", launchCommand], { env, timeout: 5000 })));
    assert.equal(sessionIdFromOutput(concurrent[0].stdout), sessionIdFromOutput(concurrent[1].stdout));
    for (let i = 0; i < 100 && !existsSync(launches); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(readFileSync(launches, "utf8"), "started\n", "concurrent launch must start the program only once");
  } finally {
    control("kill-server");
    rmSync(root, { recursive: true, force: true });
  }
});
