import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  copyToClipboard,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "pi-tmux-remote-control";
const CONFIG_FILENAME = "pi-tmux-remote-control.json";

interface CommandEntry {
  command: string;
  copied: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function validHost(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !/[\s\u0000-\u001f]/.test(value);
}

function configPath(agentDir: string): string {
  return join(agentDir, CONFIG_FILENAME);
}

export async function loadGlobalHost(agentDir = getAgentDir()): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(configPath(agentDir), "utf8")) as { host?: unknown };
    return typeof parsed.host === "string" && validHost(parsed.host) ? parsed.host : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Could not read global remote-control settings: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function saveGlobalHost(host: string, agentDir = getAgentDir()): Promise<void> {
  if (!validHost(host)) throw new Error(`Invalid SSH host: ${host}`);

  await mkdir(agentDir, { recursive: true });
  const path = configPath(agentDir);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ host }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    throw new Error(
      `Could not save global remote-control settings: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function resolveTmuxPane(envPane = process.env.TMUX_PANE): string | undefined {
  return envPane && /^%[0-9]+$/.test(envPane) ? envPane : undefined;
}

export default function remoteControlExtension(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as CommandEntry;
    const heading = data.copied
      ? "Remote-control command copied to local clipboard"
      : "Remote-control command (clipboard copy was unavailable)";
    return new Text(
      `${theme.fg(data.copied ? "success" : "warning", theme.bold(heading))}\n${theme.fg("accent", data.command)}`,
      1,
      1,
    );
  });

  pi.registerCommand("remote-control", {
    description: "Copy a pi-prompt command; an optional SSH host is remembered globally",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/remote-control must run in the remote interactive Pi TUI.", "error");
        return;
      }

      const pane = resolveTmuxPane();
      if (!pane) {
        ctx.ui.notify(
          "/remote-control needs TMUX_PANE. Launch with `isara pi run --forward-tmux` or set ISARA_PI_FORWARD_TMUX=1.",
          "error",
        );
        return;
      }

      const requestedHost = args.trim();
      if (requestedHost && !validHost(requestedHost)) {
        ctx.ui.notify("The SSH host must be a host name or SSH config alias without whitespace.", "error");
        return;
      }

      try {
        const globalHost = await loadGlobalHost();
        const host = requestedHost || globalHost || process.env.PI_REMOTE_CONTROL_HOST || hostname();
        if (!validHost(host)) throw new Error(`Could not determine a valid SSH host: ${host}`);

        const savedGlobalHost = Boolean(requestedHost) || !globalHost;
        if (savedGlobalHost) await saveGlobalHost(host);

        const command = `pi-prompt --host ${shellQuote(host)} --target ${shellQuote(pane)} --loop`;
        let copied = false;
        try {
          await copyToClipboard(command);
          copied = true;
        } catch {
          // The command remains visible in the transcript for manual copying.
        }

        pi.appendEntry(ENTRY_TYPE, { command, copied } satisfies CommandEntry);
        if (copied) {
          ctx.ui.notify(
            `Copied the local control command for tmux pane ${pane}.${savedGlobalHost ? ` Remembered ${host} globally.` : ""} Paste it into a local terminal.`,
            "info",
          );
        } else {
          ctx.ui.notify(
            "Could not copy through OSC 52. Copy the displayed command manually.",
            "warning",
          );
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
