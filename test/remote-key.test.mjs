import assert from "node:assert/strict";
import test from "node:test";
import { remoteKey } from "../bin/remote-key.mjs";

test("maps plain and modified terminal keypresses to tmux key names", () => {
  for (const [input, expected] of [
    ["[", "["], ["]", "]"], ["c", "c"], ["V", "V"], [" ", "Space"],
    ["\x01", "C-a"], ["\x1b[110;5u", "C-n"], ["\x1b[118;5u", "C-v"],
    ["\x1b[91;5u", "C-["], ["\x1b[110;6u", "C-N"],
    ["\x1b[1;3D", "M-Left"], ["\x1b[5~", "PageUp"], ["\x1b[6~", "PageDown"],
    ["\x1b[Z", "BTab"], ["\x1b[13;2u", "S-Enter"], ["\r", "Enter"],
    ["\x1b[59;2u", ":"], ["\x1b[91:123;2u", "{"], ["\x1b[49;2u", "!"],
    ["\x7f", "BSpace"], ["\x1bOP", "F1"],
  ]) {
    assert.equal(remoteKey(input), expected, JSON.stringify(input));
  }
});

test("does not treat a paste, unknown event, or Super key as a tmux key", () => {
  assert.equal(remoteKey("\x1b[200~hello\x1b[201~"), undefined);
  assert.equal(remoteKey("hello"), undefined);
  assert.equal(remoteKey("\x1b[113;9u"), undefined);
});
