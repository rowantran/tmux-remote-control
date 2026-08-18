import assert from "node:assert/strict";
import { resolveTmuxPane } from "../extensions/remote-control.ts";

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

console.log("remote-control tests passed");
