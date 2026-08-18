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

## Isara sandbox socket permission

`isara pi run` uses a sandbox that denies Unix sockets by default, including tmux's control socket. Configure the permission for your remote user without changing Isara's defaults for anyone else.

From a normal remote shell **inside the tmux pane, before starting Isara**, print the exact socket path:

```bash
printf '%s\n' "${TMUX%%,*}"
```

Add that exact path to `~/security_profile.json` on the remote machine. For example:

```json
{
  "network": {
    "allowUnixSockets": [
      "/tmp/tmux-1000/default"
    ]
  }
}
```

If the file already exists, merge `allowUnixSockets` into its existing `network` object rather than replacing the file. Isara merges this user-owned override into its built-in `git` profile; it does not alter defaults for other users. The allowlist requires an exact path and does not accept a wildcard.

A nearer `security_profile.json` in the current repository or one of its subdirectories takes precedence over the home-level file. In that case, add the socket to that effective file locally and do not commit the user-specific path.

Restart `isara pi run` after editing the profile. `/reload` is insufficient because the sandbox policy is fixed when Pi starts.

Allowing the tmux socket lets sandboxed Pi processes interact with that tmux server, including its other panes. Only add the exact socket for the server you intend to control.

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

1. Reads the exact pane id and socket from `TMUX`/`TMUX_PANE`, or directly matches Pi's stdin TTY against every standard tmux server socket when a launcher such as `isara pi run` has scrubbed those variables.
2. Marks that pane with `@pi_prompt=1`.
3. Remembers `devbox` globally in `~/.pi/agent/pi-tmux-remote-control.json` (or the directory selected by `PI_CODING_AGENT_DIR`).
4. Builds a command such as:

   ```bash
   pi-prompt --host 'devbox' --target '%12' --loop
   ```

5. Copies the command to the attached local terminal clipboard through tmux/OSC 52.
6. Displays the command in the Pi transcript as a fallback.

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

Older pane-scoped `@pi_prompt_host` values are automatically migrated when no global host has been saved yet.

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

An empty value is expected under launchers such as `isara pi run`; `/remote-control` then reads Pi's stdin TTY directly and searches the tmux sockets below `$TMPDIR/tmux-$UID` and `/tmp/tmux-$UID`. This supports both the default server and named servers created with `tmux -L`.

If OSC 52 is blocked, `/remote-control` still displays the full command. Copy it manually.

Some terminals require explicit permission for applications to write to the clipboard. Enable OSC 52 clipboard access in the local terminal settings.
