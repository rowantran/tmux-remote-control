import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGlobalHost,
  resolveTmuxPane,
  saveGlobalHost,
} from "../extensions/remote-control.ts";

assert.equal(resolveTmuxPane("%17"), "%17");
assert.equal(resolveTmuxPane(undefined), undefined);
assert.equal(resolveTmuxPane("17"), undefined);
assert.equal(resolveTmuxPane("%1; display-message bad"), undefined);

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
