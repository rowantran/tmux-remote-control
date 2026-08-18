import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGlobalHost,
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
  const { pi, calls } = fakePi([]);
  assert.equal(await resolveTmuxPane(pi, "%17", 123), "%17");
  assert.deepEqual(calls, []);
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
