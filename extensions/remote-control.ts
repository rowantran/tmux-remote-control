import { mkdir, readFile, readdir, readlink, rename, writeFile } from "node:fs/promises";
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

export interface TmuxContext {
  pane: string;
  socket?: string;
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

function tmuxSocketFromEnvironment(value = process.env.TMUX): string | undefined {
  if (!value) return undefined;
  const socket = value.split(",", 1)[0]?.trim();
  return socket?.startsWith("/") ? socket : undefined;
}

function tmuxArgs(socket: string | undefined, args: string[]): string[] {
  return socket ? ["-S", socket, ...args] : args;
}

async function processTty(pi: ExtensionAPI, pid: number): Promise<string | undefined> {
  // Reading our own fd avoids relying on `ps`, which may report `?` from
  // inside a sandbox even though stdin is still the tmux pane PTY.
  if (pid === process.pid) {
    for (const fdPath of ["/proc/self/fd/0", "/dev/fd/0"]) {
      try {
        const tty = normalizedTty(await readlink(fdPath));
        if (tty?.startsWith("pts/") || tty?.startsWith("tty")) return tty;
      } catch {
        // Try the portable ps fallback below.
      }
    }
  }

  const psResult = await pi.exec("ps", ["-o", "tty=", "-p", String(pid)]);
  return psResult.code === 0 ? normalizedTty(psResult.stdout) : undefined;
}

async function discoverTmuxSockets(): Promise<string[]> {
  const getuid = process.getuid;
  if (!getuid) return [];

  const roots = new Set([process.env.TMPDIR, "/tmp"].filter((root): root is string => Boolean(root)));
  const sockets: string[] = [];
  for (const root of roots) {
    const directory = join(root, `tmux-${getuid()}`);
    try {
      for (const entry of await readdir(directory)) sockets.push(join(directory, entry));
    } catch {
      // This root has no tmux sockets or is unavailable inside the sandbox.
    }
  }
  return [...new Set(sockets)];
}

function matchingPane(stdout: string, tty: string): string | undefined {
  const matches = stdout
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
    .filter((candidate) => candidate.tty === tty);

  return matches.length === 1 ? matches[0]?.pane : undefined;
}

/** Resolve the current pane and server even when a launcher scrubs TMUX/TMUX_PANE. */
export async function resolveTmuxContext(
  pi: ExtensionAPI,
  envPane = process.env.TMUX_PANE,
  pid = process.pid,
): Promise<TmuxContext | undefined> {
  if (envPane && /^%[0-9]+$/.test(envPane)) {
    const socket = tmuxSocketFromEnvironment();
    return socket ? { pane: envPane, socket } : { pane: envPane };
  }

  const tty = await processTty(pi, pid);
  if (!tty) return undefined;

  const listArgs = ["list-panes", "-a", "-F", "#{pane_id}|#{pane_tty}"];
  const defaultResult = await pi.exec("tmux", listArgs);
  if (defaultResult.code === 0) {
    const pane = matchingPane(defaultResult.stdout, tty);
    if (pane) return { pane };
  }

  for (const socket of await discoverTmuxSockets()) {
    const result = await pi.exec("tmux", tmuxArgs(socket, listArgs));
    if (result.code !== 0) continue;
    const pane = matchingPane(result.stdout, tty);
    if (pane) return { pane, socket };
  }

  return undefined;
}

/** Backward-compatible pane-only resolver used by integrations and tests. */
export async function resolveTmuxPane(
  pi: ExtensionAPI,
  envPane = process.env.TMUX_PANE,
  pid = process.pid,
): Promise<string | undefined> {
  return (await resolveTmuxContext(pi, envPane, pid))?.pane;
}

async function paneOption(
  pi: ExtensionAPI,
  tmux: TmuxContext,
  option: string,
): Promise<string | undefined> {
  const result = await pi.exec(
    "tmux",
    tmuxArgs(tmux.socket, ["show-options", "-p", "-v", "-t", tmux.pane, option]),
  );
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

async function setPaneOption(
  pi: ExtensionAPI,
  tmux: TmuxContext,
  option: string,
  value: string,
): Promise<void> {
  const result = await pi.exec(
    "tmux",
    tmuxArgs(tmux.socket, ["set-option", "-p", "-t", tmux.pane, option, value]),
  );
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not set tmux option ${option}`);
}

async function activeClientForPane(pi: ExtensionAPI, tmux: TmuxContext): Promise<string | undefined> {
  const sessionResult = await pi.exec(
    "tmux",
    tmuxArgs(tmux.socket, ["display-message", "-p", "-t", tmux.pane, "#{session_name}"]),
  );
  if (sessionResult.code !== 0) return undefined;
  const session = sessionResult.stdout.trim();

  const clientsResult = await pi.exec(
    "tmux",
    tmuxArgs(tmux.socket, [
      "list-clients",
      "-F",
      "#{client_name}|#{client_session}|#{client_activity}",
    ]),
  );
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

      const tmux = await resolveTmuxContext(pi);
      if (!tmux) {
        ctx.ui.notify(
          "/remote-control could not access or match Pi's tmux pane. Under isara pi run, allow the exact tmux Unix socket in your security_profile.json; see the package README.",
          "error",
        );
        return;
      }
      const { pane } = tmux;

      const requestedHost = args.trim();
      if (requestedHost && !validHost(requestedHost)) {
        ctx.ui.notify("The SSH host must be a host name or SSH config alias without whitespace.", "error");
        return;
      }

      try {
        await setPaneOption(pi, tmux, MARK_OPTION, "1");

        const globalHost = await loadGlobalHost();
        const legacyPaneHost = globalHost
          ? undefined
          : await paneOption(pi, tmux, LEGACY_PANE_HOST_OPTION);
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
        await setPaneOption(pi, tmux, "@pi_prompt_command", command);

        const targetClient = await activeClientForPane(pi, tmux);
        const copyArgs = ["set-buffer", "-w"];
        if (targetClient) copyArgs.push("-t", targetClient);
        copyArgs.push(command);
        const copyResult = await pi.exec("tmux", tmuxArgs(tmux.socket, copyArgs));
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
