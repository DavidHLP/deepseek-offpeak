// Self-check for the shared status formatter. Run: node tests/status.test.js
//
// This module is what makes the shell's IPC output and the CLI's output the
// same document, so the cases that matter are the ones where the two could
// silently diverge: a missing field, a failed balance, and the meaning of a
// name. Both consumers build the input object themselves, and the field names
// are the only contract between them — an earlier version had `nextSwitchUtc`
// hold a wall-clock string in one and an ISO instant in the other.

const assert = require("assert")
const Status = require("../lib/Status.js")
const Schedule = require("../lib/Schedule.js")

let checks = 0
function check(name, fn) {
  fn()
  checks++
}

// The exact object Service.qml and bin/deepseek-offpeak both build — and the
// reason this test can exist at all: both call this one function, so testing it
// once tests both paths.
const stateAt = (ms, notificationsEnabled) => Schedule.statusState(Schedule.stateAt(ms),
  { nowMs: ms, notificationsEnabled: notificationsEnabled === undefined ? null : notificationsEnabled })

const at = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h || 0, min || 0)
const good = { status: "ok", error: "", isAvailable: true, updatedAtMs: 1789047594592,
  balances: [{ currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00" }] }

check("a peak state renders as peak, with the countdown to off-peak", () => {
  const text = Status.text(stateAt(at(2026, 9, 9, 2, 30), true), good)
  assert.ok(text.includes("State:         Peak"), text)
  assert.ok(text.includes("Off-peak starts:"), "from peak, the next change is the off-peak start")
  assert.ok(/Remaining:\s+1h 30m/.test(text), text)
  assert.ok(/Remaining:\s+1h 30m \(1:30:00\)/.test(text), "the exact countdown too")
  assert.ok(text.includes("CNY 110.00 (granted 10.00, topped up 100.00)"), text)
})

check("an off-peak state names the upcoming peak start", () => {
  const text = Status.text(stateAt(at(2026, 9, 9, 4, 30), true), good)
  assert.ok(text.includes("State:         Off-peak"), text)
  assert.ok(text.includes("Peak starts:"), text)
})

check("every `*Utc` value in the JSON is an ISO instant, not a clock string", () => {
  const json = Status.object(stateAt(at(2026, 9, 9, 2, 30), true), good)
  for (const key of ["nowUtc", "nextSwitchUtc", "currentPeriodStartUtc",
    "nextOffPeakStartUtc", "offPeakEndUtc"]) {
    const value = json[key]
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),
      `${key} is not an ISO instant: ${value}`)
    assert.ok(!Number.isNaN(Date.parse(value)), `${key} does not parse: ${value}`)
  }
  // And the wall-clock siblings are exactly that, derivable from the instants.
  assert.ok(/^\d{2}:\d{2}$/.test(json.nowLocalClock), json.nowLocalClock)
  assert.ok(/^\d{2}:\d{2}$/.test(json.nextSwitchLocalClock), json.nextSwitchLocalClock)
})

check("the two forms agree about the same moment", () => {
  const state = stateAt(at(2026, 9, 9, 2, 30), false)
  const json = Status.object(state, good)
  const text = Status.text(state, good)
  // The JSON carries local time as a clock and UTC as an instant; the text
  // carries both as clocks. They must describe the same moment — the "HH:MM"
  // inside the ISO instant is exactly the clock the text prints.
  const utcClockFromInstant = (iso) => iso.slice(11, 16)
  assert.ok(text.includes(json.nowLocalClock + " local"), text)
  assert.ok(text.includes(utcClockFromInstant(json.nowUtc) + " UTC"), text)
  assert.strictEqual(utcClockFromInstant(json.nowUtc), state.nowUtcClock)
  assert.ok(text.includes(json.nextSwitchLocalClock + " local"), text)
  assert.ok(text.includes(utcClockFromInstant(json.nextSwitchUtc) + " UTC"), text)
  assert.ok(text.includes(json.balance.balances[0].totalBalance), text)
})

check("a missing balance leaves every schedule line intact", () => {
  const state = stateAt(at(2026, 9, 9, 2, 30), true)
  const withoutBalance = Status.text(state, { status: "error", error: "missing_api_key" })
  const withBalance = Status.text(state, good)
  const body = (t) => t.split("\n").filter((l) => !l.startsWith("Balance:") && !l.startsWith("   "))
  assert.deepStrictEqual(body(withoutBalance), body(withBalance),
    "only the balance lines may differ")
  assert.ok(withoutBalance.includes("Balance:       missing_api_key"), withoutBalance)
})

check("balance lines cover every failure the module can produce", () => {
  assert.deepStrictEqual(Status.balanceLines(null), ["not queried"])
  assert.deepStrictEqual(Status.balanceLines({ status: "idle" }), ["not queried"])
  assert.deepStrictEqual(Status.balanceLines({ status: "loading" }), ["loading"])
  for (const error of ["missing_api_key", "network_error", "invalid_response", "http_503"]) {
    assert.deepStrictEqual(Status.balanceLines({ status: "error", error: error }), [error])
  }
  assert.deepStrictEqual(Status.balanceLines({ status: "ok", isAvailable: true, balances: [] }),
    ["no balance reported"])
  assert.deepStrictEqual(Status.balanceLines({ status: "ok", isAvailable: false, balances: [] }),
    ["not available"])
  // Two currencies get two lines, and an unavailable account is flagged without
  // dropping the amounts it did report.
  const two = { status: "ok", isAvailable: false, balances: [
    { currency: "CNY", totalBalance: "1.00", grantedBalance: "0.00", toppedUpBalance: "1.00" },
    { currency: "USD", totalBalance: "2.00", grantedBalance: "1.00", toppedUpBalance: "1.00" }] }
  assert.deepStrictEqual(Status.balanceLines(two), [
    "not available",
    "CNY 1.00 (granted 0.00, topped up 1.00)",
    "USD 2.00 (granted 1.00, topped up 1.00)"
  ])
})

check("a missing field degrades to a placeholder instead of 'undefined'", () => {
  const text = Status.text({}, null)
  assert.ok(!text.includes("undefined"), text)
  assert.ok(!text.includes("NaN"), text)
  const json = Status.object({}, null)
  const serialized = JSON.stringify(json)
  // Absent instants are empty strings, not the literal "undefined" or "NaN";
  // JSON.stringify would drop a real undefined and leave a hole in the shape.
  assert.ok(!serialized.includes("undefined"), serialized)
  assert.ok(!serialized.includes("NaN"), serialized)
  assert.strictEqual(json.nowUtc, "")
  assert.strictEqual(json.nextSwitchUtc, "")
  assert.strictEqual(json.nowMs, 0)
  assert.strictEqual(json.peak, false)
  assert.strictEqual(json.state, "off-peak")
})

check("notificationsEnabled is omitted where there is no switch, not fabricated", () => {
  // The CLI has no notification state; it must not claim "off".
  const cli = Status.text(stateAt(at(2026, 9, 9, 2, 30), null), good)
  assert.ok(!cli.includes("Notifications:"), cli)
  assert.strictEqual(Status.object(stateAt(at(2026, 9, 9, 2, 30), null), good).notificationsEnabled, null)
  // The shell always has one.
  const shell = Status.text(stateAt(at(2026, 9, 9, 2, 30), false), good)
  assert.ok(shell.includes("Notifications: off"), shell)
  assert.strictEqual(Status.object(stateAt(at(2026, 9, 9, 2, 30), true), good).notificationsEnabled, true)
})

check("the local offset label is a real offset, and reflects the zone", () => {
  const ms = at(2026, 9, 9, 2, 30)
  const expected = -new Date(ms).getTimezoneOffset()
  const label = Schedule.offsetLabel(ms)
  const match = label.match(/^UTC([+-])(\d{2}):(\d{2})$/)
  assert.ok(match, label)
  const minutes = (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
  // `+ 0` folds -0 to 0: a UTC zone reports offset -0, and strictEqual would
  // reject it against a literal 0 despite the values being equal.
  assert.strictEqual(minutes + 0, expected + 0, `${label} vs ${expected} minutes`)
})

check("the JSON document is one object a script can parse", () => {
  const json = Status.object(stateAt(at(2026, 9, 9, 2, 30), true), good)
  const round = JSON.parse(JSON.stringify(json))
  assert.strictEqual(round.id, "david.deepseek-offpeak")
  assert.ok(["peak", "off-peak"].includes(round.state))
  assert.strictEqual(typeof round.secondsToSwitch, "number")
  assert.ok(round.secondsToSwitch >= 0)
  assert.strictEqual(typeof round.balance.status, "string")
})

check("a null state degrades instead of throwing", () => {
  // The whole report is built from a state object; a caller that has none yet
  // must still get a printable document. An unguarded field access here threw
  // on exactly this case once.
  for (const value of [null, undefined]) {
    const rendered = Status.text(value, null)
    assert.strictEqual(typeof rendered, "string")
    assert.ok(rendered.includes("DeepSeek Off-Peak"), rendered)
    assert.ok(!rendered.includes("undefined"), rendered)
    assert.ok(!rendered.includes("NaN"), rendered)
    assert.ok(!rendered.includes("Key source:"), "no key source to report")

    const json = Status.object(value, null)
    assert.strictEqual(typeof json, "object")
    assert.strictEqual(json.state, "off-peak")
    assert.strictEqual(json.apiKeySource, "")
  }
})

check("the key source is reported only when there is one", () => {
  const base = stateAt(at(2026, 9, 9, 2, 30), true)

  // Absent or empty: no line, and an empty value in the JSON.
  for (const source of ["", null, undefined]) {
    const state = Object.assign({}, base, { apiKeySource: source })
    assert.ok(!Status.text(state, good).includes("Key source:"), JSON.stringify(source))
    assert.ok(!Status.object(state, good).apiKeySource, "empty in JSON too")
  }

  // Present: one line naming the place, and the same value in the JSON.
  for (const [source, wording] of [["environment", "process environment"],
    ["shell", "~/.bashrc"]]) {
    const state = Object.assign({}, base, { apiKeySource: source })
    const rendered = Status.text(state, good)
    assert.ok(rendered.includes("Key source:"), rendered)
    assert.ok(rendered.includes(wording), rendered)
    assert.strictEqual(Status.object(state, good).apiKeySource, source)
  }

  // An unrecognised source is rendered rather than swallowed.
  const odd = Object.assign({}, base, { apiKeySource: "custom" })
  assert.ok(Status.text(odd, good).includes("custom"), Status.text(odd, good))
})

check("the key source label never leaks a key", () => {
  // The label is prose about provenance. It must never contain key material.
  for (const source of ["environment", "shell", "custom"]) {
    const label = Status.keySourceLabel(source)
    assert.ok(!/sk-/.test(label), label)
    assert.ok(label.length > 0, label)
  }
})

console.log(`status: ${checks} checks passed`)
