# pi-tmux-remote-control

## WARNING: this is slop software for personal use. proceed with caution

Type prompts with no network latency while the complete, unmodified Pi TUI runs in tmux on a remote machine.

- `pi-prompt` runs locally, provides an inline readline prompt, and injects completed prompts through SSH.
- `/remote-control` runs inside remote Pi, identifies its exact tmux pane, and copies the local control command through tmux using OSC 52.
- tmux remains the only input multiplexer. Normal attached-terminal input and injected prompts both enter the same pane PTY.

## Install locally

```bash
cd ~/workplace/pi-tmux-remote-control
npm install
npm run verify
mkdir -p ~/bin
ln -sfn "$PWD/bin/pi-prompt" ~/bin/pi-prompt
```

`~/bin` must be in your local `PATH`. This avoids requiring write access to the system npm prefix.

## Install on the remote machine

Copy or clone this repository to the remote machine, then install its Pi extension:

```bash
cd ~/workplace/pi-tmux-remote-control
npm install
npm run verify
pi install "$PWD"
```

The remote machine does not need the `pi-prompt` executable, although installing it does no harm.

## Isara tmux environment forwarding

The extension needs the pane identifier but does not need access to tmux's control socket. When launched inside tmux, current versions of `isara pi run` automatically forward only `TMUX` and `TMUX_PANE`. Outside tmux, those variables remain absent.

This does not grant the sandbox access to the tmux Unix socket or other panes. If you previously added a tmux path to `network.allowUnixSockets` in `security_profile.json`, remove it.

## tmux clipboard setup

On the remote machine, put this in `~/.tmux.conf`:

```tmux
set -g set-clipboard on
```

Restart the remote tmux server after changing it, or apply it to the running server:

```bash
tmux set-option -g set-clipboard on
```

Your local terminal must support OSC 52 clipboard writes. Ghostty, Kitty, iTerm2, WezTerm, and many current terminals support it. If a local tmux sits between SSH and the terminal, configure its `set-clipboard` option too.

## Use

Start normal Pi in remote tmux:

```bash
ssh -t devbox
cd /srv/project
tmux new-session -A -s pi 'isara pi run'
```

Inside Pi, run this once with the SSH host or local SSH config alias:

```text
/remote-control devbox
```

The extension:

1. Reads the exact pane id from the forwarded `TMUX_PANE` value.
2. Remembers `devbox` globally in `~/.pi/agent/pi-tmux-remote-control.json` (or the directory selected by `PI_CODING_AGENT_DIR`).
3. Builds a command such as:

   ```bash
   pi-prompt --host 'devbox' --target '%12' --loop
   ```

4. Copies the command with Pi's built-in OSC 52 clipboard helper.
5. Displays the command in the Pi transcript as a fallback.

Paste the copied command into a local terminal. Type at the zero-latency local prompt and press Enter to submit:

```text
> hello
```

Press `Ctrl-G` to open the current draft in your configured local editor; save and exit the editor to submit it. Press `Ctrl-D` at an empty prompt to stop. With `--loop`, pressing Enter on an empty prompt simply shows another prompt.

After the host has been remembered, every pane and future Pi session for that remote user can use:

```text
/remote-control
```

Change the global host at any time by supplying a different value:

```text
/remote-control new-devbox
```

## Local prompt and editor

The default input is a local readline prompt. It supports normal line editing and uses these additional controls:

- `Enter`: submit and immediately clear the local input row
- `Ctrl-G`: open the current draft in the external editor, then submit it when the editor exits
- `Ctrl-D`: exit

Use `--editor` to skip the inline prompt and open the external editor immediately.

`pi-prompt` establishes an SSH control connection while discovering the target pane and reuses that authenticated connection for every submission. This avoids repeated SSH key exchange and authentication. The control connection and its private socket are closed when `pi-prompt` exits.

There is still at least one network round trip between pressing Enter and Pi receiving the text. The input row is cleared before that network operation starts, so local feedback remains immediate. Remaining delay is normally remote network RTT plus the small tmux paste operation.

The external editor is selected from the first configured value:

1. `PI_PROMPT_EDITOR`
2. `VISUAL`
3. `EDITOR`
4. `vi`

Examples:

```bash
PI_PROMPT_EDITOR=nvim pi-prompt devbox %12 --loop
PI_PROMPT_EDITOR='code --wait' pi-prompt devbox %12 --loop
pi-prompt devbox %12 --editor
```

## Pane discovery without `/remote-control`

Mark the current remote pane manually:

```bash
tmux set-option -p @pi_prompt 1
```

Then the target can be omitted:

```bash
pi-prompt devbox --loop
```

List panes:

```bash
pi-prompt devbox --list
```

Mark a pane remotely from the local shell:

```bash
pi-prompt devbox --mark pi:0.0
```

If more than one pane is marked, `pi-prompt` uses local `fzf` when available or shows a numbered selector.

## How the two input paths work

A Unix process has only one standard input file descriptor. Pi cannot independently read two unrelated `stdin` streams.

The remote tmux pane provides the required multiplexing instead:

```text
attached keyboard ─┐
                   ├─> tmux pane PTY ─> Pi stdin
pi-prompt paste ───┘
```

`tmux paste-buffer -p -r` wraps the local prompt in bracketed-paste control codes. Pi receives it as one multiline paste. `tmux send-keys Enter` then submits it.

The two sources can technically write simultaneously, so avoid typing in the attached remote editor during the short prompt injection.

## Troubleshooting clipboard copying

Check the remote setting:

```bash
tmux show-options -g set-clipboard
```

Check that Pi is in tmux:

```bash
printf '%s\n' "$TMUX_PANE"
```

If this is empty inside Pi, update Isara and restart `isara pi run` from inside tmux. The extension intentionally does not connect to the tmux control socket as a fallback.

If OSC 52 is blocked, `/remote-control` still displays the full command. Copy it manually.

Some terminals require explicit permission for applications to write to the clipboard. Enable OSC 52 clipboard access in the local terminal settings.
