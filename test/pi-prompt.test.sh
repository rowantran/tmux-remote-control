#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d /tmp/pi-prompt-test.XXXXXX)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin"

cat >"$root/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
command="${3:-}"
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
printf 'first line\nsecond line\n' >"$1"
SH
chmod +x "$root/bin/editor"

export PATH="$root/bin:$PATH"
export PI_PROMPT_EDITOR="$root/bin/editor"
export PI_PROMPT_TEST_COMMAND="$root/command"
export PI_PROMPT_TEST_INPUT="$root/input"

"$(dirname "$0")/../bin/pi-prompt" example-host %7 >"$root/output"

grep -F "paste-buffer -p -r -d" "$root/command" >/dev/null
grep -F -- "-t '%7'" "$root/command" >/dev/null
[[ "$(cat "$root/input")" == $'first line\nsecond line' ]]
grep -F "Submitted prompt to example-host:%7" "$root/output" >/dev/null

list_output="$("$(dirname "$0")/../bin/pi-prompt" example-host --list)"
[[ "$list_output" == *"%7"* ]]
[[ "$list_output" == *"work:0.0"* ]]

printf 'pi-prompt tests passed\n'
