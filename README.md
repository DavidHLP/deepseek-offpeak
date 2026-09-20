# DeepSeek Off-Peak

An [Omarchy](https://omarchy.org) plugin that shows DeepSeek's peak/off-peak
billing state, counts down to the next change, optionally reads your account
balance, and notifies you when off-peak starts.

The schedule is computed **locally** from DeepSeek's published UTC timetable and
the Chinese public holidays it excludes. It never infers billing state from
server load or API availability, so the countdown is correct even when
`api.deepseek.com` is unreachable — and the holiday dates come from a cache the
shell and the CLI share, with last year's arrangement still scheduling the plugin
when nothing can be fetched.

## The schedule

Peak hours are weekdays **01:00–04:00** and **06:00–10:00 UTC** — DeepSeek
publishes the timetable in Beijing time, where those windows are 09:00–12:00 and
14:00–18:00. Every other instant is off-peak; Saturday and Sunday are off-peak
all day; and so is a **Chinese public holiday**, whichever day of the week it
falls on.

Windows are half-open — `[01:00, 04:00)` — so a boundary instant belongs to the
window that starts there: 04:00 is off-peak, 06:00 is peak, 10:00 is off-peak.

This timetable is the whole of the billing math. It lives in `lib/Schedule.js`,
which is pure and I/O-free: every function takes the instant it should reason
about and the holiday table it should consult, so nothing reads the clock
implicitly and nothing reaches for the network.

## Chinese public holidays

DeepSeek's own words: peak is 北京时间周一至周五（不含中国法定节假日）
9:00-12:00、14:00-18:00, and 其余时段，包括周末及中国法定节假日全天均为空闲时段.
Two consequences, and this plugin had neither:

- a Chinese public holiday that falls on a Monday to Friday has **no peak
  windows at all**, where the weekday rule alone would schedule two;
- the weekends the State Council designates as make-up workdays
  (调休上班的周末) are billed off-peak as well — which is what a weekend already
  is here, so those dates change nothing and are not stored.

The dates are **fetched and cached**, not guessed. `lib/Holidays.js` names the
source — [holiday-cn](https://github.com/NateScarlet/holiday-cn), a
machine-readable transcription of 国务院办公厅's annual 部分节假日安排通知 that
carries the paper it came from — and the cache lives at
`$XDG_CACHE_HOME/deepseek-offpeak-holidays-<year>.json` (so `~/.cache/…` unless
that variable says otherwise). The shell reads the cache at startup and refreshes
it weekly; the CLI reads the same cache and fetches only when it is missing or a
week old, so `deepseek-offpeak status` on a warm cache makes no request for it. A
year whose arrangement is not published yet — the notice comes out in early
November — is not asked for until 60 days before it starts, rather than 404ing
once a week all year.

**Nothing about this can break the schedule.** A cache that is missing,
unreadable, oversized, stale, or not the documented shape is skipped, a fetch
that fails leaves the table exactly as it was, and a year with no data at all
falls back to the weekday rule — which is what the plugin did before any of this
existed. The offline floor is the 2026 notice baked into `lib/Holidays.js`, and
the schedule sentence the panel and the CLI print names the years the table
covers, which is the visible sign the fetched data is being read at all.

Fetched names are display text, so they are parsed strictly: a name with a
control character in it, a date that does not exist, or a document that strays
outside the year it declares rejects the whole document rather than half of it.

## Install

```sh
omarchy plugin add https://github.com/DavidHLP/deepseek-offpeak.git --enable
```

Omarchy clones the repository, validates the manifest, and only then installs
and enables the plugin. To install by hand, drop the directory into
`~/.config/omarchy/plugins/deepseek-offpeak` instead.

Add the bar widget from the bar's widget picker — it registers as **DeepSeek**
in the **System** category. Clicking it opens the panel; a middle click
re-reads the schedule and the balance immediately instead of waiting for the
next poll.

## Remove

```sh
omarchy plugin remove deepseek-offpeak
```

## The balance (optional)

The balance is the only part that talks to DeepSeek, and it is strictly additive
— every failure path leaves the schedule untouched. (The holiday table is the
plugin's other network call; it goes to a static CDN and is described above.) The
key is read from two places, in this order:

1. **the environment**, `DEEPSEEK_API_KEY`;
2. **the key file**, `~/.config/deepseek-offpeak/key`, as a fallback.

```sh
umask 077
printf '%s\n' 'sk-your-key' > ~/.config/deepseek-offpeak/key
```

Nothing is sourced or executed to find it. The file is read and parsed, and the
parse is strict: one line, the documented `sk-…` shape, at most 256 bytes.
Anything else — two lines, a comment, a shell assignment, a quoted value — is
reported as `invalid_api_key_file` rather than guessed at.

**The file is the setup to prefer.** An environment variable is inherited by
every process the session starts — terminals, editors, browsers — while a
mode-600 file is readable only by what goes looking for it.

`~/.bashrc` is not a place either of them can come from: the shell is started by
Hyprland, not by a terminal, so an export there reaches your terminals and never
the bar. (The plugin used to run `bash -ic` to read it. It no longer does: that
is the widget executing your startup files as code.)

If you would rather keep the key in the environment, put it where the session
gets its environment — `~/.config/hypr/env.lua`:

```lua
hl.env("DEEPSEEK_API_KEY", "sk-…")
```

loaded from `~/.config/hypr/hyprland.lua` *before* the autostart line:

```lua
require("hypr.env")
require("hypr.autostart")
```

Then `hyprctl reload` and `omarchy restart shell`. (`hyprctl setenv` does not
exist in every Hyprland build — check `hyprctl setenv FOO bar` before relying on
it. `~/.config/environment.d/` works too, but only after a fresh login.)

Money stays a string end to end. The API sends decimals like `"110.00"`, and
parsing them into floats only to re-print them invents rounding.

Failures are reported one line at a time, never swallowed:

| Error | Meaning |
| --- | --- |
| `missing_api_key` | no key in the environment and no key file |
| `invalid_api_key_file` | a key file exists but is not one `sk-…` line |
| `network_error` | curl failed — DNS, connect, TLS, or the 10s timeout |
| `http_<code>` | the request completed with a non-200 status |
| `invalid_response` | a 200 that is not the documented JSON shape |

The key is never passed as an argument. It travels in the request's environment
and curl expands it into the header (`--variable %DEEPSEEK_API_KEY`,
`--expand-header`), so `ps` shows the variable's name and no value. The request
*is* curl — no shell, no pipeline, named by absolute path — capped at 16 KiB and
at 16 currencies with short codes and short amounts, and killed outright if it
outlives 15 seconds. A balance readout should not be able to spend the shell's
memory or its patience, and a process tree is a thing to have only when it earns
its keep.

## CLI

```
deepseek-offpeak status [--json]   current state, countdown, and balance
deepseek-offpeak refresh           re-query the balance and print the status
```

The CLI runs as plain `node` with no shell present, and answers from the same
modules the bar and panel render — so it cannot disagree with the widget. The
project uses Node.js **26.7.0** locally and in CI. Install that exact version
before running the checks below.

## Tests

```sh
node tests/schedule.test.js
node tests/holidays.test.js
node tests/balance.test.js
node tests/status.test.js
```

No dependencies — each file is a plain node script that exits non-zero on
failure. `schedule.test.js` pins instants in UTC and asserts the state, the
boundaries, and the countdown, with the four boundary times (04:00, 10:00,
01:00, 06:00), the weekend cases, and the holiday runs covered explicitly —
including the Spring Festival stretch, which is longer than any fixed horizon and
is the case a walked one exists for. `holidays.test.js` checks the baked table
against the notice it was transcribed from and the parse against the shapes a
broken or hostile document can take. `balance.test.js` and `status.test.js` cover
the failure paths without a network.

For an optional host-only QML import/parser smoke check, run:

```sh
scripts/ci/validate-qml.sh
```

It requires Omarchy (`OMARCHY_PATH`) and Quickshell, and locates `qmllint` at
`/usr/lib/qt6/bin/qmllint` when it is not on `PATH`. Without those host modules
it reports that the check was skipped. This is not full runtime validation:
imports, inherited host types, injected properties, and runtime behavior are
outside this check. CI runs it as an advisory job; it is intentionally outside
the required `ci-ok` gate. Tagged releases run the same best-effort command
during validation.

Tagged releases use `vMAJOR.MINOR.PATCH` (for example `v0.1.0`) and require the
tag to match `manifest.json`'s semantic version. Push the tag to run the
release workflow; it validates the tagged contents, creates a draft release,
and publishes it only after validation succeeds.

| Path | Role |
| --- | --- |
| `Service.qml` | the single clock — one instance serves the bar, the panel, and the CLI |
| `BarWidget.qml` | the bar widget |
| `Panel.qml` | the popup, including the day timeline and the notification switch |
| `lib/Schedule.js` | the billing-window math; pure and I/O-free |
| `lib/Holidays.js` | the Chinese holiday table: source, cache, parse, and the baked fallback |
| `lib/Balance.js` | `/user/balance` response handling and key resolution |
| `lib/Status.js` | the status report, formatted once for both consumers |
| `bin/deepseek-offpeak` | the CLI |
| `tests/*.test.js` | self-checks — `node tests/schedule.test.js` |

Nothing in the plugin holds schedule state of its own: the bar, the panel, and
the CLI all read the service, and the service reads `lib/Schedule.js`. That is
what keeps the countdown they show from drifting apart.

## License

MIT
