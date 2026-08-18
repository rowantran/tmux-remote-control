#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d /tmp/pi-prompt-test.XXXXXX)"
trap 'rm -rf "$root"' EXIT
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
if [[ -n "${PI_PROMPT_TEST_SSH_ARGS:-}" ]]; then
  printf '%s\n' "$@" >"$PI_PROMPT_TEST_SSH_ARGS"
fi
command="${!#}"
if [[ "$command" == *"list-panes"* ]]; then
  printf '%%7|1|work:0.0|node|pi - project\n'
  exit 0
fi
printf '%s\n' "$command" >"$PI_PROMPT_TEST_COMMAND"
cat >"$PI_PROMPT_TEST_INPUT"
SH
chmod +x "$root/bin/ssh"

cat >"$root/bin/editor" <<'SH'
#!/usr/bin/env bash
if [[ -n "${PI_PROMPT_TEST_EDITOR_INITIAL:-}" ]]; then
  cat "$1" >"$PI_PROMPT_TEST_EDITOR_INITIAL"
fi
printf 'first line\nsecond line\n' >"$1"
SH
chmod +x "$root/bin/editor"

export PATH="$root/bin:$PATH"
export PI_PROMPT_EDITOR="$root/bin/editor"
export PI_PROMPT_TEST_COMMAND="$root/command"
export PI_PROMPT_TEST_INPUT="$root/input"
export PI_PROMPT_TEST_SSH_ARGS="$root/ssh-args"

script="$(cd "$(dirname "$0")/.." && pwd)/bin/pi-prompt"
"$script" example-host %7 --editor >"$root/output"

grep -F "paste-buffer -p -r -d" "$root/command" >/dev/null
grep -F -- "-t '%7'" "$root/command" >/dev/null
[[ "$(cat "$root/input")" == $'first line\nsecond line' ]]
grep -F "Submitted prompt to example-host:%7" "$root/output" >/dev/null
grep -F "ControlMaster=auto" "$root/ssh-args" >/dev/null
grep -F "ControlPersist=10m" "$root/ssh-args" >/dev/null
grep -F "ControlPath=" "$root/ssh-args" >/dev/null

run_in_pty() {
  PI_PROMPT_TEST_KEYS="$1" python3 - "$script" <<'PY'
import os
import pty
import select
import signal
import sys
import time

script = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execve(script, [script, "example-host", "%7"], os.environ)

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
            os.write(fd, bytes.fromhex(os.environ["PI_PROMPT_TEST_KEYS"]))
            sent = True
    finished, status = os.waitpid(pid, os.WNOHANG)
    if finished:
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            sys.stderr.buffer.write(output)
            raise SystemExit("pi-prompt exited unsuccessfully")
        break
else:
    os.kill(pid, signal.SIGKILL)
    sys.stderr.buffer.write(output)
    raise SystemExit("timed out waiting for pi-prompt")

if not sent:
    sys.stderr.buffer.write(output)
    raise SystemExit("inline prompt was not displayed")
if b"\x1b[1A\r\x1b[2K" not in output:
    sys.stderr.buffer.write(output)
    raise SystemExit("submitted inline prompt was not cleared")
PY
}

# Default mode accepts a zero-latency inline line.
run_in_pty "68656c6c6f0a"
[[ "$(cat "$root/input")" == "hello" ]]

# Ctrl-G opens the editor with the current inline draft.
export PI_PROMPT_TEST_EDITOR_INITIAL="$root/editor-initial"
run_in_pty "647261667407"
[[ "$(cat "$root/editor-initial")" == "draft" ]]
[[ "$(cat "$root/input")" == $'first line\nsecond line' ]]
unset PI_PROMPT_TEST_EDITOR_INITIAL

list_output="$("$script" example-host --list)"
[[ "$list_output" == *"%7"* ]]
[[ "$list_output" == *"work:0.0"* ]]

printf 'pi-prompt tests passed\n'
