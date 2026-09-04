# tmux-remote-control

Compose input on a local device with no network typing latency, then send each completed input to the focused pane of a tmux session on a remote machine.

By default, `tmux-remote-control` pastes into the terminal and can control shells, editors, REPLs, terminal applications, or coding agents. Its optional **Pi mode** sends messages directly to a running Pi extension instead, with no terminal typing or hidden input box.

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
- `fzf` is optional and provides the session selector when several sessions exist

Remote machine:

- Bash
- tmux
- `tmux-remote-control` for generating the controller command
- SSH access from the local device
- For Pi mode: Node.js 18+ and this complete package, including `bin/tmux-remote-control-pi.cjs` and `lib/pi-remote.cjs`

Development and verification also require npm, Python 3, and the development dependencies (`npm install --ignore-scripts --legacy-peer-deps`).

## Install

Keep the complete repository on both machines, then link the executable. The Pi helper resolves executable symlinks to find its support module:

```bash
npm ci --ignore-scripts --legacy-peer-deps
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

Run the installer again after updating this repository. It installs `~/.pi/agent/extensions/tmux-remote-control/index.ts` and its `lib/pi-remote.cjs` support module, then removes the old flat extension entry, including an older symlink installation.

Run `/reload` in an existing Pi process, or start a new one. Inside a remote tmux session, press `Ctrl+Shift+R` or run `/remote-control`. The extension:

1. Registers a private message endpoint for its tmux server and pane.
2. Copies a controller command with `--pi`, the tmux socket path, and server PID. This step reads `TMUX` and `TMUX_PANE`; it does not open the tmux socket.
3. Replaces Pi's editor with a **typing-locked** indicator. Typed text, paste, Enter, history recall, and clipboard/external-editor shortcuts cannot submit or change its draft.

Paste the copied command into a local terminal. Each submission follows this path:

```text
local controller → SSH helper → focused pane's endpoint → pi.sendUserMessage()
                                     (not terminal stdin)
```

Messages start a turn when Pi is idle, or become steering messages while it is working. Registered extension commands, skills, and prompt templates are supported. Built-in TUI commands such as `/tree` and `/settings`, and `!` shell shortcuts, are rejected with instructions to use Pi's visible editor instead. An acknowledgement means the extension handed the message to Pi; it does not mean the model finished or a later Pi input hook accepted it.

Press `Ctrl+Shift+R` again to restore Pi's editor and its preserved draft. Escape still interrupts, and model/thinking controls, tool expansion, and message copying remain available. Selectors and questionnaires retain their own keyboard input; remote submissions are rejected while the editor does not have focus or an extension dialog is open.

Enable remote mode separately in each Pi pane you want to control. The controller can keep following pane/window navigation, but **Pi mode never falls back to terminal paste**, including when you focus a shell or disable the extension. Ordinary attach commands without `--pi` retain terminal-input behavior.

Disabling remote mode, `/reload`, session replacement, and Pi shutdown close the endpoint and remove its registration. Re-enable remote mode after reload or session replacement. The local controller can stay open. A failed submission exits the controller and saves its draft at the printed local path. A connection loss may occur after delivery, so check Pi before manually resending; the controller does not retry automatically.

#### Endpoint identity and permissions

The registry maps `(tmux socket path, server PID, pane ID)` to a random extension instance. Pane IDs are stable within a running tmux server, but do not identify a Pi process or conversation. The helper verifies the tmux server PID, snapshots the pane once, then handshakes with that exact endpoint. The prompt carries both the extension instance ID and the Pi session ID from the handshake; a mismatch is rejected.

By default the registry and socket live under `/tmp/tmux-pi-<uid>`. Directories are owner-only and files/sockets are owner-only. This is a same-OS-user interface protected by SSH and local file permissions, not a public network listener. It does not isolate other processes running as your user.

A crashed process can leave a stale registration. New endpoints do not overwrite existing registrations automatically. Confirm the old endpoint is stopped before removing the registration path reported by the error, then enable remote mode again. This prevents a second Pi process in the same pane from taking over a live endpoint.

#### Sandboxes that block sockets

Socket transport requires the SSH host to reach Pi's Unix socket. If a sandbox blocks sockets or uses a separate filesystem, explicitly configure the **files** transport and a private directory shared at the same absolute path with the host. There is no automatic transport downgrade.

Before entering the sandbox, on the tmux host:

```bash
export TMUX_REMOTE_CONTROL_RPC_TRANSPORT=files
export TMUX_REMOTE_CONTROL_RPC_DIR="$HOME/.local/run/tmux-pi"
mkdir -p "$TMUX_REMOTE_CONTROL_RPC_DIR"
chmod 700 "$TMUX_REMOTE_CONTROL_RPC_DIR"
export TMUX_REMOTE_CONTROL_TMUX_SOCKET="$(tmux display-message -p '#{socket_path}')"
export TMUX_REMOTE_CONTROL_TMUX_SERVER_PID="$(tmux display-message -p '#{pid}')"
```

Configure the sandbox to share that directory read/write and forward those four variables plus `TMUX_PANE`. The host and sandbox must use compatible file ownership. The copied command includes the shared directory path; the SSH helper discovers the transport from the registration. Requests and replies use private, atomically published files, checked about every 100 ms. `TMUX_PANE` alone is no longer enough to identify the endpoint's tmux server.

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

The command copied by the Pi extension includes these additional options:

- `--pi`: use direct Pi messages, never terminal paste
- `--tmux-socket PATH`: address the specific remote tmux server for discovery, navigation, and submission
- `--tmux-server-pid PID`: reject Pi submissions if that server has been replaced
- `--rpc-dir PATH`: use an explicitly configured remote endpoint directory

Prefer the copied command rather than entering these values manually.

Keep all submissions pinned to one pane instead of following focus:

```bash
tmux-remote-control attach devbox --target %12
```

Exit after one submission:

```bash
tmux-remote-control attach devbox work --once
```

## Local input

Attach mode clears the current terminal screen and docks the remote target and inline prompt at the bottom. The prompt uses Pi's `@earendil-works/pi-tui` input component, including its standard terminal editing behavior. Gruvbox colors distinguish the host and session; the borders and prompt arrow use the terminal's default foreground color:

```text
📡  Controlling: devbox → work
─────────────────────────────
› type here
─────────────────────────────
```

Controls:

- `Enter`: submit the current line
- `Alt-Left` / `Alt-Right` or `Ctrl-Left` / `Ctrl-Right`: move by one word
- `Alt-Backspace` or `Ctrl-W`: delete the previous word
- `Alt-Delete` or `Alt-D`: delete the next word
- `Ctrl-A` / `Ctrl-E`: move to the start or end of the line
- `Ctrl-U`: delete to the start of the line
- `Ctrl-Y` / `Alt-Y`: paste or cycle through deleted text
- `Ctrl--`: undo
- `Ctrl-G`: open the current draft in an external editor, then submit when the editor exits
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

Pressing Enter on an empty prompt shows another prompt. Use `--editor` to open the external editor immediately. Add `--once` with `--editor` if the editor should open only once.

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

## Environment

- `TMUX_REMOTE_CONTROL_HOST`: default SSH host for either mode
- `TMUX_REMOTE_CONTROL_SESSION`: default attach-mode session selector
- `TMUX_REMOTE_CONTROL_TARGET`: default attach-mode fixed pane target
- `TMUX_REMOTE_CONTROL_EDITOR`: attach-mode editor command
- `TMUX_REMOTE_CONTROL_TMPDIR`: local directory for prompt and discovery temporary files
- `TMUX_REMOTE_CONTROL_RPC_TRANSPORT`: Pi endpoint transport, `socket` (default) or `files`
- `TMUX_REMOTE_CONTROL_RPC_DIR`: private remote endpoint directory; required for files transport
- `TMUX_REMOTE_CONTROL_TMUX_SOCKET` and `TMUX_REMOTE_CONTROL_TMUX_SERVER_PID`: explicit host tmux identity when the sandbox does not forward `TMUX`; set both

Command-line host, session, and target arguments override environment defaults.

## Connection behavior

Attach mode establishes an SSH control connection during discovery. Every submission reuses it, which avoids repeated SSH key exchange and authentication. The private control socket uses a short directory under `/tmp` to stay below Unix-socket path limits on macOS. The control socket and temporary files are removed when the controller exits, except for Pi drafts preserved after a failed submission.

There is still at least one network round trip between pressing Enter and the remote application receiving the input. The local input row clears before that network operation starts, so local feedback remains immediate.

In ordinary terminal mode, `tmux paste-buffer -p -r` uses bracketed paste when the target application has enabled it. Multiline editor input therefore arrives as one paste, followed by a separate Enter key. The attached keyboard and controller can write at the same time; avoid typing in the target application during that short operation.

Pi mode does not use paste buffers or Enter keys. It sends a bounded JSON request through the registered endpoint, with a five-second handshake/submission timeout and no automatic retry. Local terminal typing cannot become part of that message.

## Verification

`npm run verify` checks syntax and runs transport, editor-lock, controller, installer, quoting, and tmux-routing tests. Socket and files transports are tested for stale identities, permissions, duplicate requests, timeouts, malformed input, and cleanup.

With Pi and tmux installed, run `npm run test:pi` for the end-to-end checks. Set `PI_TEST_CLI` to an alternative Pi executable if needed. These tests install the extension in a temporary agent directory, start a private tmux server, and verify both transports against Pi's real TUI. A test extension intercepts every prompt before the model; no API key or model call is needed. They do not use your active Pi session.
