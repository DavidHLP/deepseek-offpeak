# Quotatank comparison and scoped improvements

Repository identity verified before editing: `/home/david/Projects/deepseek-offpeak`,
origin `git@github.com:DavidHLP/deepseek-offpeak.git`, clean UI branch
`codex/refine-offpeak-ui` at `27fb91e`; PR #6 remains draft. No other checkout,
production shell configuration, key file, or marketplace entry was changed.

Reference inspected at `JanitorHead/omarchy-quotatank` commit
`f38f91f4a6386247236a5e3367429c10a501fc11`: README, development/contribution
instructions, Panel/UsageNavigation and accessibility code, tests/run and fixture
layout, license and states screenshot. These establish source intent and test
entrypoints, not a claim that the reference suite passes locally. Both projects
are MIT. No reference code or assets were copied.

| Reference approach and source | Current DeepSeek behavior / gap | Value, cost and decision |
| --- | --- | --- |
| [Reading age and recovery explanations](https://github.com/JanitorHead/omarchy-quotatank/blob/f38f91f4a6386247236a5e3367429c10a501fc11/README.md) | Already implemented reading date/age, old/future markers and error hints in Balance.js/Panel.qml; tested | Preserve. No repeated implementation or new credential/network behavior. |
| [Reveal selected items after layout](https://github.com/JanitorHead/omarchy-quotatank/blob/f38f91f4a6386247236a5e3367429c10a501fc11/Panel.qml) | moveCursor changed an index without scrolling; expanded timeline can push notification offscreen | Implement minimal scroll-to-selected action using existing Flickable. No dependency or state contract change. Layout timing needs host validation. |
| [Accessible bar/control names](https://github.com/JanitorHead/omarchy-quotatank/blob/f38f91f4a6386247236a5e3367429c10a501fc11/Panel.qml) | Action rows had names but omitted toggle/expansion state; busy/absent actions looked actionable | Add expanded/collapsed, on/off/unavailable names and actual disabled state. Low cost; assistive-reader delivery still needs manual acceptance. |
| [Isolated fixture UI checks](https://github.com/JanitorHead/omarchy-quotatank/blob/f38f91f4a6386247236a5e3367429c10a501fc11/docs/development.md) | Already has preview/run.sh and fixture checks in CI; static QML is advisory | Extend existing checks and host probe, not another framework. Host timing remains outside portable Node CI. |
| [Literal external text and bounded collectors](https://github.com/JanitorHead/omarchy-quotatank/blob/f38f91f4a6386247236a5e3367429c10a501fc11/docs/development.md) | Shared parsers bound data, key and curl argv are constrained, external text uses PlainText, marketplace regression checks exist | Preserve existing implementation/tests. No new parser, collector, wrapper or dependency. |
| [Theme palette and motion](https://github.com/JanitorHead/omarchy-quotatank/blob/f38f91f4a6386247236a5e3367429c10a501fc11/README.md) | Native Omarchy Style/Border/Commons colors and fixture palettes already present | Preserve. No decorative animation; full installed-theme/four-edge validation deferred to desktop acceptance. |
| [Many accounts, remote sources and cost projections](https://github.com/JanitorHead/omarchy-quotatank/blob/f38f91f4a6386247236a5e3367429c10a501fc11/docs/development.md) | Single DeepSeek local schedule plus optional balance | Do not adopt: changes product scope and adds secrets, connections, data retention and maintenance. |

## Acceptance and evidence

1. Keyboard selection reveals the entire action when below or above the viewport;
   already-visible actions do not jump. Actual revealCursor code is evaluated
   in existing preview.test.js against synthetic geometry, including a fully
   fitting viewport. This is logic verification, not Qt layout verification.
2. An isolated real Omarchy/Wayland panel with synthetic service was probed using
   a temporary copy of Panel.qml with test-only aliases. Expanding the timeline
   initially failed: notification top 648, height 38, viewport 528, contentY 21.
   The earlier positioningComplete-based fix passed that probe: contentY
   158, full notification visible; wrapping to timeline also reported visible.
   No keys or network requests were involved. The probe called the actual
   navigation functions, not physical key input.
3. The same host probe read actual Accessible.name values before/after activation:
   notification `on`, `off`, and service-absent `unavailable`; busy balance and
   absent-service balance/notification rows reported enabled=false. This does
   not establish what a screen reader announces.
4. Existing schedule, holiday, balance and status suites pass 28 + 27 + 24 + 14
   checks (schedule uses TZ=UTC), plus extended preview checks. Host QML,
   manifest, syntax and whitespace checks pass. Existing PR CI runs preview
   tests in the blocking Node job. Release gates remain unchanged.

No actual paid request, live cache change, notification delivery, production
keyboard/reader acceptance or full installed-theme cycle was performed. Preview
and probe processes/temp directories were cleaned; production shell retained.
The host portal registration warning remains unrelated to these UI changes.

The earlier global positioningComplete hook was superseded during PR review:
explicit navigation/expansion now queues one cancellable reveal, settles inner
sections before the outer Column, and consumes the request. Background data
layouts no longer scroll to a stale cursor. See UI-VALIDATION.md for the
manual-scroll regression and before/after host probe.
