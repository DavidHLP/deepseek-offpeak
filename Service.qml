import QtQuick
import Quickshell
import Quickshell.Io
import "lib/Schedule.js" as Schedule
import "lib/Balance.js" as Balance
import "lib/Status.js" as Status

// DeepSeek peak/off-peak state, the countdown to the next change, an optional
// account-balance readout, and the off-peak notification.
//
// The schedule is computed locally from the published UTC timetable (see
// lib/Schedule.js) and never from the API: server load and API availability
// are not billing state. The balance query is the only network call and it is
// strictly additive — every failure path leaves the schedule untouched.
//
// One instance serves the bar widget, the panel, and the CLI, so the countdown
// the bar shows and the countdown the panel shows cannot disagree.
Item {
  id: root

  // Injected by omarchy-shell's generic service loader.
  property var shell: null

  // -------------------------------------------------- schedule (local math)

  // Reassigned every second by the tick timer; `billing` is derived from it,
  // so the countdown moves without anything else owning a timer. (Named
  // `billing` rather than `state`: Item already has a `state` property.)
  property double nowMs: Date.now()
  readonly property var billing: Schedule.stateAt(nowMs)

  readonly property bool peak: billing.peak
  readonly property string phaseLabel: billing.peak ? "Peak" : "Off-peak"
  // "2h 14m" for the bar; the panel uses `remainingClock` for a finer readout.
  readonly property string remainingShort: Schedule.formatShort(billing.secondsToSwitch)
  readonly property string remainingClock: Schedule.formatClock(billing.secondsToSwitch)
  readonly property real secondsToSwitch: billing.secondsToSwitch

  readonly property double nextSwitchMs: billing.nextSwitchMs
  readonly property double offPeakEndMs: billing.offPeakEndMs
  readonly property string nextSwitchLocal: Schedule.hhmmLocal(billing.nextSwitchMs)
  readonly property string nextSwitchUtc: Schedule.hhmmUtc(billing.nextSwitchMs)
  readonly property string nextSwitchLocalDay: Schedule.localDayLabel(billing.nextSwitchMs)
  readonly property string nextSwitchUtcDay: Schedule.utcDayLabel(billing.nextSwitchMs)

  // What switches next, phrased for the state we are in now: from peak the next
  // change is the off-peak start, from off-peak it is a peak start.
  readonly property string nextSwitchLabel: root.peak ? "Off-peak starts" : "Peak starts"

  readonly property string localOffsetLabel: Schedule.offsetLabel(nowMs)

  // The local day, derived once in lib/Schedule.js where its fractions and zone
  // conversions are covered by tests rather than only by pixels. The panel reads
  // these straight through.
  readonly property var day: Schedule.timeline(nowMs)
  readonly property var daySegmentLayout: day.layout
  readonly property var todayPeakLabels: day.peaks
  readonly property real nowFrac: day.nowFrac
  readonly property string timelineDayLabel: day.dayLabel

  readonly property string scheduleSummary: Schedule.scheduleSummary()

  // -------------------------------------------------- notifications

  // Runtime-only by design: the toggle is not persisted, so a shell restart
  // returns to "on" rather than leaving notifications silently dead.
  property bool notificationsEnabled: true

  // `primed` is false until the first tick, which is the one that reports the
  // state the plugin started in. The decision itself lives in
  // Schedule.notificationForTick so it is testable outside the shell.
  property bool primed: false

  function setNotificationsEnabled(value) {
    root.notificationsEnabled = value === true
  }

  function notifyOffPeak(reason) {
    // The gate is first, so nothing below can send while the toggle is off.
    if (!root.notificationsEnabled) return
    if (notifier.running) return

    var summary = reason === "startup"
      ? "DeepSeek off-peak is active"
      : "DeepSeek off-peak has started"
    // This fires on entering off-peak (and on the first tick, when the plugin
    // starts there), so the trailing clause names the pricing in force until
    // the end of the window being announced — off-peak. `offPeakEndLocal` is
    // that window's end; saying "peak pricing until then" would contradict the
    // summary line it is attached to.
    var body = "Ends " + root.offPeakEndLocal + " local (" + root.offPeakEndUtc + " UTC) \u00b7 "
      + Schedule.formatShort(root.billing.secondsToOffPeakEnd) + " left \u00b7 "
      + "off-peak pricing until then"

    // Absolute path for the same reason curl gets one: a directory earlier on
    // PATH must not be able to choose what the widget runs.
    notifier.command = ["/usr/bin/notify-send", "-a", "DeepSeek Off-Peak", "-u", "low", "-t", "8000",
      summary, body]
    notifier.running = true
  }

  readonly property string offPeakEndLocal: Schedule.hhmmLocal(root.billing.offPeakEndMs)
  readonly property string offPeakEndUtc: Schedule.hhmmUtc(root.billing.offPeakEndMs)

  function tick() {
    var wasPeak = root.peak
    root.nowMs = Date.now()
    var decision = Schedule.notificationForTick(root.primed, wasPeak, root.peak, root.notificationsEnabled)
    root.primed = true
    if (decision !== "") root.notifyOffPeak(decision)
  }

  Timer {
    id: tickTimer
    interval: 1000
    repeat: true
    running: true
    onTriggered: root.tick()
  }

  Process {
    id: notifier
    command: []
  }

  // -------------------------------------------------- balance (optional)

  // status: "idle" | "loading" | "ok" | "error"
  property string balanceStatus: "idle"
  property string balanceError: ""
  property var balanceBalances: []
  property bool balanceIsAvailable: false
  property double balanceUpdatedAt: 0
  // Single-flight latch: one request at a time, by construction.
  property bool balanceBusy: false

  // ---------------------------------------------- API key resolution
  //
  // The key is read from the process environment (Quickshell.env) and from
  // nowhere else. An earlier version also ran an interactive bash to pick the
  // key out of ~/.bashrc, because exporting it there is a common setup — but
  // that is the widget executing the user's startup files as code inside the
  // long-lived shell process, and it is not a trade this plugin needs to make.
  // Export DEEPSEEK_API_KEY into the session that starts omarchy-shell, or have
  // a secret provider put it there before the shell starts.
  //
  // Reading the environment costs nothing and spawns nothing, so every refresh
  // re-reads it: a key that was exported, rotated, or revoked after startup is
  // picked up on the next pass instead of being held until the shell restarts.
  property string apiKey: ""
  property string apiKeySource: ""
  readonly property bool hasApiKey: Balance.isUsableKey(root.apiKey)

  readonly property string balanceMessage: Balance.describe(root.balanceResult)

  // The result object Balance.describe() expects, mirroring the last parse.
  readonly property var balanceResult: root.balanceStatus === "ok"
    ? { ok: true, isAvailable: root.balanceIsAvailable, balances: root.balanceBalances }
    : (root.balanceStatus === "error"
      ? { ok: false, error: root.balanceError }
      : null)

  readonly property string balanceUpdatedLabel: root.balanceUpdatedAt > 0
    ? Schedule.hhmmLocal(root.balanceUpdatedAt) + " local" : ""

  // The key reaches curl through this environment and nothing else: curl reads
  // it with `--variable %NAME` and expands it into the header, so the value
  // appears in no command line (`ps` shows the variable's name).
  //
  // Only HOME is pinned, and PATH is deliberately left alone: curl is named by
  // absolute path in the request arguments (see lib/Balance.js), so no
  // directory on any search path decides what runs.
  //
  // Quickshell's Process merges this object into the inherited environment
  // rather than replacing it — `clearEnvironment` defaults to false, and only
  // an explicit `null` removes a variable — so HTTPS_PROXY/NO_PROXY and
  // CURL_CA_BUNDLE/SSL_CERT_FILE still reach curl. That is *not* true of the
  // CLI, where Node's spawnSync replaces the child environment outright; see
  // bin/deepseek-offpeak.
  readonly property var balanceEnvironment: ({
    HOME: Quickshell.env("HOME"),
    DEEPSEEK_API_KEY: root.apiKey
  })

  // The request arguments live in lib/Balance.js, shared with the CLI so the
  // key-handling path cannot drift between the two.
  readonly property var balanceArguments: [Balance.CURL_BINARY].concat(Balance.CURL_ARGUMENTS)

  function refreshBalance() {
    if (root.balanceBusy) return false

    var fromEnvironment = String(Quickshell.env("DEEPSEEK_API_KEY") || "")
    if (!Balance.isUsableKey(fromEnvironment)) {
      // No key set is not a request: report it and leave the schedule and every
      // later retry untouched.
      root.apiKey = ""
      root.apiKeySource = ""
      root.balanceStatus = "error"
      root.balanceError = Balance.ERROR_MISSING_API_KEY
      root.balanceIsAvailable = false
      root.balanceBalances = []
      root.balanceUpdatedAt = 0
      return false
    }

    root.apiKey = fromEnvironment
    root.apiKeySource = "environment"
    root.balanceBusy = true
    root.balanceStatus = "loading"
    root.balanceError = ""
    balanceProc.exitCode = -1
    balanceProc.stdoutDone = false
    balanceProc.stdoutText = ""
    balanceProc.environment = root.balanceEnvironment
    balanceProc.running = true
    balanceWatchdog.restart()
    return true
  }

  // Called from both the stdout stream and the exit signal, because their order
  // is not guaranteed; whichever arrives second does the work.
  function finishBalance() {
    if (!root.balanceBusy) return
    if (balanceProc.exitCode === -1) return
    if (!balanceProc.stdoutDone) return

    balanceWatchdog.stop()
    root.balanceBusy = false
    var result = Balance.fromResponse(balanceProc.exitCode, balanceProc.stdoutText)

    if (result.ok) {
      root.balanceStatus = "ok"
      root.balanceError = ""
      root.balanceIsAvailable = result.isAvailable
      root.balanceBalances = result.balances
      root.balanceUpdatedAt = Date.now()
      return
    }

    root.balanceStatus = "error"
    root.balanceError = result.error
    root.balanceIsAvailable = false
    root.balanceBalances = []
  }

  // The absolute deadline for the whole request. curl's own --max-time bounds a
  // transfer, but not a curl that never got to start one — a hung DNS resolver
  // — and nothing else closes the single-flight latch when a process outlives
  // its own timeouts. Setting `running` false kills it, and the exit path below
  // reports network_error.
  //
  // curl is the direct child, so this kills the request itself. Under a shell,
  // the kill would land on the shell and a curl descendant could hold the
  // stdout pipe open past it, leaving this collector waiting on a process
  // nobody killed.
  Timer {
    id: balanceWatchdog
    interval: Balance.REQUEST_TIMEOUT_MS
    repeat: false
    onTriggered: balanceProc.running = false
  }

  Process {
    id: balanceProc
    property int exitCode: -1
    property bool stdoutDone: false
    property string stdoutText: ""
    command: root.balanceArguments

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        balanceProc.stdoutText = String(text || "")
        balanceProc.stdoutDone = true
        root.finishBalance()
      }
    }

    // stderr is deliberately not collected. Nothing reads it, and a collector
    // with waitForEnd buffers without bound — curl's -sS diagnostics are small,
    // but the buffer would hold whatever the interpreter or a broken pipe sent
    // it. Uncollected stderr goes to the shell's own stderr instead.

    onExited: function(code) {
      balanceProc.exitCode = code
      root.finishBalance()
    }

    // A process that never started (bash missing, resource exhaustion) or was
    // killed never reports an exit code, so `exited` alone would leave the
    // single-flight latch closed forever and every later poll would be a
    // no-op. `running` going false with no code means exactly that.
    onRunningChanged: {
      if (running) return
      if (!root.balanceBusy) return
      Qt.callLater(root.recoverStuckBalance)
    }
  }

  function recoverStuckBalance() {
    if (!root.balanceBusy) return
    if (balanceProc.exitCode !== -1) return
    balanceWatchdog.stop()
    root.balanceBusy = false
    root.balanceStatus = "error"
    root.balanceError = Balance.ERROR_NETWORK
    root.balanceIsAvailable = false
    root.balanceBalances = []
  }

  // First read a beat after startup so the balance is on screen without the
  // panel having to be opened, then every five minutes. Both passes read the
  // environment again, which costs nothing, so a key exported after startup is
  // picked up without restarting the shell.
  Timer {
    id: balanceFirstTimer
    interval: 3000
    repeat: false
    running: true
    onTriggered: root.refreshBalance()
  }

  Timer {
    id: balancePollTimer
    interval: 300000
    repeat: true
    running: true
    onTriggered: root.refreshBalance()
  }

  // Recompute the countdown now and re-read the balance (single-flight, so a
  // burst of middle-clicks collapses into the one request already running).
  function refresh() {
    root.nowMs = Date.now()
    root.refreshBalance()
  }

  // -------------------------------------------------- CLI status
  //
  // Both forms are produced by lib/Status.js, the same module the CLI uses, so
  // the widget's `status` and `deepseek-offpeak status` cannot drift apart.
  // Called by the bar widget's IpcHandler, which owns the plugin's single IPC
  // target. See BarWidget.qml.

  // The state document, assembled by Schedule.statusState — the same call the
  // CLI makes — so the two cannot list different fields.
  readonly property var statusState: Schedule.statusState(root.billing,
    { nowMs: root.nowMs, notificationsEnabled: root.notificationsEnabled,
      apiKeySource: root.apiKeySource })

  readonly property var statusBalance: ({
    status: root.balanceStatus,
    error: root.balanceError,
    isAvailable: root.balanceIsAvailable,
    updatedAtMs: root.balanceUpdatedAt,
    balances: root.balanceBalances
  })

  function statusText() {
    return Status.text(root.statusState, root.statusBalance)
  }

  function statusObject() {
    return Status.object(root.statusState, root.statusBalance)
  }
}

