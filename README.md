# DeepSeek Off-Peak

An [Omarchy](https://omarchy.org) plugin that shows DeepSeek's peak/off-peak
billing state, counts down to the next change, optionally reads your account
balance, and notifies you when off-peak starts.

The schedule is computed **locally** from DeepSeek's published UTC timetable.
It never infers billing state from server load or API availability, so the
countdown is correct even when `api.deepseek.com` is unreachable.

## The schedule

Peak hours are weekdays **01:00–04:00** and **06:00–10:00 UTC**. Every other
instant is off-peak, and Saturday and Sunday are off-peak all day.

Windows are half-open — `[01:00, 04:00)` — so a boundary instant belongs to the
window that starts there: 04:00 is off-peak, 06:00 is peak, 10:00 is off-peak.

This timetable is the whole of the billing math. It lives in `lib/Schedule.js`
and is pure and I/O-free: every function takes the instant it should reason
about, so nothing reads the clock implicitly.

## Install

```sh
omarchy plugin add https://github.com/DavidHLP/deepseek-offpeak.git --enable
```

Omarchy clones the repository, validates the manifest, and only then installs
and enables the plugin. To install by hand, drop the directory into
`~/.config/omarchy/plugins/david.deepseek-offpeak` instead.

Add the bar widget from the bar's widget picker — it registers as **DeepSeek**
in the **System** category. Clicking it opens the panel; a middle click
re-reads the schedule and the balance immediately instead of waiting for the
next poll.

## Remove

```sh
omarchy plugin remove david.deepseek-offpeak
```

## The balance (optional)

The balance is the only part that touches the network, and it is strictly
additive — every failure path leaves the schedule untouched. Set
`DEEPSEEK_API_KEY` in your environment, or export it from `~/.bashrc`; the
plugin checks the environment first and your shell startup files second, since
a graphical session never sources `~/.bashrc`.

Money stays a string end to end. The API sends decimals like `"110.00"`, and
parsing them into floats only to re-print them invents rounding.

Failures are reported one line at a time, never swallowed:

| Error | Meaning |
| --- | --- |
| `missing_api_key` | no usable `DEEPSEEK_API_KEY` found |
| `network_error` | curl failed — DNS, connect, TLS, or the 10s timeout |
| `http_<code>` | the request completed with a non-200 status |
| `invalid_response` | a 200 that is not the documented JSON shape |

The key is never passed as an argument, so the command line is safe to show in
`ps`, and the shell lookup runs with `HISTFILE=/dev/null` so it cannot write to
your history.

## CLI

```
deepseek-offpeak status [--json]   current state, countdown, and balance
deepseek-offpeak refresh           re-query the balance and print the status
```

The CLI runs as plain `node` with no shell present, and answers from the same
modules the bar and panel render — so it cannot disagree with the widget.

## Layout

| Path | Role |
| --- | --- |
| `Service.qml` | the single clock — one instance serves the bar, the panel, and the CLI |
| `BarWidget.qml` | the bar widget |
| `Panel.qml` | the popup, including the day timeline and the notification switch |
| `lib/Schedule.js` | the billing-window math; pure and I/O-free |
| `lib/Balance.js` | `/user/balance` response handling and key resolution |
| `lib/Status.js` | the status report, formatted once for both consumers |
| `bin/deepseek-offpeak` | the CLI |
| `tests/*.test.js` | self-checks — `node tests/schedule.test.js` |

Nothing in the plugin holds schedule state of its own: the bar, the panel, and
the CLI all read the service, and the service reads `lib/Schedule.js`. That is
what keeps the countdown they show from drifting apart.

## Tests

```
node tests/schedule.test.js
node tests/balance.test.js
node tests/status.test.js
```

No dependencies — each file is a plain node script that exits non-zero on
failure. `schedule.test.js` pins instants in UTC and asserts the state, the
boundaries, and the countdown, with the four boundary times (04:00, 10:00,
01:00, 06:00) and the weekend cases covered explicitly. `balance.test.js` and
`status.test.js` cover the failure paths without a network.

## License

MIT
