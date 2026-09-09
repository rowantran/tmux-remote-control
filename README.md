# tmux-remote-control

Compose input on a local device with no network typing latency, then send each completed input to the focused pane of a tmux session on a remote machine.

`tmux-remote-control` is independent of the program running in the pane. It can control shells, editors, REPLs, terminal applications, or coding agents.

## Workflow

There are two command modes.

### 1. Copy a controller command from the remote tmux session

Run the basic command inside the remote tmux pane:

```bash
tmux-remote-control devbox
```

`devbox` is the SSH host or local SSH config alias that the local device uses to reach this machine. If the machine's short hostname is directly usable over SSH, you can omit it:

```bash
tmux-remote-control
```

The command gets the current session from `TMUX_PANE` and copies a command such as this to the local clipboard:

```bash
tmux-remote-control attach devbox work
```

It also prints the command as a fallback.

### 2. Attach the local controller

Paste the copied command into a terminal on the local device:

```bash
tmux-remote-control attach devbox work
```

The local controller remains open until you press `Ctrl-D`. Before each submission, it snapshots the active pane in the remote session's current window. You can switch panes and windows between submissions while keeping one local controller open.

```text
attached keyboard ──────────┐
                            ├─> focused tmux pane PTY ─> application stdin
remote-control submission ──┘
```

The paste and Enter key use the same pane snapshot, so a focus change during submission cannot split one input across two panes.

## Requirements

Local device:

- Bash
- OpenSSH
- Node.js 22.19 or newer for the inline prompt and editor submission handling
- `fzf` is optional and provides fuzzy message-history search and the session selector when several sessions exist

Remote machine:

- Bash
- tmux
- `tmux-remote-control` for generating the controller command
- SSH access from the local device

Development and verification also require npm and Python 3.

## Install

Install or link the same executable on both machines:

```bash
npm run verify
mkdir -p ~/bin
ln -sfn "$PWD/bin/tmux-remote-control" ~/bin/tmux-remote-control
```

Ensure `~/bin` is in `PATH`.

### Pi integration

Copy the included Pi extension into the global extension directory, then reload Pi:

```bash
./install-pi-extension.sh
```

Run the installer again after updating this repository. It replaces the installed copy, including an older symlink installation, and removes the obsolete directory-based RPC extension entry if present.

Run `/reload` in an existing Pi process, or start a new one. Inside a remote tmux session, press `Ctrl+Shift+R`. The extension:

1. Builds the local `tmux-remote-control attach ...` command from `TMUX_PANE` and copies it with OSC 52, without opening the tmux server socket.
2. Collapses the empty editor to a single `📡 ─────` line in the theme's accent color (cyan/teal in the default dark theme).
3. Expands the editor as soon as any text is entered, including spaces or newlines. The borders use the theme's warning color (amber/yellow), and the top border says `text entered` to make accidental input noticeable.
4. Collapses back to one line when the editor is cleared or a message is submitted. The indicator is display-only; it is never included in submitted text.

Empty:

```text
📡 ───────────────────────────────────────────
```

Text entered:

```text
📡 ── text entered ────────────────────────────
oops, I typed into the remote session
──────────────────────────────────────────────
```

Multiline input keeps Pi's normal wrapping, scrolling, and cursor. Autocomplete suggestions still appear below the editor when open.

Both direct typing and tmux paste-and-Enter submissions continue to use Pi's normal input path. Any text entered directly in the remote pane stays visible.

Paste the copied command into a local terminal. Press `Ctrl+Shift+R` again, or run `/remote-control`, to restore Pi's normal editor. The local controller stays open and works after either mode change. Because the extension does not open the tmux socket, it also works when Pi runs in a sandbox that forwards `TMUX_PANE` but blocks local Unix sockets, such as `isara pi run`.

Pi selectors and dialogs, such as `/tree` and extension questionnaires, temporarily take keyboard focus instead of the editor. Do not submit a local controller message while one is open. Interact with it in the remote tmux pane. When it closes, focus returns to the editor. You can then continue from the same local controller or press `Ctrl+Shift+R` to restore the normal editor.

## Clipboard setup

The normal remote launcher uses `tmux load-buffer -w` to set the tmux buffer and send it to the terminal clipboard through OSC 52. The Pi extension emits OSC 52 directly from its pane, which tmux handles when `set-clipboard` is `on`.

On the remote machine, add this to `~/.tmux.conf`:

```tmux
set -g set-clipboard on
```

Apply it to a running tmux server:

```bash
tmux set-option -g set-clipboard on
```

The local terminal must support OSC 52 clipboard writes. Ghostty, Kitty, iTerm2, and WezTerm support them. If another local tmux instance sits between SSH and the terminal, configure `set-clipboard on` there too.

If clipboard copying is unavailable, the launcher still prints the complete controller command for manual copying.

## Attach options

Follow a session directly without first running the remote launcher:

```bash
tmux-remote-control attach devbox work
```

A tmux session id or any pane in the session can identify the session:

```bash
tmux-remote-control attach devbox '$3'
tmux-remote-control attach devbox --session %12
```

A pane supplied through `--session` is only used to locate its containing session during startup. The controller keeps the stable tmux session id afterward, so the original pane can close.

Select from the sessions on the remote host:

```bash
tmux-remote-control attach devbox
```

List remote sessions:

```bash
tmux-remote-control attach devbox --list
```

Keep all submissions pinned to one pane instead of following focus:

```bash
tmux-remote-control attach devbox --target %12
```

Exit after one submission:

```bash
tmux-remote-control attach devbox work --once
```

## Local input

Attach mode clears the current terminal screen and docks the remote target and inline prompt at the bottom. The prompt uses Pi's `@earendil-works/pi-tui` editor component, including multiline editing, wrapping, and scrolling. Gruvbox colors distinguish the host and session; the borders and prompt arrow use the terminal's default foreground color:

```text
📡  Controlling: devbox → work
─────────────────────────────
› type here
─────────────────────────────
```

When text extends beyond the visible rows, the borders preserve Pi's `↑ N more` and `↓ N more` labels for hidden rows above and below. Counts include wrapped rows and update as you move the cursor or resize the terminal.

Controls:

- `Enter`: submit the current message
- `Shift-Enter`: insert a newline
- `Up` / `Down`: recall older/newer messages at the first/last text line; moving past the newest entry restores the original draft
- `Esc`: open searchable message history when the prompt is empty
- `Alt-Left` / `Alt-Right` or `Ctrl-Left` / `Ctrl-Right`: move by one word
- `Alt-Backspace` or `Ctrl-W`: delete the previous word
- `Alt-Delete` or `Alt-D`: delete the next word
- `Ctrl-A` / `Ctrl-E`: move to the start or end of the line
- `Ctrl-U`: delete to the start of the line
- `Ctrl-Y` / `Alt-Y`: paste or cycle through deleted text
- `Ctrl--`: undo
- `Ctrl-G`: open the current draft in an external editor, then return the saved text to the input box without submitting
- `Ctrl-F`: toggle zoom for the focused pane
- `Ctrl-H`: select the pane below
- `Ctrl-J`: select the pane to the left
- `Ctrl-K`: select the pane to the right
- `Ctrl-L`: select the pane above
- `Ctrl-P` / `Ctrl-N`: select the previous or next window
- `Ctrl-0` through `Ctrl-9`: select a window by index
- `Ctrl-C`: discard the current draft and show a clean prompt
- `Ctrl-D`: close the controller, even when the current draft is not empty

The controller shortcuts take precedence when they overlap a standard editing key. Pane and window shortcuts work when the controller follows a session. They keep the current draft at the prompt and use the same SSH control connection as submissions. Fixed-pane mode ignores them and rings the terminal bell because that mode stays pinned to one pane.

The Pi TUI library negotiates the terminal keyboard protocol and normalizes legacy and extended key sequences. Distinct sequences are necessary because traditional terminal input cannot tell some `Ctrl-number` keys apart from other control keys. Unsupported terminals can still use the pane shortcuts except `Ctrl-J`, plus `Ctrl-P` and `Ctrl-N`.

Pressing Enter on an empty prompt shows another prompt. After saving and exiting the external editor, review or edit the draft in the input box, then press Enter to send it. Exiting the editor does not send or record a message in history. The controller removes exactly one final LF or CRLF when the editor returns, not when sending. Other whitespace and newlines stay intact until you edit the draft inline; intentional newlines you add afterward are preserved.

Use `--editor` to start each message in the external editor. It also returns to the input box for confirmation. Add `--once` to exit after one explicitly submitted message, or press `Ctrl-D` to exit without sending.

The editor is selected from the first configured value:

1. `TMUX_REMOTE_CONTROL_EDITOR`
2. `VISUAL`
3. `EDITOR`
4. `vi`

Examples:

```bash
TMUX_REMOTE_CONTROL_EDITOR=nvim tmux-remote-control attach devbox work
TMUX_REMOTE_CONTROL_EDITOR='code --wait' tmux-remote-control attach devbox work
tmux-remote-control attach devbox work --editor --once
```

### Automatic AeroSpace window sizing (macOS)

When the local controller runs in the **bottom window of exactly two vertically tiled windows on a visible AeroSpace workspace**, it sizes that window automatically. The controller must occupy a standalone Ghostty window with exactly one tab and one terminal:

- **Inline prompt:** approximately 8 terminal rows, including the status and borders.
- **External editor (`Ctrl-G` or `--editor`) or searchable history (`Esc`):** half the two windows' combined height, preserving AeroSpace's gaps and margins.
- **Return to the prompt or exit the controller:** approximately 8 rows again.

The first compact resize may use several small steps to measure the terminal's row height. Once verified, the controller remembers that window height for the current attach and restores it in one resize. Normal transitions check only the controller's Ghostty window, not every window in the app. If the measured rows, window size, or display geometry change, the controller measures again instead of using a stale height.

This requires AeroSpace installed and running, its `aerospace` CLI on the controller's `PATH`, and the usual macOS Accessibility permission for AeroSpace. It also requires Ghostty 1.3 or newer with AppleScript enabled (the default). Allow macOS Automation access to Ghostty if prompted. Ghostty AppleScript only reads metadata to identify the terminal and check that its window has no other tabs or splits. All resizing uses [AeroSpace's `resize --window-id` command](https://nikitabobko.github.io/AeroSpace/commands#resize), so focus changes do not redirect it. The upper window can belong to any app.

Sizing changes the local tiled windows, not the remote tmux layout. Floating or fullscreen windows, accordion layouts, horizontal tiling, top windows, hidden workspaces, and workspaces with fewer or more than two windows are not managed. Ghostty native splits and multiple tabs are excluded. Automatic sizing also requires a local macOS Ghostty TTY and is disabled inside local tmux, screen, or SSH sessions. Window minimum sizes can prevent an exact 8-row height. There is no Ghostty split resizing or fallback.

If the CLI is missing, sizing is silently skipped. Unsupported layouts, denied permissions, and other sizing errors disable automatic sizing for the rest of that attach; input and draft confirmation still work. Restart the controller after fixing the layout or granting access. Returning from the editor or history picker never sends or records a message: press Enter at the input box to confirm it.

Disable sizing for one invocation:

```bash
TMUX_REMOTE_CONTROL_AEROSPACE_RESIZE=0 tmux-remote-control attach devbox work
```

Or export `TMUX_REMOTE_CONTROL_AEROSPACE_RESIZE=0` in your shell configuration to disable it by default. This replaces the former `TMUX_REMOTE_CONTROL_GHOSTTY_RESIZE` setting.

## Message history

History restores message text into the local prompt. **It never sends a message or changes the remote destination by itself.** After recall, you can edit the message, switch to the correct pane with the usual shortcuts, and press Enter to send it.

### Quick recall

Press `Up` at an empty prompt to restore the latest message. Keep pressing `Up` to browse older messages; `Down` moves toward newer ones, then restores your original draft. For multiline text, arrows move within the message before browsing past its first or last text line.

The prompt borders show only scroll counts when needed during recall. Timestamps and send status appear only in the history picker:

```text
📡  Controlling: devbox → work
─────────────────────────────────────────────
› review the authentication changes
─────────────────────────────────────────────
```

Arrow history covers the current SSH host and tmux session, across all panes and windows. Editing a recalled entry does not change the saved message. Your original draft, history browse position, and edits to recalled messages survive external-editor returns and pane/window shortcuts. `Ctrl-C` clears the draft and leaves history browsing.

### Searchable history

Press `Esc` once on an empty prompt to open history. Spaces and newlines count as text, so this shortcut cannot replace a nonempty draft. Inside the picker, `Esc` closes it.

- Type to fuzzy-search message text, host/session names, and timestamps.
- `Up` / `Down` selects a result.
- `Enter` restores the selected message into the prompt, **without sending**.
- `Esc` or `Ctrl-C` cancels.
- `Tab` toggles between the current host/session and all local controller history, keeping the search query.
- `Shift-Up` / `Shift-Down` scrolls the full message preview.
- `PageUp` / `PageDown` pages through the results.

The picker uses `fzf` when available and otherwise uses a built-in fuzzy selector. It ignores `FZF_DEFAULT_OPTS` and `FZF_DEFAULT_OPTS_FILE` so user settings cannot enable automatic acceptance or change the restore-only behavior. Controller navigation shortcuts do not send remote commands while the picker is open.

Multiline messages retain their full text. Recalling a message and sending it unchanged preserves its whitespace, including tabs and trailing newlines. Once you edit it inline, Pi's usual tab expansion and line-ending normalization apply. `Ctrl-G` opens the original recalled text in the external editor and returns the saved draft to the input box without submitting it.

### Local storage

History persists across controller restarts in:

```text
${XDG_STATE_HOME:-~/.local/state}/tmux-remote-control/history/
```

The controller keeps the latest 1,000 submissions in private JSON files (directory permissions `0700`, file permissions `0600`). Each entry contains message text, a timestamp, host/session names for filtering, and send status. **No original pane ID or pane location is saved.** History is local plaintext, not encrypted, and can contain sensitive message text. Remove this directory to clear saved history, or set `TMUX_REMOTE_CONTROL_HISTORY=0` to disable recording and recall.

Messages composed inline or in the external editor are saved to history only after you press Enter at the input box, before the SSH send. Failed or interrupted sends remain marked `send unconfirmed`; they are never retried automatically. An unconfirmed message may already have reached the remote application. Check there before resending. History cannot undo an earlier submission.

History uses the SSH alias and tmux session name as its scope. If either name changes, use the picker's all-history scope to find older messages. Fixed-pane controllers use the containing session's history too; recall does not change their pinned target.

## Environment

- `TMUX_REMOTE_CONTROL_HOST`: default SSH host for either mode
- `TMUX_REMOTE_CONTROL_SESSION`: default attach-mode session selector
- `TMUX_REMOTE_CONTROL_TARGET`: default attach-mode fixed pane target
- `TMUX_REMOTE_CONTROL_EDITOR`: attach-mode editor command
- `TMUX_REMOTE_CONTROL_TMPDIR`: local directory for prompt and discovery temporary files
- `TMUX_REMOTE_CONTROL_HISTORY`: set to `0` to disable message history (enabled by default)
- `TMUX_REMOTE_CONTROL_HISTORY_DIR`: override the local history directory
- `TMUX_REMOTE_CONTROL_HISTORY_PICKER`: `auto` (default), `fzf`, or `builtin`
- `TMUX_REMOTE_CONTROL_AEROSPACE_RESIZE`: set to `0` to disable automatic local AeroSpace window sizing (enabled by default for supported macOS Ghostty layouts)

Command-line host, session, and target arguments override environment defaults.

## Connection behavior

Attach mode establishes an SSH control connection during discovery. Every submission reuses it, which avoids repeated SSH key exchange and authentication. The private control socket uses a short directory under `/tmp` to stay below Unix-socket path limits on macOS. The control socket and temporary files are removed when the controller exits.

There is still at least one network round trip between pressing Enter and the remote application receiving the input. The local input row clears before that network operation starts, so local feedback remains immediate.

`tmux paste-buffer -p -r` uses bracketed paste when the target application has enabled it. Multiline editor input therefore arrives as one paste, followed by a separate Enter key.

The attached keyboard and remote controller can technically write at the same time. Avoid typing in the target application during the short submission operation.
