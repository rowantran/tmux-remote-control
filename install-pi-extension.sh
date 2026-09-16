#!/usr/bin/env bash
set -euo pipefail

: "${HOME:?HOME must be set}"

root="$(cd "$(dirname "$0")" && pwd)"
extensions_dir="$HOME/.pi/agent/extensions"
destination="$extensions_dir/tmux-remote-control.ts"
support_dir="$extensions_dir/tmux-remote-control"
config_loader="$support_dir/config.mjs"

mkdir -p "$extensions_dir"
# The reverted RPC installer used this support directory as an extension entry.
# Keep unrelated contents, but remove its old entry point so Pi loads only the
# top-level extension. Never follow an old symlink while installing support code.
if [[ -L "$support_dir" || ( -e "$support_dir" && ! -d "$support_dir" ) ]]; then
  rm -f "$support_dir"
fi
mkdir -p "$support_dir"
rm -f "$support_dir/index.ts"

temporary="$(mktemp "$extensions_dir/.tmux-remote-control.XXXXXX")"
config_temporary="$(mktemp "$support_dir/.config.XXXXXX")"
trap 'rm -f "$temporary" "$config_temporary"' EXIT

cp "$root/pi-extension.ts" "$temporary"
cp "$root/tmux-remote-control/config.mjs" "$config_temporary"
chmod 0644 "$temporary" "$config_temporary"
# Install the dependency first so a concurrently starting Pi never sees an
# extension whose config loader is missing.
mv -f "$config_temporary" "$config_loader"
mv -f "$temporary" "$destination"
trap - EXIT

printf 'Installed Pi extension at %s\nRun /reload in Pi to load it.\n' "$destination"
