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
- Node.js for trimming the final newline added by external editors
- `fzf` is optional and provides the session selector when several sessions exist

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

## Clipboard setup

The remote launcher uses `tmux load-buffer -w` to set the tmux buffer and send it to the terminal clipboard through OSC 52.

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

Attach mode uses an inline readline prompt:

```text
> type here
```

Controls:

- `Enter`: submit the current line
- `Ctrl-G`: open the current draft in an external editor, then submit when the editor exits
- `Ctrl-D`: close the controller

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

Command-line host, session, and target arguments override environment defaults.

## Connection behavior

Attach mode establishes an SSH control connection during discovery. Every submission reuses it, which avoids repeated SSH key exchange and authentication. The private control socket uses a short directory under `/tmp` to stay below Unix-socket path limits on macOS. The control socket and temporary files are removed when the controller exits.

There is still at least one network round trip between pressing Enter and the remote application receiving the input. The local input row clears before that network operation starts, so local feedback remains immediate.

`tmux paste-buffer -p -r` uses bracketed paste when the target application has enabled it. Multiline editor input therefore arrives as one paste, followed by a separate Enter key.

The attached keyboard and remote controller can technically write at the same time. Avoid typing in the target application during the short submission operation.
