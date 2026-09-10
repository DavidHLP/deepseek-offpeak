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

    notifier.command = ["notify-send", "-a", "DeepSeek Off-Peak", "-u", "low", "-t", "8000",
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
  // The key is looked for in two places, in this order:
  //   1. the process environment (Quickshell.env), which is free to read;
  //   2. the user's shell startup files, read by running an interactive bash —
  //      because ~/.bashrc is sourced only by interactive shells, and exporting
  //      the key there is the common setup.
  //
  // The order matters as much as the lookup does. An interactive bash inherits
  // this process's environment, so asking the shell first would let a ~/.bashrc
  // export silently override a key that is already set here — and would report
  // the result as "shell" even when the value came from the environment. The
  // CLI resolves in the same order (see bin/deepseek-offpeak); the two must not
  // be able to select different keys.
  //
  //   "pending"    nothing looked up yet
  //   "resolving"  an interactive bash is running; its answer is on the way
  //   "ready"      the answer is known, even when the answer is "no key"
  //
  // The transition out of "ready" is the one that matters, and who is asking
  // decides it — see Balance.apiKeyAction for the three reasons. A completion
  // never leaves it, so a machine with no key settles instead of restarting
  // the lookup every time it finishes, which is what an earlier version did,
  // spawning interactive bash forever.
  property string apiKeyState: "pending"
  property string apiKey: ""
  property string apiKeySource: ""
  readonly property bool hasApiKey: Balance.isUsableKey(root.apiKey)

  // Settled, with nothing usable found.
  readonly property bool apiKeyMissing: root.apiKeyState === "ready" && !root.hasApiKey

  function startKeyResolver() {
    // The environment first, and for free: no process, no shell startup file.
    var fromEnvironment = String(Quickshell.env("DEEPSEEK_API_KEY") || "")
    if (Balance.isUsableKey(fromEnvironment)) {
      root.apiKey = fromEnvironment
      root.apiKeySource = "environment"
      root.apiKeyState = "ready"
      // "completion": the lookup is over before a process existed, and this is
      // the same hand-off finishKeyResolution() makes.
      root.refreshBalance("completion")
      return
    }

    keyResolver.exitCode = -1
    keyResolver.stdoutDone = false
    keyResolver.stdoutText = ""
    root.apiKeyState = "resolving"
    keyResolver.running = true
  }

  readonly property string balanceMessage: Balance.describe(root.balanceResult)

  // The result object Balance.describe() expects, mirroring the last parse.
  readonly property var balanceResult: root.balanceStatus === "ok"
    ? { ok: true, isAvailable: root.balanceIsAvailable, balances: root.balanceBalances }
    : (root.balanceStatus === "error"
      ? { ok: false, error: root.balanceError }
      : null)

  readonly property string balanceUpdatedLabel: root.balanceUpdatedAt > 0
    ? Schedule.hhmmLocal(root.balanceUpdatedAt) + " local" : ""

  // The key reaches curl over stdin as a config file and is written on
  // onStarted, so it appears in no command line: `ps` and /proc/*/cmdline show
  // argv, not a pipe.
  //
  // Only PATH and HOME are pinned. Quickshell's Process merges this object into
  // the inherited environment rather than replacing it — `clearEnvironment`
  // defaults to false, and only an explicit `null` removes a variable — so
  // HTTPS_PROXY/NO_PROXY and CURL_CA_BUNDLE/SSL_CERT_FILE still reach curl.
  // That is *not* true of the CLI, where Node's spawnSync replaces the child
  // environment outright; see bin/deepseek-offpeak.
  readonly property var balanceEnvironment: ({
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: Quickshell.env("HOME")
  })

  // The request shell lives in lib/Balance.js, shared with the CLI so the
  // key-handling path cannot drift between the two.
  readonly property string balanceScript: Balance.BALANCE_REQUEST_SCRIPT

  // Reads the key from the shell startup files. Interactive (`-i`) because that
  // is the mode that sources ~/.bashrc; HISTFILE is neutralised so the lookup
  // cannot write to the user's history. The environment is inherited, not
  // replaced, so the login shell behaves as it would in a terminal.
  Process {
    id: keyResolver
    property int exitCode: -1
    property bool stdoutDone: false
    property string stdoutText: ""
    command: ["bash", "-ic", Balance.KEY_RESOLUTION_SCRIPT]
    environment: ({ HISTFILE: "/dev/null" })

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        keyResolver.stdoutText = String(text || "")
        keyResolver.stdoutDone = true
        // The exit signal and the stream finishing have no guaranteed order, so
        // whichever arrives last does the work. Without this, `onExited` can
        // read stdoutText before it has been assigned and decide "no key" for a
        // shell that returned one.
        root.finishKeyResolution()
      }
    }

    onExited: function(code) {
      keyResolver.exitCode = code
      root.finishKeyResolution()
    }

    // A resolver that never started (bash missing, resource exhaustion) or was
    // killed never reports an exit code, and without this the state stays
    // "resolving" forever: apiKeyAction then answers "wait" to every later
    // refresh, so the balance is dead for the lifetime of the service while the
    // panel shows neither a key nor a missing-key message. It is the same
    // failure the balance process already recovers from, one screen down.
    onRunningChanged: {
      if (running) return
      if (root.apiKeyState !== "resolving") return
      Qt.callLater(root.recoverStuckKeyResolution)
    }
  }

  function recoverStuckKeyResolution() {
    if (root.apiKeyState !== "resolving") return
    if (keyResolver.exitCode !== -1) return
    // Settle as "looked, found nothing" rather than hanging: "report-missing"
    // then says so, and the next poll looks again.
    root.apiKey = ""
    root.apiKeySource = ""
    root.apiKeyState = "ready"
    root.refreshBalance("completion")
  }

  // Called from both the stdout stream and the exit signal; whichever arrives
  // second completes the lookup, exactly once.
  function finishKeyResolution() {
    if (root.apiKeyState !== "resolving") return
    if (keyResolver.exitCode === -1) return
    if (!keyResolver.stdoutDone) return

    // Only the last plausible line of stdout is adopted; see
    // Balance.keyFromShellOutput for why the scan runs backwards.
    var fromShell = Balance.keyFromShellOutput(keyResolver.stdoutText)
    if (Balance.isUsableKey(fromShell)) {
      root.apiKey = fromShell
      root.apiKeySource = "shell"
    } else {
      root.apiKey = ""
      root.apiKeySource = ""
    }
    root.apiKeyState = "ready"
    // "completion": this lookup just finished, so report its outcome rather
    // than ordering another one.
    root.refreshBalance("completion")
  }

  // `reason` is passed straight through to Balance.apiKeyAction, which owns the
  // decision: "completion" from a finished key lookup, "poll" from the timers,
  // "manual" from the user. They are not interchangeable — see that function
  // for why a held key must survive a poll but not a manual refresh.
  function refreshBalance(reason) {
    if (root.balanceBusy) return false

    var action = Balance.apiKeyAction(root.apiKeyState, root.hasApiKey,
      keyResolver.running, reason)

    if (action === "wait") return false

    if (action === "resolve") {
      root.startKeyResolver()
      return false
    }

    if (action === "report-missing") {
      // No key anywhere is not a request: report it and leave the schedule and
      // every later retry untouched.
      root.balanceStatus = "error"
      root.balanceError = Balance.ERROR_MISSING_API_KEY
      root.balanceIsAvailable = false
      root.balanceBalances = []
      root.balanceUpdatedAt = 0
      return false
    }

    root.balanceBusy = true
    root.balanceStatus = "loading"
    root.balanceError = ""
    balanceProc.exitCode = -1
    balanceProc.stdoutDone = false
    balanceProc.stdoutText = ""
    balanceProc.stderrText = ""
    balanceProc.environment = root.balanceEnvironment
    balanceProc.running = true
    return true
  }

  // Called from both the stdout stream and the exit signal, because their order
  // is not guaranteed; whichever arrives second does the work.
  function finishBalance() {
    if (!root.balanceBusy) return
    if (balanceProc.exitCode === -1) return
    if (!balanceProc.stdoutDone) return

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

  Process {
    id: balanceProc
    property int exitCode: -1
    property bool stdoutDone: false
    property string stdoutText: ""
    property string stderrText: ""
    command: ["bash", "-c", root.balanceScript]
    stdinEnabled: true

    // The key is written here and nowhere else — not into the command, not
    // into the environment. Bash reads the line, builds the curl config, and
    // `printf |` gives curl its own stdout to read the config from, so the
    // key never reaches a pipe owned by curl either.
    onStarted: write(root.apiKey + "\n")

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        balanceProc.stdoutText = String(text || "")
        balanceProc.stdoutDone = true
        root.finishBalance()
      }
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: balanceProc.stderrText = String(text || "").trim()
    }

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
    root.balanceBusy = false
    root.balanceStatus = "error"
    root.balanceError = Balance.ERROR_NETWORK
    root.balanceIsAvailable = false
    root.balanceBalances = []
  }

  // First read a beat after startup so the balance is on screen without the
  // panel having to be opened, then every five minutes.
  //
  // A scheduled pass is a "poll": it looks the key up again only while none is
  // held, which is how a key added to ~/.bashrc takes effect without restarting
  // the shell. It stays terminating because a scheduled pass runs once per
  // interval — the resolver's own completion handler is what must not re-arm
  // it. A held key is left alone here: re-resolving every five minutes would
  // spawn an interactive bash 288 times a day for nothing.
  Timer {
    id: balanceFirstTimer
    interval: 3000
    repeat: false
    running: true
    onTriggered: root.refreshBalance("poll")
  }

  Timer {
    id: balancePollTimer
    interval: 300000
    repeat: true
    running: true
    onTriggered: root.refreshBalance("poll")
  }

  // Recompute the countdown now and re-read the balance (single-flight, so a
  // burst of middle-clicks collapses into the one request already running).
  // "manual": re-resolve even when a key is held, so one the user just exported
  // in a terminal is picked up without a shell restart — and so a key that was
  // rotated or revoked stops being sent.
  function refresh() {
    root.nowMs = Date.now()
    root.refreshBalance("manual")
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

