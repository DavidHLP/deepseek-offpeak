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

Follow-up acceptance on 2026-10-31:

- The actual BarWidget.qml was rendered in an isolated Wayland PanelWindow
  using the host WidgetButton, not a replacement button. QtTest mouse events
  at its center reported LEFT_OPEN true, MIDDLE_REFRESH 1 CLOSED true and
  REOPEN true. These exercise Qt mouse dispatch and the actual popup loader;
  they are not physical input to the production shell.
- The preview instance's in-memory Commons palette and shellValues were changed
  to a light foreground/background/accent/urgent palette. No theme files or
  system settings changed. The actual panel was visually inspected with long
  decimal balance text, missing-key, loading, unavailable, network-error and
  empty holiday coverage fixtures. Text remained readable and within the card.
  This is a light-palette check, not installation of a complete Omarchy theme.
- Refreshing with a prior balance now explicitly says Previous data while
  updating; the old figure and Updating balance message were visually checked
  together. Service absence now has a waiting message, and an empty holiday
  year list says none. No service or billing behavior changed.
- Repeated host QML, manifest, diff whitespace and all 90 Node checks pass
  (schedule under TZ=UTC). The original PR head's five GitHub checks passed.
- With a complete mock bar contract, the previous undefined barForeground
  warning is absent; the host portal registration warning remains.

Remaining limits: no physical production bar/middle-click or keyboard focus
acceptance, full installed light theme, vertical bar, UI boundary transitions,
real notification delivery or age-driven holiday scenarios. Native desktop
control is disabled in this tool environment. Loading this checkout into the
production bar would require replacing/reloading its installed plugin, outside
this follow-up's no-system-configuration boundary. All additional rendering
used fixtures and the real host QML; no live balance request was sent. The
service exposes covered years, not a reliable fetch-age field, so the panel
explicitly does not claim holiday freshness. Pure schedule/balance tests do not
substitute for these remaining desktop checks.

No user system configuration or live shell instance was restarted or modified.
