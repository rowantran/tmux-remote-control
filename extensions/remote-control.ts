import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "pi-tmux-remote-control";
const LEGACY_PANE_HOST_OPTION = "@pi_prompt_host";
const MARK_OPTION = "@pi_prompt";
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

function normalizedTty(value: string): string | undefined {
  const tty = value.trim().replace(/^\/dev\//, "");
  return tty && tty !== "?" && tty !== "??" ? tty : undefined;
}

/** Resolve the current tmux pane even when a launcher such as Isara scrubs TMUX_PANE. */
export async function resolveTmuxPane(
  pi: ExtensionAPI,
  envPane = process.env.TMUX_PANE,
  pid = process.pid,
): Promise<string | undefined> {
  if (envPane && /^%[0-9]+$/.test(envPane)) return envPane;

  const psResult = await pi.exec("ps", ["-o", "tty=", "-p", String(pid)]);
  const processTty = psResult.code === 0 ? normalizedTty(psResult.stdout) : undefined;
  if (!processTty) return undefined;

  // With TMUX unset, this queries the user's default tmux server. That is the
  // normal server used by `tmux new-session`, including sessions launching Isara.
  const panesResult = await pi.exec("tmux", [
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}|#{pane_tty}",
  ]);
  if (panesResult.code !== 0) return undefined;

  const matches = panesResult.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("|");
      if (separator === -1) return undefined;
      return {
        pane: line.slice(0, separator),
        tty: normalizedTty(line.slice(separator + 1)),
      };
    })
    .filter(
      (candidate): candidate is { pane: string; tty: string } =>
        candidate !== undefined && /^%[0-9]+$/.test(candidate.pane) && candidate.tty !== undefined,
    )
    .filter((candidate) => candidate.tty === processTty);

  return matches.length === 1 ? matches[0]?.pane : undefined;
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
    description: "Copy a pi-prompt command; an optional SSH host is remembered globally",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/remote-control must run in the remote interactive Pi TUI.", "error");
        return;
      }

      const pane = await resolveTmuxPane(pi);
      if (!pane) {
        ctx.ui.notify(
          "/remote-control could not identify Pi's tmux pane. Pi must run in a pane on the default tmux server.",
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
        await setPaneOption(pi, pane, MARK_OPTION, "1");

        const globalHost = await loadGlobalHost();
        const legacyPaneHost = globalHost
          ? undefined
          : await paneOption(pi, pane, LEGACY_PANE_HOST_OPTION);
        const host =
          requestedHost ||
          globalHost ||
          legacyPaneHost ||
          process.env.PI_REMOTE_CONTROL_HOST ||
          hostname();
        if (!validHost(host)) throw new Error(`Could not determine a valid SSH host: ${host}`);

        // An explicit argument updates the global value. Also migrate the old
        // pane-scoped value (or another fallback) the first time this version runs.
        const savedGlobalHost = Boolean(requestedHost) || !globalHost;
        if (savedGlobalHost) await saveGlobalHost(host);

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
            `Copied the local control command for tmux pane ${pane}.${savedGlobalHost ? ` Remembered ${host} globally.` : ""} Paste it into a local terminal.`,
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
