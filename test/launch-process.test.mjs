import assert from "node:assert/strict";
import { test } from "node:test";
import { runProcess } from "../bin/launch-process.mjs";

test("launch process captures bounded output and preserves exit codes", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('hello'); process.exit(7)"]);
  assert.deepEqual(result, { code: 7, stdout: "hello" });
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"]), /too much output/);
});

test("launch process can override the child environment without changing the parent", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write(process.env.TERM)"], { env: { TERM: "fixture-term" } });
  assert.equal(result.stdout, "fixture-term");
  assert.notEqual(process.env.TERM, "fixture-term");
});

test("launch process reports missing executables and timeouts", async () => {
  await assert.rejects(runProcess("/does-not-exist/tmux-remote-control", []), /ENOENT/);
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 }), /timed out/);
});

test("launch process cancellation terminates children and rejects pre-cancelled launches", async () => {
  const controller = new AbortController();
  const result = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, /cancelled/);
  await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(0)"], { signal: controller.signal }), /cancelled/);
});
