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
  assert.equal(navigationCommand("$3", "pane-zoom"), "tmux resize-pane -Z -t '$3'");
  assert.equal(navigationCommand("$3", "pane-down"), "tmux select-pane -t '$3' -D");
  assert.equal(navigationCommand("$3", "pane-left"), "tmux select-pane -t '$3' -L");
  assert.equal(navigationCommand("$3", "pane-right"), "tmux select-pane -t '$3' -R");
  assert.equal(navigationCommand("$3", "pane-up"), "tmux select-pane -t '$3' -U");
  assert.equal(navigationCommand("$3", "window-previous"), "tmux select-window -t '$3' -p");
  assert.equal(navigationCommand("$3", "window-next"), "tmux select-window -t '$3' -n");
  assert.equal(navigationCommand("$3", "window-7"), "tmux select-window -t '$3:7'");
  assert.equal(navigationCommand("it's", "window-next"), "tmux select-window -t 'it'\\''s' -n");
  assert.equal(navigationCommand("$3", "editor"), undefined);
  assert.equal(navigationCommand("$3", "window-10"), undefined);
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
  nav.send("window-next");
  nav.send("pane-left");
  await tick();
  const [child] = ssh.children;
  assert.equal(child.written, "");
  child.reply(READY_MARKER);
  await tick();
  assert.deepEqual(commands(child), ["tmux select-window -t '$3' -n", "tmux select-pane -t '$3' -L"]);
  assert.match(child.written, new RegExp(`; echo "${STATUS_MARKER} \\$\\?"\\n$`));
  nav.send("window-2");
  await tick();
  assert.equal(commands(child).at(-1), "tmux select-window -t '$3:2'");
  assert.equal(ssh.children.length, 1, "one channel serves every key");
});

test("drain waits for confirmation of every sent command", async () => {
  const ssh = fakeSsh();
  const nav = channel(ssh);
  nav.start();
  const [child] = ssh.children;
  child.reply(READY_MARKER);
  await tick();
  nav.send("window-next");
  nav.send("window-next");
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

test("reports failed commands without resending them", async () => {
  const ssh = fakeSsh();
  const failures = [];
  const nav = channel(ssh, { onFailure: (action) => failures.push(action) });
  nav.send("pane-up");
  nav.send("window-9");
  const [child] = ssh.children;
  child.reply(READY_MARKER);
  child.reply(`${STATUS_MARKER} 1`);
  await tick();
  assert.deepEqual(failures, ["pane-up"]);
  child.exit(); // window-9 was sent but never confirmed.
  await tick();
  assert.deepEqual(failures, ["pane-up", "window-9"]);
  nav.send("window-next");
  assert.equal(ssh.children.length, 2, "the next key opens a new channel");
  assert.equal(ssh.children[1].written, "");
});

test("hands back queued keys when the channel exits before it is ready", async () => {
  const ssh = fakeSsh();
  const fallbacks = [];
  const nav = channel(ssh, { onFallback: (actions) => fallbacks.push(actions) });
  nav.send("window-next");
  nav.send("pane-down");
  ssh.children[0].exit();
  await tick();
  assert.deepEqual(fallbacks, [["window-next", "pane-down"]]);
  assert.equal(ssh.children[0].written, "");
});

test("drain returns unsent keys instead of calling the fallback", async () => {
  const ssh = fakeSsh();
  const fallbacks = [];
  const nav = channel(ssh, { onFallback: (actions) => fallbacks.push(actions) });
  nav.send("window-previous");
  const result = nav.drain();
  ssh.children[0].exit();
  assert.deepEqual(await result, ["window-previous"]);
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
