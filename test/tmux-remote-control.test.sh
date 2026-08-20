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
if [[ "$command" == "tmux resize-pane "* || "$command" == "tmux select-pane "* || "$command" == "tmux select-window "* ]]; then
  printf '%s\n' "$command" >>"$TMUX_REMOTE_CONTROL_TEST_NAVIGATION_COMMANDS"
  exit 0
fi
printf '%s\n' "$command" >"$TMUX_REMOTE_CONTROL_TEST_COMMAND"
cat >"$TMUX_REMOTE_CONTROL_TEST_INPUT"
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

script="$(cd "$(dirname "$0")/.." && pwd)/bin/tmux-remote-control"

if TMUX_PANE= "$script" example-host >"$root/launcher-output" 2>"$root/launcher-error"; then
  echo "expected the remote launcher to require tmux" >&2
  exit 1
fi
grep -F 'run the launcher inside tmux' "$root/launcher-error" >/dev/null

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
  TMUX_REMOTE_CONTROL_TEST_KEYS="$1" python3 - "$script" <<'PY'
import os
import pty
import select
import signal
import sys
import time

script = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execve(script, [script, "attach", "example-host", "--session", "%7", "--once"], os.environ)

output = bytearray()
deadline = time.monotonic() + 10
sent = False
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
        if not sent and b"> " in output:
            os.write(fd, bytes.fromhex(os.environ["TMUX_REMOTE_CONTROL_TEST_KEYS"]))
            sent = True
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

if not sent:
    sys.stderr.buffer.write(output)
    raise SystemExit("inline prompt was not displayed")
if b"\x1b[1A\r\x1b[2K" not in output:
    sys.stderr.buffer.write(output)
    raise SystemExit("submitted inline prompt was not cleared")
if b"\x1b[>1u" not in output or b"\x1b[<u" not in output:
    sys.stderr.buffer.write(output)
    raise SystemExit("extended keyboard mode was not enabled and restored")
PY
}

run_in_pty "68656c6c6f0a"
[[ "$(cat "$root/input")" == "hello" ]]

export TMUX_REMOTE_CONTROL_TEST_EDITOR_INITIAL="$root/editor-initial"
run_in_pty "647261667407"
[[ "$(cat "$root/editor-initial")" == "draft" ]]
[[ "$(cat "$root/input")" == $'first line\nsecond line' ]]
unset TMUX_REMOTE_CONTROL_TEST_EDITOR_INITIAL

# Extended keyboard reporting preserves standard Readline Ctrl and Alt editing.
run_in_pty "776f726c641b5b39373b357568656c6c6f200d"
[[ "$(cat "$root/input")" == "hello world" ]]
run_in_pty "68656c6c6f20776f726c641b5b39383b3375626967200d"
[[ "$(cat "$root/input")" == "hello big world" ]]

# Navigation and zoom shortcuts run remote tmux commands without submitting the
# draft. CSI-u keeps Ctrl-J and Ctrl-number distinct from Enter and other keys.
navigation_keys="$(python3 - <<'PY'
keys = "fhjklpn0123456789"
print(b"".join(f"\x1b[{ord(key)};5u".encode() for key in keys).hex())
PY
)"
: >"$TMUX_REMOTE_CONTROL_TEST_NAVIGATION_COMMANDS"
run_in_pty "6b6565702074686973206472616674${navigation_keys}0d"
[[ "$(cat "$root/input")" == "keep this draft" ]]
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

# Exercise focus following against tmux itself. Start on one window, switch to
# another in the editor, and verify that input reaches only the new window.
if command -v tmux >/dev/null 2>&1; then
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
  tmux -L "$test_tmux_socket" -f /dev/null new-session -d -s "test session" -n first \
    "IFS= read -r line; printf '%s' \"\$line\" >'$root/pane-first'"
  tmux -L "$test_tmux_socket" new-window -d -t "test session:" -n second \
    "IFS= read -r line; printf '%s' \"\$line\" >'$root/pane-second'"
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
