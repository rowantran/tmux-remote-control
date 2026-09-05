import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SHORTCUT = "ctrl+shift+r";
type CustomEditorArguments = ConstructorParameters<typeof CustomEditor>;

class RemoteControlEditor extends CustomEditor {
	constructor(
		tui: CustomEditorArguments[0],
		theme: CustomEditorArguments[1],
		keybindings: CustomEditorArguments[2],
		private readonly statusText: () => string,
	) {
		super(tui, theme, keybindings);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (this.getText() !== "" || lines.length < 3) return lines;

		// Decorate only the empty input row. Keep the normal borders, padding,
		// and cursor; never put the placeholder into the editable/submitted text.
		const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
		const available = width - padding * 2 - 1;
		if (available <= 0) return lines;
		const placeholder = truncateToWidth(this.statusText(), available, "");
		const cursor = sliceByColumn(lines[1], 0, padding + 1);
		lines[1] = cursor + "\x1b[0m" + placeholder + " ".repeat(width - padding - 1 - visibleWidth(placeholder));
		return lines;
	}
}

export default function tmuxRemoteControl(pi: ExtensionAPI): void {
	let active = false;
	let changing = false;
	let previousEditor: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

	function disable(ctx: ExtensionContext): void {
		ctx.ui.setEditorComponent(previousEditor);
		previousEditor = undefined;
		active = false;
		ctx.ui.notify("Remote input disabled. The local controller can stay open.", "info");
	}

	async function enable(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Remote input requires Pi's interactive TUI mode.", "error");
			return;
		}

		const result = await pi.exec("tmux-remote-control", ["--print-controller-command"], { timeout: 5_000 });
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			ctx.ui.notify(`Could not start remote input: ${detail}`, "error");
			return;
		}

		const controllerCommand = result.stdout.trim();
		if (!controllerCommand || /[\x00-\x1f\x7f]/.test(controllerCommand)) {
			ctx.ui.notify("Could not start remote input: launcher returned an invalid controller command", "error");
			return;
		}

		// Raw OSC 52 output is handled by tmux when set-clipboard is on. This
		// copies through the pane without giving the sandbox access to tmux's
		// Unix socket. Pi's own notification extension uses the same direct
		// terminal-output pattern for non-rendering OSC sequences.
		const encodedCommand = Buffer.from(controllerCommand, "utf8").toString("base64");
		process.stdout.write(`\x1b]52;c;${encodedCommand}\x07`);

		previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new RemoteControlEditor(
					tui,
					theme,
					keybindings,
					() => ctx.ui.theme.fg("dim", "📡 remote control active"),
				),
		);
		active = true;

		ctx.ui.notify(`Copied the local controller command:\n${controllerCommand}`, "info");
	}

	async function toggle(ctx: ExtensionContext): Promise<void> {
		if (changing) return;
		changing = true;
		try {
			if (active) disable(ctx);
			else await enable(ctx);
		} finally {
			changing = false;
		}
	}

	pi.registerShortcut(SHORTCUT, {
		description: "Toggle tmux remote input and copy the local controller command",
		handler: toggle,
	});

	pi.registerCommand("remote-control", {
		description: "Toggle tmux remote input and copy the local controller command",
		handler: async (_args, ctx) => toggle(ctx),
	});
}
