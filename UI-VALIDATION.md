# UI refinement validation

The design borrows Quotatank's grouped surfaces, prominent headline figure,
secondary metadata and theme control borders. No reference code or assets were
copied (reference license: MIT). DeepSeek remains a single-service schedule tool.

Preserved: shared service/CLI clock, schedule and holiday math, timeline expansion,
left-click popup and middle-click refresh routes, keyboard navigation, R refresh,
E expansion, balance refresh, session notification setting, network and key handling.
Only Panel.qml and BarWidget.qml runtime files change.

Checks on 2026-10-31:

- Node 26.7.0: schedule 28, holidays 26, balance 22, status 14 checks pass with
  `TZ=UTC` for schedule (the same timezone as CI). Default host timezone fails
  the existing assertion at schedule.test.js:219: a local day intersects three
  UTC windows instead of two. No math or assertions changed.
- Manifest validation, host `scripts/ci/validate-qml.sh`, and diff whitespace pass.
- A separate Quickshell instance loaded the real host Ui/Commons and actual
  plugin panel on Wayland with an isolated mock service, without creating the
  production Service, reading keys or sending balance requests. Peak with a
  balance was visually inspected. This exposed a QtQuick Color name collision;
  plugin color references now explicitly use the Commons namespace.
- A second 1.25 scale run loaded off-peak/error and expanded timeline fixtures.
  The mock exercised the panel's timeline, balance-refresh and notification
  activation handlers with assertions. This is handler validation, not mouse or
  keyboard input acceptance. Host Panel.qml still reports an undefined QColor
  for its barForeground property, and the portal logs a registration warning.

Outstanding acceptance: production bar click/middle-click, vertical bar layout,
real keyboard focus/scroll operation, switch-boundary UI transition, missing-key,
loading and unavailable balance UI, full light-theme adaptation, long money text,
and missing/stale holiday UI scenarios. Existing pure tests cover schedule
boundaries and balance failures but do not prove these desktop interactions.
Holiday UI explicitly identifies cached/built-in coverage and unverified freshness;
the service exposes covered years, not a reliable last-fetch age.

No user system configuration or live shell instance was restarted or modified.
