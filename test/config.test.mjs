import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, loadConfig, piAutoEnable } from "../tmux-remote-control/config.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tmux-rc-config-"));
  const env = { HOME: root };
  const path = configPath(env);
  mkdirSync(join(root, ".config", "tmux-remote-control"), { recursive: true });
  return { root, env, path };
}

test("config uses XDG_CONFIG_HOME and otherwise falls back to HOME", () => {
  assert.equal(configPath({ HOME: "/home/me" }), "/home/me/.config/tmux-remote-control/config.json");
  assert.equal(configPath({ HOME: "/home/me", XDG_CONFIG_HOME: "/settings" }), "/settings/tmux-remote-control/config.json");
});

test("missing config keeps Pi auto-enable off", () => {
  const f = fixture();
  try {
    assert.deepEqual(loadConfig(f.env), {});
    assert.equal(piAutoEnable(loadConfig(f.env)), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Pi auto-enable requires an explicit true setting", () => {
  const f = fixture();
  try {
    for (const [value, expected] of [[true, true], [false, false], ["true", false], [1, false]]) {
      writeFileSync(f.path, JSON.stringify({ pi: { autoEnable: value } }));
      assert.equal(piAutoEnable(loadConfig(f.env)), expected);
    }
    writeFileSync(f.path, JSON.stringify({ autoEnable: true }));
    assert.equal(piAutoEnable(loadConfig(f.env)), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("malformed config reports its path", () => {
  const f = fixture();
  try {
    writeFileSync(f.path, "{");
    assert.throws(() => loadConfig(f.env), new RegExp(`could not parse ${f.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    writeFileSync(f.path, "[]");
    assert.throws(() => loadConfig(f.env), /must contain a JSON object/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
