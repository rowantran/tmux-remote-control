import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import rpc from "./lib/pi-remote.cjs";

const SHORTCUT = "ctrl+shift+r";
type CustomEditorArguments = ConstructorParameters<typeof CustomEditor>;
type Endpoint = { instanceId: string; close(): Promise<void> };

// Only these application actions are available while the main editor is locked.
// In particular, do not pass input to CustomEditor: that would permit typing,
// history recall, clipboard insertion, external editing, or queued submission.
const REMOTE_ACTIONS = [
	"app.tools.expand", "app.thinking.toggle", "app.message.copy",
	"app.model.select", "app.model.cycleForward", "app.model.cycleBackward",
	"app.thinking.cycle", "app.suspend", "app.session.tree", "app.session.resume",
] as const;

export class RemoteControlEditor extends CustomEditor {
	private pasting = false;

	constructor(
		tui: CustomEditorArguments[0],
		theme: CustomEditorArguments[1],
		private readonly remoteKeybindings: CustomEditorArguments[2],
		private readonly statusText: () => string,
	) {
		super(tui, theme, remoteKeybindings);
	}

	handleInput(data: string): void {
		// Ignore pasted content even when it contains a shortcut or arrives in chunks.
		if (this.pasting || data.includes("\x1b[200~")) {
			this.pasting = !data.includes("\x1b[201~");
			return;
		}
		if (matchesKey(data, SHORTCUT)) {
			this.onExtensionShortcut?.(data);
			return;
		}
		if (this.remoteKeybindings.matches(data, "app.interrupt")) {
			(this.onEscape ?? this.actionHandlers.get("app.interrupt"))?.();
			return;
		}
		for (const action of REMOTE_ACTIONS) {
			if (this.remoteKeybindings.matches(data, action)) {
				this.actionHandlers.get(action)?.();
				return;
			}
		}
	}

	render(width: number): string[] {
		return [truncateToWidth(this.statusText(), width)];
	}
}

export default function tmuxRemoteControl(pi: ExtensionAPI): void {
	let active = false;
	let changing = false;
	let stopped = false;
	let waitingForUI = false;
	let endpoint: Endpoint | undefined;
	let remoteEditor: RemoteControlEditor | undefined;
	let previousEditor: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

	async function disable(ctx: ExtensionContext, notify = true): Promise<void> {
		active = false; // Reject new requests before asynchronous cleanup.
		const closing = endpoint;
		endpoint = undefined;
		if (remoteEditor) {
			ctx.ui.setEditorComponent(previousEditor);
			remoteEditor = undefined;
			previousEditor = undefined;
		}
		await closing?.close();
		if (notify) ctx.ui.notify("Remote input disabled. The Pi controller will reject submissions until enabled again.", "info");
	}

	async function enable(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Remote input requires Pi's interactive TUI mode.", "error");
			return;
		}

		const identity = rpc.getIdentity();
		const transport = process.env.TMUX_REMOTE_CONTROL_RPC_TRANSPORT || "socket";
		if (transport !== "socket" && transport !== "files") throw new Error("RPC transport must be socket or files");
		if (transport === "files" && !process.env.TMUX_REMOTE_CONTROL_RPC_DIR) {
			throw new Error("Files transport requires TMUX_REMOTE_CONTROL_RPC_DIR, shared with the SSH host");
		}

		const result = await pi.exec("tmux-remote-control", ["--print-controller-command", "--pi"], { timeout: 5_000 });
		if (stopped) return;
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || `launcher exit code ${result.code}`);
		}
		const controllerCommand = result.stdout.trim();
		if (!controllerCommand || /[\x00-\x1f\x7f]/.test(controllerCommand)) {
			throw new Error("Launcher returned an invalid controller command");
		}

		const created: Endpoint = await rpc.startEndpoint({
			identity,
			runtimeDir: rpc.getRuntimeDir(),
			transport,
			sessionId: () => ctx.sessionManager.getSessionId(),
			onPrompt: ({ text, deliverAs, sessionId }: { text: string; deliverAs: "steer" | "followUp"; sessionId: string }) => {
				if (!active || stopped) throw new Error("Remote input is disabled");
				if (sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Pi session changed; submit again after checking the target");
				if (waitingForUI || !remoteEditor?.focused) {
					throw new Error("Pi has a dialog open. Close it in the remote pane before submitting a message");
				}
				const trimmed = text.trimStart();
				if (trimmed.startsWith("!")) throw new Error("Shell shortcuts require Pi's visible editor. Disable remote mode first");
				if (trimmed.startsWith("/")) {
					const command = trimmed.slice(1).split(/\s/, 1)[0];
					if (!pi.getCommands().some((entry) => entry.name === command)) {
						throw new Error(`/${command} is not a registered extension, skill, or template command. Use Pi's visible editor`);
					}
				}
				// This API returns void. The RPC acknowledgement means handed to Pi,
				// not model completion or acceptance by subsequent input hooks.
				pi.sendUserMessage(trimmed.startsWith("/") ? trimmed : text, { deliverAs, expandPromptTemplates: true });
			},
		});
		if (stopped) {
			await created.close();
			return;
		}
		endpoint = created;
		previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			remoteEditor = new RemoteControlEditor(tui, theme, keybindings,
				() => `📡  ${ctx.ui.theme.fg("dim", "remote input: typing locked · Ctrl+Shift+R to unlock")}`);
			return remoteEditor;
		});
		active = true;

		// Clipboard output travels through the pane; no tmux socket access needed.
		const encodedCommand = Buffer.from(controllerCommand, "utf8").toString("base64");
		process.stdout.write(`\x1b]52;c;${encodedCommand}\x07`);
		ctx.ui.notify(`Copied the local Pi controller command:\n${controllerCommand}`, "info");
	}

	async function toggle(ctx: ExtensionContext): Promise<void> {
		if (changing || stopped) return;
		changing = true;
		try {
			if (active) await disable(ctx);
			else await enable(ctx);
		} catch (error) {
			await disable(ctx, false);
			ctx.ui.notify(`Could not change remote input: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			changing = false;
		}
	}

	pi.on("ui_prompt_start", () => { waitingForUI = true; });
	pi.on("ui_prompt_end", () => { waitingForUI = false; });
	pi.on("session_shutdown", async (_event, ctx) => {
		stopped = true;
		await disable(ctx, false);
	});
	pi.registerShortcut(SHORTCUT, {
		description: "Toggle direct Pi remote input and copy the controller command",
		handler: toggle,
	});
	pi.registerCommand("remote-control", {
		description: "Toggle direct Pi remote input and copy the controller command",
		handler: async (_args, ctx) => toggle(ctx),
	});
}
