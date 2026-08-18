import { hostname } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "pi-tmux-remote-control";
const HOST_OPTION = "@pi_prompt_host";
const MARK_OPTION = "@pi_prompt";

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

async function paneOption(pi: ExtensionAPI, pane: string, option: string): Promise<string | undefined> {
  const result = await pi.exec("tmux", ["show-options", "-p", "-v", "-t", pane, option]);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

async function setPaneOption(pi: ExtensionAPI, pane: string, option: string, value: string): Promise<void> {
  const result = await pi.exec("tmux", ["set-option", "-p", "-t", pane, option, value]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not set tmux option ${option}`);
}

async function activeClientForPane(pi: ExtensionAPI, pane: string): Promise<string | undefined> {
  const sessionResult = await pi.exec("tmux", [
    "display-message",
    "-p",
    "-t",
    pane,
    "#{session_name}",
  ]);
  if (sessionResult.code !== 0) return undefined;
  const session = sessionResult.stdout.trim();

  const clientsResult = await pi.exec("tmux", [
    "list-clients",
    "-F",
    "#{client_name}|#{client_session}|#{client_activity}",
  ]);
  if (clientsResult.code !== 0) return undefined;

  return clientsResult.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [name = "", clientSession = "", activity = "0"] = line.split("|");
      return { name, session: clientSession, activity: Number(activity) || 0 };
    })
    .filter((client) => client.name && client.session === session)
    .sort((left, right) => right.activity - left.activity)[0]?.name;
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
    description: "Copy a local pi-prompt command for this remote tmux pane: /remote-control [ssh-host]",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/remote-control must run in the remote interactive Pi TUI.", "error");
        return;
      }

      const pane = process.env.TMUX_PANE;
      if (!pane || !/^%[0-9]+$/.test(pane)) {
        ctx.ui.notify("/remote-control requires Pi to be running inside tmux.", "error");
        return;
      }

      const requestedHost = args.trim();
      if (requestedHost && !validHost(requestedHost)) {
        ctx.ui.notify("The SSH host must be a host name or SSH config alias without whitespace.", "error");
        return;
      }

      try {
        if (requestedHost) await setPaneOption(pi, pane, HOST_OPTION, requestedHost);
        await setPaneOption(pi, pane, MARK_OPTION, "1");

        const rememberedHost = await paneOption(pi, pane, HOST_OPTION);
        const host = requestedHost || rememberedHost || process.env.PI_REMOTE_CONTROL_HOST || hostname();
        if (!validHost(host)) throw new Error(`Could not determine a valid SSH host: ${host}`);

        const command = `pi-prompt --host ${shellQuote(host)} --target ${shellQuote(pane)} --loop`;
        await setPaneOption(pi, pane, "@pi_prompt_command", command);

        const targetClient = await activeClientForPane(pi, pane);
        const copyArgs = ["set-buffer", "-w"];
        if (targetClient) copyArgs.push("-t", targetClient);
        copyArgs.push(command);
        const copyResult = await pi.exec("tmux", copyArgs);
        const copied = copyResult.code === 0;

        pi.appendEntry(ENTRY_TYPE, { command, copied } satisfies CommandEntry);
        if (copied) {
          ctx.ui.notify(
            `Copied the local control command for tmux pane ${pane}. Paste it into a local terminal.`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `Could not copy through tmux/OSC 52: ${copyResult.stderr.trim() || "unknown error"}. Copy the displayed command manually.`,
            "warning",
          );
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
