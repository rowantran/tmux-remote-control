#!/usr/bin/env bash
set -euo pipefail

: "${HOME:?HOME must be set}"

root="$(cd "$(dirname "$0")" && pwd)"
extensions_dir="$HOME/.pi/agent/extensions"
destination="$extensions_dir/tmux-remote-control.ts"

mkdir -p "$extensions_dir"
temporary="$(mktemp "$extensions_dir/.tmux-remote-control.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

cp "$root/pi-extension.ts" "$temporary"
chmod 0644 "$temporary"
mv -f "$temporary" "$destination"
trap - EXIT

printf 'Installed Pi extension at %s\nRun /reload in Pi to load it.\n' "$destination"
