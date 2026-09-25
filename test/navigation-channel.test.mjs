import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CHANNEL_COMMAND,
  NavigationChannel,
  READY_MARKER,
  STATUS_MARKER,
  navigationCommand,
} from "../bin/navigation-channel.mjs";

function fakeSsh() {
  const children = [];
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter();
    child.file = file;
    child.args = args;
    child.options = options;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.written = "";
    child.stdin.on("data", (data) => (child.written += data));
    child.killed = false;
    child.kill = () => (child.killed = true);
    child.unref = () => {};
    child.reply = (line) => child.stdout.write(`${line}\n`);
    child.exit = () => child.emit("close", 255);
    children.push(child);
    return child;
  };
  return { children, spawnProcess };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const commands = (child) => child.written.split("\n").filter(Boolean).map((line) => line.split(" </dev/null")[0]);

function channel(ssh, options = {}) {
  return new NavigationChannel({
    host: "devbox",
    sessionId: "$3",
    sshOptions: ["-o", "ControlPath=/tmp/c"],
    spawnProcess: ssh.spawnProcess,
    ...options,
  });
}

test("maps every controller action to a quoted tmux command", () => {
  const client = `client=$(tmux list-clients -t '$3' -F '#{client_tty}' | head -n 1) && test -n "$client"`;
  const send = (key) => `${client} && tmux send-keys -K -c "$client" '${key}'`;
  const mode = `test "$(tmux display-message -p -t '$3' '#{pane_mode}')" = copy-mode`;
  const prefix = `test "$(tmux display-message -p -c "$client" '#{client_key_table}')" = prefix`;
  assert.equal(navigationCommand("$3", "prefix-start"), `${send("C-a")} && ${prefix}`);
  assert.equal(navigationCommand("$3", "prefix-cancel"), `${client} && tmux switch-client -c "$client" -T root`);
  assert.ok(navigationCommand("$3", "prefix-key:[").startsWith(`${client} && ${prefix} && tmux send-keys -K -c "$client" '[' && ${mode} && (`));
  assert.ok(navigationCommand("$3", "prefix-key:[").includes("status-right \"$current#{?#{==:#{pane_mode},copy-mode}, [scrollback],}\""));
  assert.equal(navigationCommand("$3", "prefix-key:C-n"), `${client} && ${prefix} && tmux send-keys -K -c "$client" 'C-n'`);
  assert.equal(navigationCommand("$3", "prefix-key:;"), `${client} && ${prefix} && tmux send-keys -K -c "$client" ';'`);
  for (const key of ["q", "v", "h", "j", "k", "l", "Enter", "C-u", "C-d", "PageUp", "PageDown"]) {
    assert.equal(navigationCommand("$3", `copy-key:${key}`), `${mode} && ${send(key)}`);
  }
  for (const key of ["C-h", "C-j", "C-k", "C-l", "y", "n", "Escape"]) {
    assert.equal(navigationCommand("$3", `send-key:${key}`), send(key));
  }
  assert.equal(navigationCommand("$3", "send-key:'"), `${client} && tmux send-keys -K -c "$client" ''\\'''`);
  assert.equal(navigationCommand("$3", "copy-key:"), undefined);
  assert.equal(navigationCommand("$3", "send-key:"), undefined);
  assert.equal(navigationCommand("$3", "other-key:q"), undefined);
  assert.ok(navigationCommand("it's", "prefix-key:[").includes("-t 'it'\\''s'"));
  assert.equal(navigationCommand("$3", "editor"), undefined);
  assert.equal(navigationCommand("$3", "prefix-key:"), undefined);
  assert.equal(navigationCommand("$3", "window-7"), undefined);
});

test("uses the shared control connection without an interactive prompt", () => {
  const ssh = fakeSsh();
  channel(ssh).start();
  const [child] = ssh.children;
  assert.equal(child.file, "ssh");
  assert.deepEqual(child.args, ["-o", "ControlPath=/tmp/c", "-o", "BatchMode=yes", "-T", "devbox", CHANNEL_COMMAND]);
  assert.deepEqual(child.options.stdio, ["pipe", "pipe", "ignore"]);
});

test("writes commands only after the remote shell is ready, then in order", async () => {
  const ssh = fakeSsh();
  const nav = channel(ssh);
  nav.send("prefix-start");
  nav.send("prefix-key:C-n");
  await tick();
  const [child] = ssh.children;
  assert.equal(child.written, "");
  child.reply(READY_MARKER);
  await tick();
  assert.deepEqual(commands(child), [navigationCommand("$3", "prefix-start"), navigationCommand("$3", "prefix-key:C-n")]);
  assert.match(child.written, new RegExp(`; echo "${STATUS_MARKER} \\$\\?"\\n$`));
  nav.send("prefix-key:[");
  nav.send("copy-key:PageUp");
  await tick();
  assert.equal(commands(child).at(-2), navigationCommand("$3", "prefix-key:["));
  assert.equal(commands(child).at(-1), navigationCommand("$3", "copy-key:PageUp"));
  assert.equal(ssh.children.length, 1, "one channel serves every key");
});

test("drain waits for confirmation of every sent command", async () => {
  const ssh = fakeSsh();
  const nav = channel(ssh);
  nav.start();
  const [child] = ssh.children;
  child.reply(READY_MARKER);
  await tick();
  nav.send("prefix-start");
  nav.send("prefix-key:[");
  let drained;
  nav.drain().then((unsent) => (drained = unsent));
  await tick();
  assert.equal(drained, undefined);
  child.reply(`${STATUS_MARKER} 0`);
  await tick();
  assert.equal(drained, undefined);
  child.reply(`${STATUS_MARKER} 0`);
  await tick();
  assert.deepEqual(drained, []);
});

test("confirms copy-mode only after the remote status succeeds", async () => {
  const ssh = fakeSsh();
  const successes = [];
  const failures = [];
  const nav = channel(ssh, {
    onSuccess: (action) => successes.push(action),
    onFailure: (action) => failures.push(action),
  });
  nav.send("prefix-key:[");
  nav.send("copy-key:C-u");
  const [child] = ssh.children;
  child.reply(READY_MARKER);
  await tick();
  assert.deepEqual(successes, []);
  child.reply(`${STATUS_MARKER} 0`);
  child.reply(`${STATUS_MARKER} 1`);
  await tick();
  assert.deepEqual(successes, ["prefix-key:["]);
  assert.deepEqual(failures, ["copy-key:C-u"]);
});

test("reports failed commands without resending them", async () => {
  const ssh = fakeSsh();
  const failures = [];
  const nav = channel(ssh, { onFailure: (action) => failures.push(action) });
  nav.send("prefix-start");
  nav.send("prefix-key:C-n");
  const [child] = ssh.children;
  child.reply(READY_MARKER);
  child.reply(`${STATUS_MARKER} 1`);
  await tick();
  assert.deepEqual(failures, ["prefix-start"]);
  child.exit(); // The next key was sent but never confirmed.
  await tick();
  assert.deepEqual(failures, ["prefix-start", "prefix-key:C-n"]);
  nav.send("prefix-start");
  assert.equal(ssh.children.length, 2, "the next key opens a new channel");
  assert.equal(ssh.children[1].written, "");
});

test("hands back queued keys when the channel exits before it is ready", async () => {
  const ssh = fakeSsh();
  const fallbacks = [];
  const nav = channel(ssh, { onFallback: (actions) => fallbacks.push(actions) });
  nav.send("prefix-start");
  nav.send("prefix-key:[");
  ssh.children[0].exit();
  await tick();
  assert.deepEqual(fallbacks, [["prefix-start", "prefix-key:["]]);
  assert.equal(ssh.children[0].written, "");
});

test("drain returns unsent keys instead of calling the fallback", async () => {
  const ssh = fakeSsh();
  const fallbacks = [];
  const nav = channel(ssh, { onFallback: (actions) => fallbacks.push(actions) });
  nav.send("prefix-cancel");
  const result = nav.drain();
  ssh.children[0].exit();
  assert.deepEqual(await result, ["prefix-cancel"]);
  assert.deepEqual(fallbacks, []);
});

test("an early exit with nothing queued is silent and close stops the child", async () => {
  const ssh = fakeSsh();
  const nav = channel(ssh, { onFailure: assert.fail, onFallback: assert.fail });
  nav.start();
  ssh.children[0].exit();
  await tick();
  assert.deepEqual(await nav.drain(), []);
  nav.start();
  nav.close();
  assert.equal(ssh.children[1].killed, true);
});
