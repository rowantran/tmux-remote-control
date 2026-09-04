#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d /tmp/tmux-remote-control-test.XXXXXX)"
test_tmux_socket=""
cleanup() {
  [[ -z "$test_tmux_socket" ]] || tmux -L "$test_tmux_socket" kill-server 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT
mkdir -p "$root/bin"

cat >"$root/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
previous=""
for argument in "$@"; do
  if [[ "$previous" == "-O" && "$argument" == "exit" ]]; then
    exit 0
  fi
  previous="$argument"
done
if [[ -n "${TMUX_REMOTE_CONTROL_TEST_SSH_ARGS:-}" ]]; then
  printf '%s\n' "$@" >"$TMUX_REMOTE_CONTROL_TEST_SSH_ARGS"
fi
command="${!#}"
printf '%s\n' "$command" >>"$TMUX_REMOTE_CONTROL_TEST_ALL_COMMANDS"
if [[ "$command" == *"list-sessions"* ]]; then
  if [[ "${TMUX_REMOTE_CONTROL_TEST_NO_SESSIONS:-}" != "1" ]]; then
    printf '$3\twork\t2\t1\n'
  fi
  exit 0
fi
if [[ "$command" == *'#{session_id}|#{session_name}'* ]]; then
  if [[ -n "${TMUX_REMOTE_CONTROL_TEST_QUERY_COMMAND:-}" ]]; then
    printf '%s\n' "$command" >"$TMUX_REMOTE_CONTROL_TEST_QUERY_COMMAND"
  fi
  printf '$3|work\n'
  exit 0
fi
if [[ "$command" == *'#{pane_id}|#{session_name}'* ]]; then
  printf '%%7|work:0.0\n'
  exit 0
fi
if [[ "$command" == tmux*" resize-pane "* || "$command" == tmux*" select-pane "* || "$command" == tmux*" select-window "* ]]; then
  printf '%s\n' "$command" >>"$TMUX_REMOTE_CONTROL_TEST_NAVIGATION_COMMANDS"
  exit 0
fi
printf '%s\n' "$command" >"$TMUX_REMOTE_CONTROL_TEST_COMMAND"
cat >"$TMUX_REMOTE_CONTROL_TEST_INPUT"
if [[ "$command" == *"pi-send"* && "${TMUX_REMOTE_CONTROL_TEST_FAIL_PI_SEND:-}" == "1" ]]; then
  printf 'mock RPC acknowledgement timed out\n' >&2
  exit 1
fi
SH
chmod +x "$root/bin/ssh"

cat >"$root/bin/editor" <<'SH'
#!/usr/bin/env bash
if [[ -n "${TMUX_REMOTE_CONTROL_TEST_EDITOR_INITIAL:-}" ]]; then
  cat "$1" >"$TMUX_REMOTE_CONTROL_TEST_EDITOR_INITIAL"
fi
printf 'first line\nsecond line\n' >"$1"
SH
chmod +x "$root/bin/editor"

export PATH="$root/bin:$PATH"
export TMUX_REMOTE_CONTROL_EDITOR="$root/bin/editor"
export TMUX_REMOTE_CONTROL_TEST_COMMAND="$root/command"
export TMUX_REMOTE_CONTROL_TEST_INPUT="$root/input"
export TMUX_REMOTE_CONTROL_TEST_SSH_ARGS="$root/ssh-args"
export TMUX_REMOTE_CONTROL_TEST_QUERY_COMMAND="$root/query-command"
export TMUX_REMOTE_CONTROL_TEST_NAVIGATION_COMMANDS="$root/navigation-commands"
export TMUX_REMOTE_CONTROL_TEST_ALL_COMMANDS="$root/all-commands"
# Do not let the developer's current tmux/Pi settings change test defaults.
unset TMUX_REMOTE_CONTROL_HOST TMUX_REMOTE_CONTROL_SESSION TMUX_REMOTE_CONTROL_TARGET
unset TMUX_REMOTE_CONTROL_TMUX_SOCKET TMUX_REMOTE_CONTROL_TMUX_SERVER_PID TMUX_REMOTE_CONTROL_RPC_DIR

project_root="$(cd "$(dirname "$0")/.." && pwd)"
script="$project_root/bin/tmux-remote-control"
installer="$project_root/install-pi-extension.sh"

# The Pi installer creates a regular copy and replaces an older symlink without
# overwriting that symlink's target.
install_home="$root/install-home"
install_dir="$install_home/.pi/agent/extensions"
old_target="$root/old-extension-target"
mkdir -p "$install_dir"
printf 'old target\n' >"$old_target"
ln -s "$old_target" "$install_dir/tmux-remote-control.ts"
HOME="$install_home" "$installer" >"$root/installer-output"
[[ ! -e "$install_dir/tmux-remote-control.ts" && ! -L "$install_dir/tmux-remote-control.ts" ]]
[[ -f "$install_dir/tmux-remote-control/index.ts" && ! -L "$install_dir/tmux-remote-control/index.ts" ]]
cmp "$project_root/pi-extension.ts" "$install_dir/tmux-remote-control/index.ts"
cmp "$project_root/lib/pi-remote.cjs" "$install_dir/tmux-remote-control/lib/pi-remote.cjs"
[[ "$(cat "$old_target")" == "old target" ]]
grep -F "Installed Pi extension at $install_dir/tmux-remote-control/index.ts" "$root/installer-output" >/dev/null

if TMUX_PANE= "$script" example-host >"$root/launcher-output" 2>"$root/launcher-error"; then
  echo "expected the remote launcher to require tmux" >&2
  exit 1
fi
grep -F 'run the launcher inside tmux' "$root/launcher-error" >/dev/null

# The legacy print path remains socket-free and unchanged. Attach resolves the
# pane to a stable session id over SSH when the local controller starts.
mkdir -p "$root/no-tmux-bin"
cat >"$root/no-tmux-bin/tmux" <<SH
#!/usr/bin/env bash
printf 'tmux was invoked\n' >'$root/unexpected-tmux-invocation'
exit 126
SH
chmod +x "$root/no-tmux-bin/tmux"
TMUX_PANE=%42 PATH="$root/no-tmux-bin:$PATH" \
  "$script" --print-controller-command devbox >"$root/printed-controller-command"
[[ ! -e "$root/unexpected-tmux-invocation" ]]
[[ "$(cat "$root/printed-controller-command")" == \
  "tmux-remote-control attach devbox --session %42" ]]

TMUX_PANE=%42 PATH="$root/no-tmux-bin:$PATH" \
  "$script" --print-controller-command "dev'box" >"$root/quoted-controller-command"
[[ "$(cat "$root/quoted-controller-command")" == \
  "tmux-remote-control attach 'dev'\\''box' --session %42" ]]

# The Pi extension must request the socket-free launcher mode and copy its one
# line result with OSC 52 instead of invoking tmux inside the sandbox.
grep -F '["--print-controller-command", "--pi"]' "$project_root/pi-extension.ts" >/dev/null
grep -F 'process.stdout.write(`\x1b]52;c;${encodedCommand}\x07`)' \
  "$project_root/pi-extension.ts" >/dev/null

expect_failure() {
  local message="$1"
  shift
  if "$@" >"$root/failure-output" 2>"$root/failure-error"; then
    printf 'expected failure: %s\n' "$*" >&2
    exit 1
  fi
  grep -F -- "$message" "$root/failure-error" >/dev/null
}

# Pi is opt-in. Its printed command pins the server without opening its socket,
# parses TMUX from the right, and preserves every quoted argument.
TMUX='/tmp/pi-socket,123,0' TMUX_PANE=%42 PATH="$root/no-tmux-bin:$PATH" \
  "$script" --print-controller-command --pi devbox >"$root/pi-controller-command"
[[ "$(cat "$root/pi-controller-command")" == \
  'tmux-remote-control attach devbox --pi --tmux-socket /tmp/pi-socket --tmux-server-pid 123 --session %42' ]]
pi_socket="$root/socket,with comma ' and \$dollar"
pi_rpc_dir="$root/rpc ' directory, \$literal"
TMUX="$pi_socket,123,7" TMUX_PANE=%42 TMUX_REMOTE_CONTROL_RPC_DIR="$pi_rpc_dir" \
  PATH="$root/no-tmux-bin:$PATH" \
  "$script" --print-controller-command --pi "dev'box" >"$root/pi-quoted-command"
python3 - "$root/pi-quoted-command" "$pi_socket" "$pi_rpc_dir" <<'PY'
import pathlib, shlex, sys
command = pathlib.Path(sys.argv[1]).read_text()
assert command.count("\n") == 1
assert shlex.split(command) == [
    "tmux-remote-control", "attach", "dev'box", "--pi", "--tmux-socket", sys.argv[2],
    "--tmux-server-pid", "123", "--session", "%42", "--rpc-dir", sys.argv[3],
]
PY
# Run the generated command against an argv recorder as well as parsing it.
TMUX_REMOTE_CONTROL_TEST_GENERATED="$(cat "$root/pi-quoted-command")" \
  TMUX_REMOTE_CONTROL_TEST_ARGV="$root/generated-argv" bash -c '
  tmux-remote-control() { printf "%s\0" "$@" >"$TMUX_REMOTE_CONTROL_TEST_ARGV"; }
  eval "$TMUX_REMOTE_CONTROL_TEST_GENERATED"
'
python3 - "$root/generated-argv" "$pi_socket" "$pi_rpc_dir" <<'PY'
import pathlib, sys
assert pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")[:-1] == [
    x.encode() for x in ["attach", "dev'box", "--pi", "--tmux-socket", sys.argv[2],
                        "--tmux-server-pid", "123", "--session", "%42", "--rpc-dir", sys.argv[3]]
]
PY
TMUX= TMUX_PANE=%42 TMUX_REMOTE_CONTROL_TMUX_SOCKET=/tmp/override \
  TMUX_REMOTE_CONTROL_TMUX_SERVER_PID=456 PATH="$root/no-tmux-bin:$PATH" \
  "$script" --pi --print-controller-command devbox >"$root/pi-override-command"
grep -F -- '--tmux-socket /tmp/override --tmux-server-pid 456' "$root/pi-override-command" >/dev/null
expect_failure 'set both' env TMUX='/tmp/original,123,0' TMUX_PANE=%42 \
  TMUX_REMOTE_CONTROL_TMUX_SOCKET=/tmp/override \
  "$script" --pi --print-controller-command devbox
expect_failure 'absolute path' env TMUX='/tmp/original,123,0' TMUX_PANE=%42 \
  TMUX_REMOTE_CONTROL_RPC_DIR=relative "$script" --pi --print-controller-command devbox
expect_failure 'tmux identity' env TMUX= TMUX_PANE=%42 "$script" --pi --print-controller-command devbox
expect_failure 'tmux identity' env TMUX='/tmp/socket,123' TMUX_PANE=%42 "$script" --pi --print-controller-command devbox
expect_failure 'tmux server PID' env TMUX='/tmp/socket,nope,0' TMUX_PANE=%42 "$script" --pi --print-controller-command devbox
expect_failure 'tmux socket path' env TMUX='relative,123,0' TMUX_PANE=%42 "$script" --pi --print-controller-command devbox
expect_failure 'run the launcher inside tmux' env TMUX='/tmp/socket,123,0' TMUX_PANE=nope "$script" --pi --print-controller-command devbox
[[ ! -e "$root/unexpected-tmux-invocation" ]]
expect_failure 'tmux socket path' "$script" attach example-host --pi --editor --once
expect_failure 'tmux server PID' "$script" attach example-host --pi --tmux-socket /tmp/socket --editor --once
expect_failure 'invalid tmux server PID' "$script" attach example-host --pi --tmux-socket /tmp/socket --tmux-server-pid 0 --editor --once

assert_pi_submission() {
  python3 - "$root/command" "$pi_socket" "$1" "$2" "${3:-}" <<'PY'
import pathlib, shlex, sys
outer = shlex.split(pathlib.Path(sys.argv[1]).read_text())
assert outer[:2] == ["sh", "-c"] and len(outer) == 3, outer
expected = ["tmux-remote-control", "pi-send", "--tmux-socket", sys.argv[2],
            "--tmux-server-pid", "123", sys.argv[3], sys.argv[4]]
if sys.argv[5]:
    expected += ["--rpc-dir", sys.argv[5]]
assert shlex.split(outer[2]) == expected, outer[2]
assert "paste-buffer" not in outer[2] and "send-keys" not in outer[2]
PY
}

# Discovery is socket-scoped, and Pi submission delegates only to the helper.
: >"$TMUX_REMOTE_CONTROL_TEST_ALL_COMMANDS"
"$script" attach example-host --pi --tmux-socket "$pi_socket" --tmux-server-pid 123 \
  --rpc-dir "$pi_rpc_dir" --editor --once >"$root/pi-session-output"
assert_pi_submission --session '$3' "$pi_rpc_dir"
[[ "$(cat "$root/input")" == $'first line\nsecond line' ]]
python3 - "$TMUX_REMOTE_CONTROL_TEST_ALL_COMMANDS" "$pi_socket" <<'PY'
import pathlib, shlex, sys
# list-sessions embeds tabs, but each invocation still occupies one line.
commands = pathlib.Path(sys.argv[1]).read_text().splitlines()
assert len(commands) == 3, commands
assert shlex.split(commands[0])[:4] == ["tmux", "-S", sys.argv[2], "list-sessions"]
assert shlex.split(commands[1])[:4] == ["tmux", "-S", sys.argv[2], "display-message"]
PY
TMUX_REMOTE_CONTROL_RPC_DIR="$pi_rpc_dir" \
  "$script" attach example-host --pi --tmux-socket "$pi_socket" --tmux-server-pid 123 \
  --target %7 --editor --once >"$root/pi-target-output"
assert_pi_submission --target %7 "$pi_rpc_dir"
TMUX_REMOTE_CONTROL_TMUX_SOCKET="$pi_socket" TMUX_REMOTE_CONTROL_TMUX_SERVER_PID=123 \
  "$script" attach example-host --pi --session %7 --editor --once >/dev/null
assert_pi_submission --session '$3'

# An uncertain acknowledgement must neither retry nor delete the user's draft.
: >"$TMUX_REMOTE_CONTROL_TEST_ALL_COMMANDS"
expect_failure 'Draft saved to:' env TMUX_REMOTE_CONTROL_TEST_FAIL_PI_SEND=1 \
  TMUX_REMOTE_CONTROL_TMPDIR="$root" "$script" attach example-host --pi \
  --tmux-socket "$pi_socket" --tmux-server-pid 123 --target %7 --editor --once
grep -F 'ambiguous; do not auto-retry' "$root/failure-error" >/dev/null
saved_draft="$(grep -F 'Draft saved to:' "$root/failure-error")"
saved_draft="${saved_draft##*Draft saved to: }"
[[ -f "$saved_draft" ]]
[[ "$(cat "$saved_draft")" == $'first line\nsecond line' ]]
[[ "$(grep -c 'pi-send' "$TMUX_REMOTE_CONTROL_TEST_ALL_COMMANDS")" == 1 ]]
! grep -E 'paste-buffer|send-keys|load-buffer' "$TMUX_REMOTE_CONTROL_TEST_ALL_COMMANDS" >/dev/null
rm -f "$saved_draft"

# Fixed-pane mode resolves the supplied target to a stable pane id. A long
# macOS-style temporary path must not be used for the SSH control socket.
long_temp_root="$root/var/folders/abcdefghijklmnopqrstuvwxyz0123456789/T/very-long-temp-directory"
mkdir -p "$long_temp_root"
TMUX_REMOTE_CONTROL_TMPDIR="$long_temp_root" \
  "$script" attach example-host --target %7 --editor --once >"$root/fixed-output"
grep -F "sh -c" "$root/command" >/dev/null
grep -F "paste-buffer -p -r" "$root/command" >/dev/null
grep -F "delete-buffer" "$root/command" >/dev/null
grep -F "%7" "$root/command" >/dev/null
[[ "$(cat "$root/input")" == $'first line\nsecond line' ]]
grep -F "Submitted input to example-host pane work:0.0 (%7)" "$root/fixed-output" >/dev/null
grep -F "ControlMaster=auto" "$root/ssh-args" >/dev/null
grep -F "ControlPersist=10m" "$root/ssh-args" >/dev/null
control_path_argument="$(grep -F 'ControlPath=' "$root/ssh-args")"
[[ "$control_path_argument" == ControlPath=/tmp/tmux-rc.*/c ]]
((${#control_path_argument} < 80))

# Session mode resolves the focused pane for every submission.
"$script" attach example-host --session %7 --editor --once >"$root/session-output"
grep -F 'focused_pane=$(tmux display-message' "$root/command" >/dev/null
grep -F '$3' "$root/command" >/dev/null
grep -F -- '-t "$focused_pane"' "$root/command" >/dev/null
[[ "$(cat "$root/input")" == $'first line\nsecond line' ]]
grep -F 'Submitted input to example-host session work ($3), focused pane' "$root/session-output" >/dev/null

# Session selectors are safely quoted, including apostrophes.
"$script" attach example-host --session "team's work" --editor --once >/dev/null
grep -F -- "-t 'team'\\''s work'" "$root/query-command" >/dev/null

# With no selector, one discovered session is selected automatically.
"$script" attach example-host --editor --once >/dev/null
grep -F -- "-t '\$3' '#{session_id}|#{session_name}'" "$root/query-command" >/dev/null

# Explicit CLI selection overrides the other mode's environment default.
TMUX_REMOTE_CONTROL_TARGET=%8 "$script" attach example-host --session %7 --editor --once >/dev/null
TMUX_REMOTE_CONTROL_SESSION=work "$script" attach example-host --target %7 --editor --once >/dev/null
TMUX_REMOTE_CONTROL_SESSION=work "$script" attach example-host --list >/dev/null

run_in_pty() {
  TMUX_REMOTE_CONTROL_TEST_KEYS="$1" \
    TMUX_REMOTE_CONTROL_TEST_KEYS_AFTER_PROMPT="${2:-}" \
    python3 - "$script" <<'PY'
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

script = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    args = [script, "attach", "example-host", "--session", "%7", "--once"]
    if os.environ.get("TMUX_REMOTE_CONTROL_TEST_PI") == "1":
        args += ["--pi", "--tmux-socket", os.environ["TMUX_REMOTE_CONTROL_TEST_SOCKET"],
                 "--tmux-server-pid", "123"]
    os.execve(script, args, os.environ)

output = bytearray()
deadline = time.monotonic() + 10
sent = False
resized = False
after_prompt_keys = os.environ["TMUX_REMOTE_CONTROL_TEST_KEYS_AFTER_PROMPT"]
sent_after_prompt = not after_prompt_keys
keyboard_marker_prefix = b"\x1b[>"
clear_screen = b"\x1b[2J\x1b[H"

def prompt_count(data: bytearray) -> int:
    # ProcessTerminal negotiates the best available keyboard protocol. Count
    # each negotiation request that is followed by a rendered input prompt.
    count = 0
    start = 0
    while True:
        marker = data.find(keyboard_marker_prefix, start)
        if marker < 0:
            return count
        marker_end = data.find(b"u", marker + len(keyboard_marker_prefix))
        if marker_end < 0:
            return count
        next_marker = data.find(keyboard_marker_prefix, marker_end + 1)
        end = len(data) if next_marker < 0 else next_marker
        if "› ".encode("utf-8") in data[marker_end + 1:end]:
            count += 1
        start = marker_end + 1

while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        prompts = prompt_count(output)
        if not resized and prompts >= 1:
            size = os.get_terminal_size(fd)
            columns = 100 if size.columns != 100 else 101
            rows = size.lines or 24
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            resized = True
        elif resized and not sent and output.count(clear_screen) >= 2:
            os.write(fd, bytes.fromhex(os.environ["TMUX_REMOTE_CONTROL_TEST_KEYS"]))
            sent = True
        elif sent and not sent_after_prompt and prompts >= 2:
            os.write(fd, bytes.fromhex(after_prompt_keys))
            sent_after_prompt = True
    finished, status = os.waitpid(pid, os.WNOHANG)
    if finished:
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            sys.stderr.buffer.write(output)
            raise SystemExit("tmux-remote-control exited unsuccessfully")
        break
else:
    os.kill(pid, signal.SIGKILL)
    sys.stderr.buffer.write(output)
    raise SystemExit("timed out waiting for tmux-remote-control")

if not resized or not sent or not sent_after_prompt:
    sys.stderr.buffer.write(output)
    raise SystemExit("expected resized inline prompt was not displayed")
last_clear = output.rfind(clear_screen)
section = bytes(output[last_clear:])
# Remove ANSI control sequences so colored text can be checked as one line.
plain_section = __import__("re").sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", section)
plain_section = plain_section.replace(b"\x1b_pi:c\x07", b"")
header = "📡  Controlling: example-host → work".encode("utf-8")
prompt = "› ".encode("utf-8")
if last_clear < 0 or header not in plain_section or plain_section.find(header) > plain_section.find(prompt):
    sys.stderr.buffer.write(output)
    raise SystemExit("controller status was not redrawn above the prompt after resize")
rendered_lines = plain_section.split(b"\r\n")
status_row = next((index for index, line in enumerate(rendered_lines) if header in line), -1)
if status_row < max(0, rows - 4):
    sys.stderr.buffer.write(output)
    raise SystemExit("controller prompt was not docked at the bottom after resize")
if status_row + 3 >= len(rendered_lines) or not rendered_lines[status_row + 1].startswith("─".encode("utf-8")) or not rendered_lines[status_row + 2].startswith(prompt) or not rendered_lines[status_row + 3].startswith("─".encode("utf-8")):
    sys.stderr.buffer.write(output)
    raise SystemExit("controller prompt frame was not rendered in the expected order")
if b"\x1b[38;2;142;192;124mexample-host\x1b[39m" not in section or b"\x1b[38;2;250;189;47mwork\x1b[39m" not in section:
    sys.stderr.buffer.write(output)
    raise SystemExit("controller host and target colors were not rendered")
if b"\r\x1b[2K" not in output:
    sys.stderr.buffer.write(output)
    raise SystemExit("submitted inline prompt was not cleared")
if keyboard_marker_prefix not in output or b"\x1b[<u" not in output:
    sys.stderr.buffer.write(output)
    raise SystemExit("terminal keyboard mode was not negotiated and restored")
PY
}

run_in_pty "68656c6c6f0a"
[[ "$(cat "$root/input")" == "hello" ]]

export TMUX_REMOTE_CONTROL_TEST_EDITOR_INITIAL="$root/editor-initial"
run_in_pty "647261667407"
[[ "$(cat "$root/editor-initial")" == "draft" ]]
[[ "$(cat "$root/input")" == $'first line\nsecond line' ]]
unset TMUX_REMOTE_CONTROL_TEST_EDITOR_INITIAL

# Ctrl-C clears the current draft in both legacy and CSI-u terminal modes.
run_in_pty "64697363617264036b6570740d"
[[ "$(cat "$root/input")" == "kept" ]]
run_in_pty "646973636172641b5b39393b3575616c736f206b6570740d"
[[ "$(cat "$root/input")" == "also kept" ]]

# Ctrl-D exits without submitting a nonempty draft in both input modes.
printf 'not submitted' >"$root/input"
run_in_pty "647261667404"
[[ "$(cat "$root/input")" == "not submitted" ]]
run_in_pty "64726166741b5b3130303b3575"
[[ "$(cat "$root/input")" == "not submitted" ]]

# The Pi TUI input component handles standard terminal word editing.
run_in_pty "776f726c641b5b39373b357568656c6c6f200d"
[[ "$(cat "$root/input")" == "hello world" ]]
run_in_pty "68656c6c6f20776f726c641b5b313b3344626967200d"
[[ "$(cat "$root/input")" == "hello big world" ]]
run_in_pty "6f6e652074776f207468726565011b5b313b33431b5b35373432363b33750d"
[[ "$(cat "$root/input")" == "one three" ]]
run_in_pty "6f6e65207468726565011b5b313b334320666173740d"
[[ "$(cat "$root/input")" == "one fast three" ]]

# Navigation and zoom shortcuts run remote tmux commands without submitting the
# draft. CSI-u keeps Ctrl-J and Ctrl-number distinct from Enter and other keys.
: >"$TMUX_REMOTE_CONTROL_TEST_NAVIGATION_COMMANDS"
while IFS= read -r navigation_key; do
  printf 'navigation did not return to the prompt' >"$root/input"
  run_in_pty "6b6565702074686973206472616674${navigation_key}" "0d"
  [[ "$(cat "$root/input")" == "keep this draft" ]]
done < <(python3 - <<'PY'
for key in "fhjklpn0123456789":
    print(f"\x1b[{ord(key)};5u".encode().hex())
PY
)
cat >"$root/expected-navigation-commands" <<'EOF'
tmux resize-pane -Z -t '$3'
tmux select-pane -t '$3' -D
tmux select-pane -t '$3' -L
tmux select-pane -t '$3' -R
tmux select-pane -t '$3' -U
tmux select-window -t '$3' -p
tmux select-window -t '$3' -n
tmux select-window -t '$3:0'
tmux select-window -t '$3:1'
tmux select-window -t '$3:2'
tmux select-window -t '$3:3'
tmux select-window -t '$3:4'
tmux select-window -t '$3:5'
tmux select-window -t '$3:6'
tmux select-window -t '$3:7'
tmux select-window -t '$3:8'
tmux select-window -t '$3:9'
EOF
diff -u "$root/expected-navigation-commands" "$TMUX_REMOTE_CONTROL_TEST_NAVIGATION_COMMANDS"

# The same navigation shortcuts in Pi mode must address the pinned server.
: >"$TMUX_REMOTE_CONTROL_TEST_NAVIGATION_COMMANDS"
export TMUX_REMOTE_CONTROL_TEST_PI=1
export TMUX_REMOTE_CONTROL_TEST_SOCKET="$pi_socket"
while IFS= read -r navigation_key; do
  run_in_pty "6b6565702074686973206472616674${navigation_key}" "0d"
  [[ "$(cat "$root/input")" == "keep this draft" ]]
  assert_pi_submission --session '$3'
done < <(python3 - <<'PY'
for key in "fhjklpn0123456789":
    print(f"\x1b[{ord(key)};5u".encode().hex())
PY
)
unset TMUX_REMOTE_CONTROL_TEST_PI TMUX_REMOTE_CONTROL_TEST_SOCKET
python3 - "$root/expected-navigation-commands" "$TMUX_REMOTE_CONTROL_TEST_NAVIGATION_COMMANDS" "$pi_socket" <<'PY'
import pathlib, shlex, sys
expected = [shlex.split(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()]
actual = [shlex.split(line) for line in pathlib.Path(sys.argv[2]).read_text().splitlines()]
assert actual == [["tmux", "-S", sys.argv[3], *command[1:]] for command in expected], actual
PY

# Explicit sockets also scope every terminal submission command, including
# focus resolution and the EXIT-trap cleanup. No flags leaves legacy unchanged.
"$script" attach example-host --tmux-socket /tmp/terminal-socket --session %7 --editor --once >/dev/null
python3 - "$root/command" "$root/query-command" <<'PY'
import pathlib, shlex, sys
submission = shlex.split(pathlib.Path(sys.argv[1]).read_text())[2]
assert submission.count("tmux -S '/tmp/terminal-socket'") == 5, submission
assert "tmux " not in submission.replace("tmux -S '/tmp/terminal-socket'", "")
assert shlex.split(pathlib.Path(sys.argv[2]).read_text())[:3] == ["tmux", "-S", "/tmp/terminal-socket"]
PY

list_output="$("$script" attach example-host --list)"
[[ "$list_output" == *'$3'* ]]
[[ "$list_output" == *"work"* ]]
[[ "$list_output" == *"2 windows"* ]]

# Bash 3.2 with nounset handles an empty remote session list cleanly.
empty_list_output="$(TMUX_REMOTE_CONTROL_TEST_NO_SESSIONS=1 /bin/bash "$script" attach example-host --list)"
[[ "$empty_list_output" == $'SESSION\tNAME\tWINDOWS\tCLIENTS' ]]
if TMUX_REMOTE_CONTROL_TEST_NO_SESSIONS=1 /bin/bash "$script" attach example-host --editor --once \
  >"$root/no-sessions-output" 2>"$root/no-sessions-error"; then
  echo "expected no-session discovery to fail" >&2
  exit 1
fi
grep -F 'no tmux sessions found' "$root/no-sessions-error" >/dev/null

# Exercise the actual helper and executable dispatch through npm-style and
# ~/bin symlinks. Only tmux and RPC delivery are mocked; identity/runtime parsing
# uses the real library so its normalized paths and numeric PID stay compatible.
helper_package="$root/helper-package"
mkdir -p "$helper_package/bin" "$helper_package/lib" "$root/helper-mocks" \
  "$root/npm/bin" "$root/npm/lib/node_modules" "$root/home/bin"
cp "$script" "$helper_package/bin/tmux-remote-control"
cp "$project_root/bin/tmux-remote-control-pi.cjs" "$helper_package/bin/"
cat >"$helper_package/lib/pi-remote.cjs" <<'JS'
const fs = require('node:fs');
const real = require(process.env.TMUX_REMOTE_CONTROL_TEST_REAL_LIB);
exports.getIdentity = env => {
  fs.writeFileSync(process.env.TMUX_REMOTE_CONTROL_TEST_IDENTITY_ENV, JSON.stringify(env));
  return process.env.TMUX_REMOTE_CONTROL_TEST_BAD_IDENTITY === '1' ? null : real.getIdentity(env);
};
exports.getRuntimeDir = real.getRuntimeDir;
exports.sendToPane = async options => {
  fs.writeFileSync(process.env.TMUX_REMOTE_CONTROL_TEST_RPC_REQUEST, JSON.stringify(options));
  if (process.env.TMUX_REMOTE_CONTROL_TEST_RPC_FAIL === '1') throw new Error('RPC acknowledgement timed out');
};
JS
cat >"$root/helper-mocks/tmux" <<'JS'
#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.TMUX_REMOTE_CONTROL_TEST_TMUX_CALLS, JSON.stringify(process.argv.slice(2)) + '\n');
if (process.env.TMUX_REMOTE_CONTROL_TEST_TMUX_FAIL === '1') {
  console.error('mock tmux socket unavailable');
  process.exit(1);
}
process.stdout.write(process.env.TMUX_REMOTE_CONTROL_TEST_SNAPSHOT + '\n');
JS
chmod +x "$root/helper-mocks/tmux"
ln -s "$helper_package" "$root/npm/lib/node_modules/tmux-remote-control"
ln -s ../lib/node_modules/tmux-remote-control/bin/tmux-remote-control "$root/npm/bin/tmux-remote-control"
ln -s "$root/npm/bin/tmux-remote-control" "$root/home/bin/tmux-remote-control"
export TMUX_REMOTE_CONTROL_TEST_REAL_LIB="$project_root/lib/pi-remote.cjs"
export TMUX_REMOTE_CONTROL_TEST_IDENTITY_ENV="$root/identity-env"
export TMUX_REMOTE_CONTROL_TEST_RPC_REQUEST="$root/rpc-request"
export TMUX_REMOTE_CONTROL_TEST_TMUX_CALLS="$root/tmux-calls"
export TMUX_REMOTE_CONTROL_TEST_SNAPSHOT="$pi_socket"$'\t123\t%19'
printf 'raw prompt: \047quotes\047, $(not a command)\nsecond line\n' >"$root/helper-prompt"
for executable in "$root/npm/bin/tmux-remote-control" "$root/home/bin/tmux-remote-control"; do
  : >"$TMUX_REMOTE_CONTROL_TEST_TMUX_CALLS"
  PATH="$root/helper-mocks:$PATH" TMUX='/wrong,999,0' TMUX_PANE=%999 \
    TMUX_REMOTE_CONTROL_TMUX_SOCKET=/wrong TMUX_REMOTE_CONTROL_TMUX_SERVER_PID=999 \
    "$executable" pi-send --tmux-socket "$pi_socket" --tmux-server-pid 123 \
    --session '$3' --rpc-dir "$pi_rpc_dir" <"$root/helper-prompt"
  python3 - "$root" "$pi_socket" "$pi_rpc_dir" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
calls = [json.loads(line) for line in (root / "tmux-calls").read_text().splitlines()]
assert calls == [["-S", sys.argv[2], "display-message", "-p", "-t", "$3", "#{socket_path}\t#{pid}\t#{pane_id}"]], calls
request = json.loads((root / "rpc-request").read_text())
assert request["identity"]["socketPath"] == sys.argv[2]
assert request["identity"]["serverPid"] == 123
assert request["identity"]["paneId"] == "%19"
assert request["identity"]["serverKey"]
assert request["runtimeDir"] == sys.argv[3]
assert request["text"] == (root / "helper-prompt").read_text()
assert request["deliverAs"] == "steer" and request["timeoutMs"] == 5000
assert json.loads((root / "identity-env").read_text()) == {"TMUX": sys.argv[2] + ",123,0", "TMUX_PANE": "%19"}
PY
done
helper_command=(env "PATH=$root/helper-mocks:$PATH" "$helper_package/bin/tmux-remote-control" pi-send)
: >"$TMUX_REMOTE_CONTROL_TEST_TMUX_CALLS"
TMUX_REMOTE_CONTROL_RPC_DIR="$pi_rpc_dir" "${helper_command[@]}" \
  --tmux-socket "$pi_socket" --tmux-server-pid 123 --target %19 <"$root/helper-prompt"
python3 - "$root" "$pi_rpc_dir" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
assert json.loads((root / "tmux-calls").read_text())[5] == "%19"
assert json.loads((root / "rpc-request").read_text())["runtimeDir"] == sys.argv[2]
PY
expect_failure 'tmux socket path' "${helper_command[@]}" --tmux-server-pid 123 --target %19
expect_failure 'tmux server PID' "${helper_command[@]}" --tmux-socket "$pi_socket" --target %19
expect_failure 'stable tmux session ID' "${helper_command[@]}" --tmux-socket "$pi_socket" --tmux-server-pid 123 --session work
expect_failure 'exactly one' "${helper_command[@]}" --tmux-socket "$pi_socket" --tmux-server-pid 123 --session '$3' --target %19
expect_failure 'prompt is empty' "${helper_command[@]}" --tmux-socket "$pi_socket" --tmux-server-pid 123 --target %19 </dev/null
rm -f "$root/rpc-request"
: >"$TMUX_REMOTE_CONTROL_TEST_TMUX_CALLS"
expect_failure 'server PID changed' "${helper_command[@]}" --tmux-socket "$pi_socket" --tmux-server-pid 456 --target %19 <"$root/helper-prompt"
[[ ! -e "$root/rpc-request" ]]
[[ "$(wc -l <"$TMUX_REMOTE_CONTROL_TEST_TMUX_CALLS")" -eq 1 ]]
TMUX_REMOTE_CONTROL_TEST_SNAPSHOT=$'/tmp/socket\t123\tbroken' \
  expect_failure 'invalid server/pane identity' "${helper_command[@]}" --tmux-socket "$pi_socket" --tmux-server-pid 123 --target %19 <"$root/helper-prompt"
TMUX_REMOTE_CONTROL_TEST_TMUX_FAIL=1 \
  expect_failure 'mock tmux socket unavailable' "${helper_command[@]}" --tmux-socket "$pi_socket" --tmux-server-pid 123 --target %19 <"$root/helper-prompt"
TMUX_REMOTE_CONTROL_TEST_BAD_IDENTITY=1 \
  expect_failure 'could not construct' "${helper_command[@]}" --tmux-socket "$pi_socket" --tmux-server-pid 123 --target %19 <"$root/helper-prompt"
[[ ! -e "$root/rpc-request" ]]
TMUX_REMOTE_CONTROL_TEST_RPC_FAIL=1 \
  expect_failure 'RPC acknowledgement timed out' "${helper_command[@]}" --tmux-socket "$pi_socket" --tmux-server-pid 123 --target %19 <"$root/helper-prompt"
rm -f "$root/rpc-request"
: >"$TMUX_REMOTE_CONTROL_TEST_TMUX_CALLS"
python3 - "$root/oversized-prompt" <<'PY'
import pathlib, sys
pathlib.Path(sys.argv[1]).write_bytes(b"x" * (1024 * 1024 + 1))
PY
expect_failure '1 MiB stdin limit' "${helper_command[@]}" --tmux-socket "$pi_socket" --tmux-server-pid 123 --target %19 <"$root/oversized-prompt"
[[ ! -s "$TMUX_REMOTE_CONTROL_TEST_TMUX_CALLS" && ! -e "$root/rpc-request" ]]
printf '\377' >"$root/invalid-utf8"
expect_failure 'not valid UTF-8' "${helper_command[@]}" --tmux-socket "$pi_socket" --tmux-server-pid 123 --target %19 <"$root/invalid-utf8"
[[ ! -s "$TMUX_REMOTE_CONTROL_TEST_TMUX_CALLS" && ! -e "$root/rpc-request" ]]

# Exercise focus following against tmux itself. Start on one window, switch to
# another in the editor, and verify that input reaches only the new window.
# Sandboxes can provide the tmux binary while denying every new Unix-socket
# connection, so probe that capability without leaving a tmux server behind.
can_connect_local_unix_socket() {
  python3 - "$root/unix-socket-probe" <<'PY'
import os
import socket
import sys

path = sys.argv[1]
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    server.bind(path)
    server.listen(1)
    client.connect(path)
finally:
    client.close()
    server.close()
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
PY
}

if command -v tmux >/dev/null 2>&1 && can_connect_local_unix_socket 2>/dev/null; then
  cat >"$root/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
previous=""
for argument in "$@"; do
  if [[ "$previous" == "-O" && "$argument" == "exit" ]]; then
    exit 0
  fi
  previous="$argument"
done
if command -v fish >/dev/null 2>&1; then
  fish -c "${!#}"
else
  /bin/sh -c "${!#}"
fi
SH
  cat >"$root/bin/editor" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
tmux select-window -t "$TMUX_REMOTE_CONTROL_TEST_DESTINATION"
tmux select-pane -t "$TMUX_REMOTE_CONTROL_TEST_DESTINATION"
printf 'focus-followed\n' >"$1"
SH
  chmod +x "$root/bin/ssh" "$root/bin/editor"

  test_tmux_socket="tmux-remote-control-test-$$"
  # These test pane programs are POSIX shell snippets, even when the account's
  # default shell is Fish (the SSH mock still exercises that login shell).
  tmux -L "$test_tmux_socket" -f /dev/null new-session -d -s "test session" -n first \
    /bin/sh -c "IFS= read -r line; printf '%s' \"\$line\" >'$root/pane-first'"
  tmux -L "$test_tmux_socket" new-window -d -t "test session:" -n second \
    /bin/sh -c "IFS= read -r line; printf '%s' \"\$line\" >'$root/pane-second'"
  launcher_pane="$(tmux -L "$test_tmux_socket" display-message -p -t 'test session:first' '#{pane_id}')"
  destination="$(tmux -L "$test_tmux_socket" display-message -p -t 'test session:second' '#{pane_id}')"
  socket_path="$(tmux -L "$test_tmux_socket" display-message -p -t 'test session' '#{socket_path}')"
  tmux -L "$test_tmux_socket" select-window -t "test session:first"

  TMUX="$socket_path,0,0" TMUX_PANE="$launcher_pane" \
    "$script" devbox >"$root/launcher-output"
  [[ "$(tmux -L "$test_tmux_socket" show-buffer)" == \
    "tmux-remote-control attach devbox 'test session'" ]]
  grep -F "tmux-remote-control attach devbox 'test session'" "$root/launcher-output" >/dev/null

  TMUX="$socket_path,0,0" TMUX_REMOTE_CONTROL_TEST_DESTINATION="$destination" \
    "$script" attach example-host --editor --once >"$root/tmux-output"
  for _ in {1..50}; do
    [[ -f "$root/pane-second" ]] && break
    sleep 0.05
  done
  [[ ! -e "$root/pane-first" ]]
  [[ "$(cat "$root/pane-second")" == "focus-followed" ]]
  grep -F 'Submitted input to example-host session test session' "$root/tmux-output" >/dev/null
  if tmux -L "$test_tmux_socket" list-buffers -F '#{buffer_name}' | \
    grep -F 'tmux-remote-control-' >/dev/null; then
    echo "submission buffer was not removed" >&2
    exit 1
  fi

  tmux -L "$test_tmux_socket" kill-server 2>/dev/null || true
  test_tmux_socket=""
fi

printf 'tmux-remote-control tests passed\n'
