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

Repeatable fixture preview is now available via `scripts/preview/run.sh`;
see [manual acceptance instructions](scripts/preview/README.md). It exposes the
actual UI with a synthetic service and process-local palettes. Production
runtime/notification acceptance boundaries above still apply.

Quotatank-inspired reliability follow-up:

- The panel now shows a full local reading date and age; at 10 minutes it marks
  the reading old (two normal balance polls), and a future timestamp identifies
  a clock mismatch. No values or shared service/CLI state are rewritten.
- Error-specific recovery hints cover optional setup, malformed key files,
  connectivity, 401/403 and 429. No credentials or raw response data are shown.
- Mouse and keyboard balance activation share one busy/no-service guard;
  shortcuts are listed in the panel footer. R/middle-click retain full refresh.
- Pure tests cover the exact age threshold, future/missing timestamps, recovery
  hints and the actual panel refresh function with busy/absent services.
  Four existing suites now pass 28 + 27 + 24 + 14 = 93 checks, plus the preview
  checks. Host QML, manifest, whitespace and JS syntax checks pass.
- A real isolated Wayland preview loaded the actual panel with synthetic data;
  old light-palette readings and dark 429 guidance were visually inspected.
  All added scenarios accepted IPC switching without QML exceptions. This is
  fixture rendering and action-function validation, not physical input or live
  API/desktop notification acceptance. Preview stopped and temporary files
  cleaned after validation; production shell untouched.

Design ideas only were borrowed from Quotatank's old-reading and recovery
feedback; no reference implementation or resource was copied.

Keyboard/accessibility follow-up: see REFERENCE-REVIEW.md for the comparison,
layout-timing failure and host recheck. Keyboard action selection now scrolls into
view after Column positioning, and row names expose expansion/notification state;
busy/absent-service controls are disabled. Physical key and screen-reader delivery
remain manual checks; the isolated probe exercised actual QML methods/properties.

PR review corrections (comments 4431599802 and 4431599805):

- readingInfo now tolerates up to 1000 ms between the sampled service clock
  and an immediately completed balance result. Negative ages within that
  interval render just now; a lead of 1001 ms still flags a clock mismatch.
  Regression checks include 1, 100, 999 and 1000 ms leads, the real rollback
  boundary, and the existing ten-minute old-reading boundary. The new sampling
  cases failed on the reviewed code and pass with the correction.
- Removed the unconditional positioningComplete reveal. Only explicit keyboard
  navigation or timeline expansion schedules a one-shot reveal. Inner timeline
  and balance sections are laid out before the outer panel, rather than relying
  on repeated event-loop delays. Scrolling, Flickable movement or closing can
  cancel the request. Synthetic checks cover reveal, cancellation, closing and
  a later background layout with no pending request.
- A temporary isolated actual QML probe used a 328-pixel viewport and synthetic
  data. The reviewed Panel.qml moved a manually positioned viewport from 300
  to 254 after a balance-state update. The fixed panel kept it at 300, preserved
  an explicit subsequent scroll to 310, and cancelled pending reveal when a
  Flickable movement started. Expanded keyboard navigation also kept the
  notification visible (top 648, height 38, contentY 358). The final probe passed
  twice, including after replaying the original failure. This exercises actual
  QML layout/functions/signals; it is not physical wheel/key acceptance.
