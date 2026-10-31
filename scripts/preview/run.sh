#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
omarchy_root="${OMARCHY_PATH:-/usr/share/omarchy}"
command -v quickshell >/dev/null || { echo 'Preview requires Quickshell.' >&2; exit 1; }
[[ -n ${WAYLAND_DISPLAY:-} ]] || { echo 'Preview requires a Wayland session.' >&2; exit 1; }
for module in Ui Commons; do
  [[ -d "$omarchy_root/shell/$module" ]] || { echo "Missing Omarchy module: $omarchy_root/shell/$module" >&2; exit 1; }
done
preview_root="$(mktemp -d -t deepseek-preview.XXXXXXXX)"
preview_pid=''
cleanup() {
  if [[ -n "$preview_pid" ]]; then
    kill "$preview_pid" 2>/dev/null || true
    wait "$preview_pid" 2>/dev/null || true
  fi
  rm -rf -- "$preview_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$preview_root/Plugin"
# Expose only UI and pure libraries: Service.qml is intentionally absent.
for file in BarWidget.qml Panel.qml assets lib; do
  ln -s "$repo_root/$file" "$preview_root/Plugin/$file"
done
for module in Ui Commons; do
  ln -s "$omarchy_root/shell/$module" "$preview_root/$module"
done
cp "$repo_root/scripts/preview/shell.qml" "$preview_root/shell.qml"
cp "$repo_root/scripts/preview/Fixtures.js" "$preview_root/Fixtures.js"
echo 'SIMULATED preview. Use its Theme / State / Time buttons; Ctrl+C stops only this instance.'
printf 'IPC example: quickshell ipc -p %q call preview scenario missing\n' "$preview_root/shell.qml"
env -u DEEPSEEK_API_KEY quickshell -p "$preview_root/shell.qml" &
preview_pid=$!
wait "$preview_pid"
