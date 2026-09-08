#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { getHistoryDirectory, loadHistory, markSubmission, recordSubmission } from "./history-store.mjs";

const [action, ...args] = process.argv.slice(2);

try {
  if (action === "prepare") {
    const [draftPath, trim] = args;
    let content = readFileSync(draftPath);
    if (trim === "true" && content.at(-1) === 10) {
      content = content.subarray(0, -1);
      if (content.at(-1) === 13) content = content.subarray(0, -1);
    }
    writeFileSync(draftPath, content);
  } else if (action === "record") {
    if (process.env.TMUX_REMOTE_CONTROL_HISTORY !== "0") {
      const [draftPath, host, session] = args;
      const entry = recordSubmission(getHistoryDirectory(), { text: readFileSync(draftPath, "utf8"), host, session });
      if (entry) process.stdout.write(entry.id);
    }
  } else if (action === "mark") {
    const [id] = args;
    if (id) markSubmission(getHistoryDirectory(), id, "sent");
  } else if (action === "pick") {
    const [draftPath, statePath, host, session] = args;
    const entries = process.env.TMUX_REMOTE_CONTROL_HISTORY === "0" ? [] : loadHistory(getHistoryDirectory());
    const { pickHistory } = await import("./history-picker.mjs");
    const entry = await pickHistory(entries, { host, session });
    if (entry) {
      const draft = readFileSync(draftPath, "utf8");
      writeFileSync(draftPath, entry.text);
      writeFileSync(statePath, JSON.stringify({ selectedId: entry.id, draft }));
    }
  } else {
    throw new Error(`unknown history action: ${action}`);
  }
} catch (error) {
  process.stderr.write(`tmux-remote-control: history ${action} failed: ${error.message}\n`);
  process.exitCode = 1;
}
