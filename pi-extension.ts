import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SHORTCUT = "ctrl+shift+r";
type CustomEditorArguments = ConstructorParameters<typeof CustomEditor>;

class RemoteControlEditor extends CustomEditor {
	constructor(
		tui: CustomEditorArguments[0],
		theme: CustomEditorArguments[1],
		keybindings: CustomEditorArguments[2],
		private readonly colorBorder: (hasText: boolean, text: string) => string,
	) {
		super(tui, theme, keybindings);
	}

	render(width: number): string[] {
		if (width <= 0) return [""];
		const hasText = this.getText() !== "";
		const color = (text: string) => this.colorBorder(hasText, text);

		// Let Pi handle text layout, cursor, scroll indicators, and autocomplete.
		// Color its borders during this render only; Pi may update borderColor
		// when the thinking level or bash mode changes.
		const previousBorderColor = this.borderColor;
		let lines: string[];
		try {
			this.borderColor = color;
			lines = super.render(width);
		} finally {
			this.borderColor = previousBorderColor;
		}

		const prefix = truncateToWidth(hasText ? "📡 ── text entered " : "📡 ", width, "");
		const remaining = width - visibleWidth(prefix);
		// Keep the start of Pi's top border so its scroll-up count stays visible.
		const rule = truncateToWidth(lines[0], remaining, "");
		// Anchor IME/hardware cursor positioning to the collapsed row, without
		// drawing a fake text cursor. Expanded text keeps Pi's original cursor.
		const marker = !hasText && this.focused ? CURSOR_MARKER : "";
		lines[0] = remaining > 0 ? color(prefix) + marker + rule : marker + color(prefix);

		// An empty editor has a top border, one input row, and a bottom border.
		// Remove the latter two, but keep any autocomplete rows below them.
		// All decoration is display-only, never editable or submitted text.
		return hasText ? lines : [lines[0], ...lines.slice(3)];
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
					(hasText, text) => ctx.ui.theme.fg(hasText ? "warning" : "accent", text),
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
