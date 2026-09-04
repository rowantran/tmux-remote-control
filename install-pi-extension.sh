#!/usr/bin/env bash
set -euo pipefail

: "${HOME:?HOME must be set}"

root="$(cd "$(dirname "$0")" && pwd)"
extensions_dir="$HOME/.pi/agent/extensions"
destination="$extensions_dir/tmux-remote-control"

# Keep the extension and its transport together so the installation does not
# depend on the repository staying at the same path.
mkdir -p "$destination/lib"
temporary="$(mktemp "$destination/.install.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
cp "$root/lib/pi-remote.cjs" "$temporary"
chmod 0644 "$temporary"
mv -f "$temporary" "$destination/lib/pi-remote.cjs"
temporary="$(mktemp "$destination/.install.XXXXXX")"
cp "$root/pi-extension.ts" "$temporary"
chmod 0644 "$temporary"
mv -f "$temporary" "$destination/index.ts"
# Remove the old discovery entry only after both new files are installed.
# rm unlinks legacy symlinks; it does not overwrite their targets.
rm -f "$extensions_dir/tmux-remote-control.ts"
trap - EXIT

printf 'Installed Pi extension at %s/index.ts\nRun /reload in Pi to load it.\n' "$destination"
