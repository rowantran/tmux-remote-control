# pi-tmux-remote-control

## WARNING: this is slop software for personal use. proceed with caution

Type prompts with no network latency while the complete, unmodified Pi TUI runs in tmux on a remote machine.

- `pi-prompt` runs locally, opens your local editor, and injects completed prompts through SSH.
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

## tmux clipboard setup

On the remote machine, put this in `~/.tmux.conf`:

```tmux
set -g set-clipboard external
```

Restart the remote tmux server after changing it, or apply it to the running server:

```bash
tmux set-option -g set-clipboard external
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

1. Reads the exact pane id from `TMUX_PANE`, or matches Pi's controlling TTY against tmux's pane TTY when a launcher such as `isara pi run` has scrubbed the tmux environment variables.
2. Marks that pane with `@pi_prompt=1`.
3. Remembers `devbox` on the pane as `@pi_prompt_host`.
4. Builds a command such as:

   ```bash
   pi-prompt --host 'devbox' --target '%12' --loop
   ```

5. Copies the command to the attached local terminal clipboard through tmux/OSC 52.
6. Displays the command in the Pi transcript as a fallback.

Paste the copied command into a local terminal. Your local editor opens. Save and exit to submit the prompt. A fresh editor opens for the next prompt. Save an empty file or quit without saving to stop.

After the host has been remembered on that pane, use:

```text
/remote-control
```

## Local editor

`pi-prompt` uses the first configured value:

1. `PI_PROMPT_EDITOR`
2. `VISUAL`
3. `EDITOR`
4. `vi`

Examples:

```bash
PI_PROMPT_EDITOR=nvim pi-prompt devbox %12 --loop
PI_PROMPT_EDITOR='code --wait' pi-prompt devbox %12 --loop
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

An empty value is expected under launchers such as `isara pi run`; `/remote-control` then identifies the pane by matching Pi's controlling TTY. This fallback expects the session to use the default tmux server (the normal `tmux new-session` behavior).

If OSC 52 is blocked, `/remote-control` still displays the full command. Copy it manually.

Some terminals require explicit permission for applications to write to the clipboard. Enable OSC 52 clipboard access in the local terminal settings.
