// The status report, formatted once for both consumers: the shell's IPC
// handler (which the bar and the panel use) and the bin/deepseek-offpeak CLI,
// which runs as plain node with no shell present.
//
// The state object both consumers render is assembled by Schedule.statusState,
// which lives in the one module QML and node can both reach. This file is pure
// formatting: a state object plus a balance in, text or JSON out. It holds no
// arithmetic of its own, so it cannot disagree with the schedule.

function field(state, name, fallback) {
  var value = state ? state[name] : undefined
  return value === undefined || value === null ? fallback : value
}

// Balance is an optional extra. `balance` is a Balance.js result, or null
// before the first query, or a {status:"loading"} marker. Its absence or
// failure never changes anything about the schedule lines above it.
function balanceLines(balance) {
  if (!balance || balance.status === "idle") return ["not queried"]
  if (balance.status === "loading") return ["loading"]
  if (balance.status === "error") return [String(balance.error || "error")]
  var balances = balance.balances || []
  if (balances.length === 0) return [balance.isAvailable === false ? "not available" : "no balance reported"]
  var lines = []
  for (var i = 0; i < balances.length; i++) {
    var entry = balances[i]
    lines.push(entry.currency + " " + entry.totalBalance
      + " (granted " + entry.grantedBalance + ", topped up " + entry.toppedUpBalance + ")")
  }
  if (balance.isAvailable === false) lines.unshift("not available")
  return lines
}

// Field contract for the `state` object: every `*Utc` field is an ISO 8601
// instant, every `*Clock` field is "HH:MM", and `*Local*`/`*LocalDay` fields are
// display labels. Nothing is named for one meaning in one consumer and another
// meaning in the other — an earlier version had `nextSwitchUtc` hold a clock
// string here and an ISO instant there, which is the kind of drift this file
// exists to prevent.
//
// `apiKeySource` is "environment", "shell", or "" — where the balance key was
// found, so a missing-key report says where it looked.
//
// Plain text, one fact per line. Used by `deepseek-offpeak status` and by the
// shell's IPC `status` function.
function text(state, balance) {
  var lines = []
  lines.push("DeepSeek Off-Peak")
  lines.push("State:         " + field(state, "phaseLabel", "\u2014"))
  lines.push("Now:           " + field(state, "nowLocalClock", "") + " local ("
    + field(state, "nowLocalOffset", "") + ") \u00b7 "
    + field(state, "nowUtcClock", "") + " UTC")
  lines.push(field(state, "nextSwitchLabel", "Next change") + ": "
    + field(state, "nextSwitchLocalDay", "") + " " + field(state, "nextSwitchLocalClock", "") + " local \u00b7 "
    + field(state, "nextSwitchUtcDay", "") + " " + field(state, "nextSwitchUtcClock", "") + " UTC")
  lines.push("Remaining:     " + field(state, "remainingShort", "") + " ("
    + field(state, "remainingClock", "") + ")")
  lines.push("Off-peak ends: " + field(state, "offPeakEndLocalClock", "") + " local \u00b7 "
    + field(state, "offPeakEndUtcClock", "") + " UTC")
  // Only the shell has a notification switch; the CLI passes null and gets no
  // line, rather than reporting "off" for a state it does not have.
  if (state && typeof state.notificationsEnabled === "boolean")
    lines.push("Notifications: " + (state.notificationsEnabled ? "on" : "off"))
  var balance_ = balanceLines(balance)
  lines.push("Balance:       " + balance_[0])
  for (var i = 1; i < balance_.length; i++) lines.push("               " + balance_[i])
  // Only worth saying when a key was found: it answers "which of the two places
  // did that balance come from?", and its absence is already stated by the
  // missing_api_key line above. Guarded on `state` like the lines around it, so
  // a null state degrades to the placeholder report instead of throwing.
  if (state && typeof state.apiKeySource === "string" && state.apiKeySource !== "")
    lines.push("Key source:    " + keySourceLabel(state.apiKeySource))
  lines.push(field(state, "schedule", ""))
  return lines.join("\n")
}

// Human wording for where the balance key came from.
function keySourceLabel(source) {
  if (source === "environment") return "DEEPSEEK_API_KEY from the process environment"
  if (source === "shell") return "exported by ~/.bashrc (read via an interactive shell)"
  return String(source)
}

// The machine-readable form. `--json` and the shell's `statusJson` both return
// this, so a script parsing one gets the other's shape. Instants are ISO 8601
// under `*Utc`; `nowLocalClock` / `nextSwitchLocalClock` are the wall-clock
// strings, and fully derivable from the instants beside them.
function object(state, balance) {
  var balances = balance && balance.status === "ok" ? (balance.balances || []) : []
  return {
    id: "deepseek-offpeak",
    peak: field(state, "peak", false) === true,
    state: field(state, "peak", false) === true ? "peak" : "off-peak",
    nowMs: Math.round(field(state, "nowMs", 0)),
    nowLocalClock: field(state, "nowLocalClock", ""),
    nowLocalOffset: field(state, "nowLocalOffset", ""),
    nowUtc: field(state, "nowUtcInstant", ""),
    currentPeriodStartMs: Math.round(field(state, "currentPeriodStartMs", 0)),
    currentPeriodStartUtc: field(state, "currentPeriodStartUtc", ""),
    nextSwitchMs: Math.round(field(state, "nextSwitchMs", 0)),
    nextSwitchUtc: field(state, "nextSwitchUtcInstant", ""),
    nextSwitchLocalClock: field(state, "nextSwitchLocalClock", ""),
    secondsToSwitch: Math.round(field(state, "secondsToSwitch", 0)),
    nextOffPeakStartMs: Math.round(field(state, "nextOffPeakStartMs", 0)),
    nextOffPeakStartUtc: field(state, "nextOffPeakStartUtc", ""),
    offPeakEndMs: Math.round(field(state, "offPeakEndMs", 0)),
    offPeakEndUtc: field(state, "offPeakEndUtcInstant", ""),
    secondsToOffPeakEnd: Math.round(field(state, "secondsToOffPeakEnd", 0)),
    notificationsEnabled: typeof field(state, "notificationsEnabled", null) === "boolean"
      ? state.notificationsEnabled : null,
    apiKeySource: field(state, "apiKeySource", ""),
    schedule: field(state, "schedule", ""),
    balance: {
      status: balance ? String(balance.status || "idle") : "idle",
      error: balance ? String(balance.error || "") : "",
      isAvailable: balance ? balance.isAvailable === true : false,
      updatedAtMs: balance ? Math.round(balance.updatedAtMs || 0) : 0,
      balances: balances
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    balanceLines: balanceLines,
    keySourceLabel: keySourceLabel,
    text: text,
    object: object
  }
}
