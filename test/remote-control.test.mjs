import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGlobalHost,
  resolveTmuxContext,
  resolveTmuxPane,
  saveGlobalHost,
} from "../extensions/remote-control.ts";

function fakePi(responses) {
  const calls = [];
  return {
    calls,
    pi: {
      async exec(command, args) {
        calls.push([command, args]);
        const response = responses.shift();
        assert.ok(response, `unexpected exec call: ${command} ${args.join(" ")}`);
        return { code: 0, stdout: "", stderr: "", ...response };
      },
    },
  };
}

{
  const originalTmux = process.env.TMUX;
  process.env.TMUX = "/tmp/tmux-501/custom,123,0";
  try {
    const { pi, calls } = fakePi([]);
    assert.equal(await resolveTmuxPane(pi, "%17", 123), "%17");
    assert.deepEqual(await resolveTmuxContext(pi, "%17", 123), {
      pane: "%17",
      socket: "/tmp/tmux-501/custom",
    });
    assert.deepEqual(calls, []);
  } finally {
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  }
}

{
  const { pi, calls } = fakePi([
    { stdout: "pts/9\n" },
    { stdout: "%3|/dev/pts/4\n%12|/dev/pts/9\n" },
  ]);
  assert.equal(await resolveTmuxPane(pi, undefined, 456), "%12");
  assert.deepEqual(calls, [
    ["ps", ["-o", "tty=", "-p", "456"]],
    ["tmux", ["list-panes", "-a", "-F", "#{pane_id}|#{pane_tty}"]],
  ]);
}

{
  const { pi } = fakePi([
    { stdout: "?\n" },
  ]);
  assert.equal(await resolveTmuxPane(pi, undefined, 789), undefined);
}

{
  const root = await mkdtemp(join(tmpdir(), "pi-tmux-sockets-test-"));
  const socket = join(root, `tmux-${process.getuid()}`, "custom");
  const originalTmpdir = process.env.TMPDIR;
  try {
    await mkdir(join(root, `tmux-${process.getuid()}`));
    await writeFile(socket, "");
    process.env.TMPDIR = root;
    const { pi, calls } = fakePi([
      { stdout: "pts/11\n" },
      { code: 1, stderr: "no default server" },
      { stdout: "%8|/dev/pts/11\n" },
    ]);
    assert.deepEqual(await resolveTmuxContext(pi, undefined, 321), { pane: "%8", socket });
    assert.deepEqual(calls[2], [
      "tmux",
      ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}|#{pane_tty}"],
    ]);
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(root, { recursive: true, force: true });
  }
}

{
  const agentDir = await mkdtemp(join(tmpdir(), "pi-remote-control-test-"));
  try {
    assert.equal(await loadGlobalHost(agentDir), undefined);
    await saveGlobalHost("devbox", agentDir);
    assert.equal(await loadGlobalHost(agentDir), "devbox");
    assert.deepEqual(
      JSON.parse(await readFile(join(agentDir, "pi-tmux-remote-control.json"), "utf8")),
      { host: "devbox" },
    );
    await assert.rejects(saveGlobalHost("bad host", agentDir), /Invalid SSH host/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

console.log("remote-control tests passed");
