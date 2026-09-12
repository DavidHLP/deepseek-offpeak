#!/usr/bin/env bash
set -euo pipefail

qmllint=""
if command -v qmllint >/dev/null 2>&1; then
  qmllint="$(command -v qmllint)"
elif [[ -x /usr/lib/qt6/bin/qmllint ]]; then
  qmllint=/usr/lib/qt6/bin/qmllint
fi

if [[ -z "$qmllint" ]]; then
  echo 'QML import/parser smoke check skipped: qmllint is unavailable'
  exit 0
fi
if [[ -z "${OMARCHY_PATH:-}" || ! -d "$OMARCHY_PATH/shell/Ui" || ! -d "$OMARCHY_PATH/shell/Commons" ]]; then
  echo 'QML import/parser smoke check skipped: Omarchy shell modules are unavailable'
  exit 0
fi
qml_root=""
for candidate in /usr/lib/qt6/qml /usr/lib/qt/qml; do
  if [[ -d "$candidate/Quickshell" ]]; then
    qml_root="$candidate"
    break
  fi
done
if [[ -z "$qml_root" ]]; then
  echo 'QML import/parser smoke check skipped: Quickshell modules are unavailable'
  exit 0
fi

imports="$(mktemp -d)"
trap 'rm -rf "$imports"' EXIT
mkdir -p "$imports/qs"
ln -s "$OMARCHY_PATH/shell/Ui" "$imports/qs/Ui"
ln -s "$OMARCHY_PATH/shell/Commons" "$imports/qs/Commons"

"$qmllint" \
  -I "$imports" \
  -I "$qml_root" \
  -I "$OMARCHY_PATH/shell" \
  --missing-property disable \
  --unqualified disable \
  --signal-handler-parameters disable \
  BarWidget.qml Panel.qml Service.qml
