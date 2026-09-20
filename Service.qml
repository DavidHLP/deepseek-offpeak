import QtQuick
import Quickshell
import Quickshell.Io
import "lib/Schedule.js" as Schedule
import "lib/Holidays.js" as Holidays
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
//
// Holiday dates are the one thing the schedule takes from outside itself: they
// are fetched, cached, and read back — the plugin's second and last network
// call. See lib/Holidays.js and the section below.
Item {
  id: root

  // Injected by omarchy-shell's generic service loader.
  property var shell: null

  // -------------------------------------------------- schedule (local math)

  // Reassigned every second by the tick timer; `billing` is derived from it,
  // so the countdown moves without anything else owning a timer. (Named
  // `billing` rather than `state`: Item already has a `state` property.)
  property double nowMs: Date.now()
  readonly property var billing: Schedule.stateAt(nowMs, root.holidays)

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
  readonly property var day: Schedule.timeline(nowMs, root.holidays)
  readonly property var daySegmentLayout: day.layout
  readonly property var todayPeakLabels: day.peaks
  readonly property real nowFrac: day.nowFrac
  readonly property string timelineDayLabel: day.dayLabel

  readonly property string scheduleSummary: Schedule.scheduleSummary(root.holidayYearsLabel)

  // -------------------------------------------------- holidays (China)
  //
  // A Chinese public holiday is billed as off-peak for the whole day, so the
  // window math needs the year's dates. They come from a cached copy of the
  // State Council's annual arrangement (lib/Holidays.js holds the URLs, the
  // cache paths, the commands, and the parse). The cache is read first and
  // fetched second, so a machine that is offline, or that has never fetched,
  // still schedules from the baked table. A fetch that fails therefore costs
  // nothing but freshness: the table it leaves behind still names the holidays
  // that fall on a weekday, and every other day is decided by the rule.
  property var holidays: Holidays.fallback()

  readonly property string holidayCacheHome: Holidays.cacheHome(
    Quickshell.env("XDG_CACHE_HOME"), Quickshell.env("HOME"))
  // The Beijing year, because a holiday is a date in Beijing: on 31 December at
  // 20:00 UTC the arrangement that matters is already the next year's.
  readonly property int holidayYear: Schedule.beijingYear(root.nowMs)
  readonly property string holidayName: Schedule.holidayName(root.nowMs, root.holidays)
  readonly property string holidayYearsLabel: Holidays.yearsOf(root.holidays).join(", ")

  // What has been read from the cache so far, by year. Kept as text rather than
  // as a merged table because each read replaces one year and the table is
  // rebuilt from all of them: a year that fails to read must not drop another.
  property var holidayCacheTexts: ({})

  // True once the first read-and-fetch cycle has finished. Until then the table
  // is the baked one, which may not know this year's holidays at all — so the
  // notification decision waits for it (see tick).
  property bool holidayCycleDone: false

  // The read-and-refresh queue, one step at a time. Two years are read before
  // either is fetched — the current one and the next, so a January that runs
  // into a new arrangement is already covered — and a fetch is published and
  // read back, which is how fetched data reaches the schedule. The publish in
  // between is a rename out of the temporary file curl wrote, so a transfer that
  // failed is never published over a document that is still good.
  property var holidaySteps: []
  property var holidayStep: null
  property bool holidayStepActive: false
  // Identifies the step in flight, so a callback scheduled for one step can tell
  // that the next one has already started and leave it alone.
  property int holidayStepSeq: 0

  function holidayStepQueue() {
    var year = root.holidayYear
    var steps = [{ kind: "read", year: year }, { kind: "read", year: year + 1 },
      { kind: "fetch", year: year }, { kind: "publish", year: year }, { kind: "read", year: year }]
    // The next year's document is published in early November. Asking for it
    // earlier is a guaranteed 404, so it is asked for only once the year is
    // close enough for it to exist — the same window the CLI uses, from the
    // shared constant.
    if (Schedule.beijingYear(root.nowMs + Holidays.NEXT_YEAR_FETCH_LEAD_MS) > year)
      steps.push({ kind: "fetch", year: year + 1 }, { kind: "publish", year: year + 1 },
        { kind: "read", year: year + 1 })
    return steps
  }

  function holidayStepSpec(step) {
    if (step.kind === "fetch") return Holidays.fetchSpec(root.holidayCacheHome, step.year)
    if (step.kind === "publish") return Holidays.publishSpec(root.holidayCacheHome, step.year)
    return Holidays.readSpec(root.holidayCacheHome, step.year)
  }

  function refreshHolidays() {
    // No cache home at all — no XDG variable and no HOME — is no cache to read
    // and nowhere to write one, so the baked table answers and no step is run:
    // a fetch with no destination is not something to go looking for. The cycle
    // is still done, because nothing more is coming.
    if (root.holidayCacheHome === "") {
      root.holidayCycleDone = true
      return false
    }
    if (root.holidayStepActive) return false
    root.holidaySteps = root.holidayStepQueue()
    return root.startHolidayStep()
  }

  function startHolidayStep() {
    if (root.holidaySteps.length === 0) {
      root.holidayStep = null
      root.holidayStepActive = false
      root.holidayCycleDone = true
      return false
    }

    var step = root.holidaySteps[0]
    root.holidaySteps = root.holidaySteps.slice(1)
    root.holidayStep = step
    root.holidayStepActive = true
    root.holidayStepSeq++

    holidayProc.exitCode = -1
    holidayProc.stdoutDone = false
    holidayProc.stdoutText = ""
    holidayProc.stepSeq = root.holidayStepSeq
    // The commands live in lib/Holidays.js, shared with the CLI, so the two
    // cannot fetch different years or bound the read differently.
    holidayProc.command = root.holidayStepSpec(step).command
    holidayProc.running = true
    holidayWatchdog.restart()
    return true
  }

  // A step is done when it has reported an exit code, and — for a read — when
  // its stdout is complete: Quickshell emits the collector's streamFinished
  // before `exited`, so waiting for both is what keeps the next step from
  // starting on half-collected text.
  function finishHolidayStep() {
    if (!root.holidayStepActive) return false
    if (holidayProc.exitCode === -1) return false
    if (root.holidayStep.kind === "read" && !holidayProc.stdoutDone) return false

    var step = root.holidayStep
    holidayWatchdog.stop()
    root.holidayStepActive = false
    if (step.kind === "read") {
      root.adoptHolidayCache(holidayProc.exitCode, holidayProc.stdoutText, step.year)
    } else if (step.kind === "fetch" && holidayProc.exitCode !== 0) {
      // A fetch that failed left a truncated temporary file or none at all, and
      // publishing either would replace a good document with it. The publish
      // that follows this fetch is dropped instead, so the cache keeps what it
      // had — the same rule the read below applies, one step earlier.
      if (root.holidaySteps.length > 0 && root.holidaySteps[0].kind === "publish")
        root.holidaySteps = root.holidaySteps.slice(1)
    }
    root.startHolidayStep()
    return true
  }

  // A read that produced a document is adopted; a read that failed, and a fetch,
  // leave every year exactly as it was. That asymmetry is the offline story: the
  // table is only ever replaced by a newer document that parsed, never emptied
  // by a fetch that did not — and never half-replaced, because the fetch writes
  // a temporary file that only a finished transfer publishes and only a complete
  // read adopts.
  function adoptHolidayCache(exitCode, text, year) {
    if (exitCode !== 0 || String(text) === "") return false
    if (!Holidays.parse(String(text)).ok) return false

    var texts = {}
    for (var key in root.holidayCacheTexts) {
      if (Object.prototype.hasOwnProperty.call(root.holidayCacheTexts, key))
        texts[key] = root.holidayCacheTexts[key]
    }
    texts[String(year)] = String(text)
    root.holidayCacheTexts = texts
    root.holidays = Holidays.tableFromTexts(
      [texts[String(root.holidayYear)], texts[String(root.holidayYear + 1)]])
    return true
  }

  // A step that never reported an exit code — a process that could not start, or
  // one the watchdog killed — would otherwise leave the queue stopped with the
  // latch closed. `seq` is the step this was scheduled for: if the queue has
  // moved on, there is nothing stuck.
  function recoverStuckHolidayStep(seq) {
    if (seq !== root.holidayStepSeq) return false
    if (!root.holidayStepActive) return false
    holidayWatchdog.stop()
    root.holidayStepActive = false
    return root.startHolidayStep()
  }

  Process {
    id: holidayProc
    property int exitCode: -1
    property int stepSeq: 0
    property bool stdoutDone: false
    property string stdoutText: ""
    command: []

    // Bounded by construction on both steps: `head -c` stops one byte past the
    // size limit, and curl writes the fetch to a temporary file rather than to
    // stdout. So the collector holds at most that much — the same reasoning the
    // key-file read uses instead of an unbounded whole-file read.
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        holidayProc.stdoutText = String(text || "")
        holidayProc.stdoutDone = true
        root.finishHolidayStep()
      }
    }

    onExited: function(code) {
      holidayProc.exitCode = code
      root.finishHolidayStep()
    }

    // Running going false with no exit code means the process died without
    // reporting one. Deferred, because `exited` may still be on its way.
    onRunningChanged: {
      if (running) return
      if (holidayProc.exitCode !== -1) return
      var seq = holidayProc.stepSeq
      Qt.callLater(function() { root.recoverStuckHolidayStep(seq) })
    }
  }

  // The deadline for one step, from process start to kill. curl's own --max-time
  // bounds a transfer but not a curl that never got to start one, and a read of
  // a named pipe with no writer never ends at all.
  Timer {
    id: holidayWatchdog
    interval: Holidays.STEP_TIMEOUT_MS
    repeat: false
    onTriggered: holidayProc.running = false
  }

  // First pass a beat after startup — reads answer from the cache immediately,
  // so waiting is only about not competing with the shell's own startup — then
  // once a week, which is far more often than an annual arrangement changes and
  // is what notices a new year without a restart.
  Timer {
    id: holidayFirstTimer
    interval: 3000
    repeat: false
    running: true
    onTriggered: root.refreshHolidays()
  }

  Timer {
    id: holidayRefreshTimer
    interval: Holidays.STALE_AFTER_MS
    repeat: true
    running: true
    onTriggered: root.refreshHolidays()
  }

  // -------------------------------------------------- notifications

  // Runtime-only by design: the toggle is not persisted, so a shell restart
  // returns to "on" rather than leaving notifications silently dead.
  property bool notificationsEnabled: true

  function setNotificationsEnabled(value) {
    root.notificationsEnabled = value === true
  }

  // One notification per off-peak start, and only for a start this session
  // watched. The decision itself lives in Schedule.notificationForTick, so it is
  // testable outside the shell; what makes a start watched is the tick below,
  // which compares the state one second ago with the state now.
  function notifyOffPeak() {
    // The gate is first, so nothing below can send while the toggle is off.
    if (!root.notificationsEnabled) return
    if (notifier.running) return

    // The notice announces entering off-peak, so the trailing clause names the
    // pricing in force until the end of the window being announced — off-peak.
    // `offPeakEndLocal` is that window's end; saying "peak pricing until then"
    // would contradict the summary line it is attached to.
    var body = "Ends " + root.offPeakEndLocal + " local (" + root.offPeakEndUtc + " UTC) \u00b7 "
      + Schedule.formatShort(root.billing.secondsToOffPeakEnd) + " left \u00b7 "
      + "off-peak pricing until then"

    // Absolute path for the same reason curl gets one: a directory earlier on
    // PATH must not be able to choose what the widget runs.
    notifier.command = ["/usr/bin/notify-send", "-a", "DeepSeek Off-Peak", "-u", "low", "-t", "8000",
      "DeepSeek off-peak has started", body]
    notifier.running = true
  }

  readonly property string offPeakEndLocal: Schedule.hhmmLocal(root.billing.offPeakEndMs)
  readonly property string offPeakEndUtc: Schedule.hhmmUtc(root.billing.offPeakEndMs)

  function tick() {
    var wasPeak = root.peak
    root.nowMs = Date.now()
    // Nothing is announced before the holiday table settles. A fetched table
    // can only ever turn a peak day into an off-peak one (holidays are the only
    // thing it adds), so a plugin that starts before the first read and fetch
    // would otherwise see peak under the baked table, off-peak under the
    // fetched one, and call that a start — exactly the spurious notice this
    // whole design is meant to avoid. Waiting also means the one comparison
    // that matters, `wasPeak` against `peak`, is made under the table that is
    // actually in force.
    if (!root.holidayCycleDone) return
    var decision = Schedule.notificationForTick(wasPeak, root.peak, root.notificationsEnabled)
    if (decision !== "") root.notifyOffPeak()
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
  property var balanceState: Balance.idleState()
  readonly property string balanceStatus: root.balanceState.status
  readonly property string balanceError: root.balanceState.error
  readonly property var balanceBalances: root.balanceState.balances
  readonly property bool balanceIsAvailable: root.balanceState.isAvailable
  readonly property double balanceUpdatedAt: root.balanceState.updatedAtMs
  // Single-flight latch: one request at a time, by construction. The key-file
  // read is part of the same single flight, so it gets its own latch rather
  // than sharing one — a read that finishes must not look like a request that
  // finished.
  property bool balanceBusy: false
  property bool keyReadBusy: false

  // ---------------------------------------------- API key resolution
  //
  // Two places, in this order: the process environment, then a key file. See
  // lib/Balance.js for why neither of them is ~/.bashrc any more — an earlier
  // version ran `bash -ic` for that, which is the widget executing the user's
  // startup files as code.
  //
  // Both are re-read on every refresh — the environment because reading it
  // costs nothing, the file because the read is local — so a key that was
  // exported, rotated, or revoked is picked up on the next pass instead of
  // being held until the shell restarts.
  property string apiKey: ""
  property string apiKeySource: ""
  property string keyReadEnvironmentValue: ""
  readonly property bool hasApiKey: Balance.isUsableKey(root.apiKey)

  readonly property var keyReadSpec: Balance.keyReadSpec(
    Quickshell.env("XDG_CONFIG_HOME"), Quickshell.env("HOME"))
  readonly property string keyFilePath: root.keyReadSpec.path

  // The key file is read with `head -c`, not with Quickshell's FileView, and the
  // reason is the same one that bounds the balance request: FileView reads a
  // whole file into a QML string first and asks questions later — measured at
  // 191 MB read into memory from a file this plugin was pointed at. `head -c`
  // stops at KEY_FILE_READ_BYTES whatever the file is, so the buffer has a
  // ceiling no matter what is on disk.
  //
  // `--` ends the options, so a path that begins with a dash is a path.
  // Nothing is sourced or executed: what comes back is parsed by
  // Balance.resolveKey, which takes one sk-… line and rejects the rest.
  Process {
    id: keyRead
    property int exitCode: -1
    property bool stdoutDone: false
    property string stdoutText: ""
    command: root.keyReadSpec.command

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        keyRead.stdoutText = String(text || "")
        keyRead.stdoutDone = true
        root.finishKeyRead()
      }
    }

    onExited: function(code) {
      keyRead.exitCode = code
      root.finishKeyRead()
    }

    onRunningChanged: {
      if (running) return
      if (!root.keyReadBusy) return
      Qt.callLater(root.recoverStuckKeyRead)
    }
  }

  // A read that never finished — a named pipe with no writer, a directory in
  // the file's place — is not a key, and must not leave the latch closed.
  Timer {
    id: keyReadWatchdog
    interval: root.keyReadSpec.timeoutMs
    repeat: false
    onTriggered: keyRead.running = false
  }

  function recoverStuckKeyRead() {
    if (!root.keyReadBusy) return
    if (keyRead.exitCode !== -1) return
    keyReadWatchdog.stop()
    root.keyReadBusy = false
    root.reportKeyProblem(Balance.ERROR_MISSING_API_KEY)
  }

  readonly property string balanceMessage: Balance.describeState(root.balanceState)

  // Keep the parsed-result shape available for existing QML consumers.
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
  readonly property var balanceEnvironment: Balance.requestEnvironment(
    null, Quickshell.env("HOME"), root.apiKey)

  // The request arguments live in lib/Balance.js, shared with the CLI so the
  // key-handling path cannot drift between the two.
  readonly property var balanceRequestSpec: Balance.requestSpec()
  readonly property var balanceArguments: root.balanceRequestSpec.command

  // No usable key is not a request: report it and leave the schedule and every
  // later retry untouched.
  function reportKeyProblem(error) {
    root.apiKey = ""
    root.apiKeySource = ""
    root.balanceState = Balance.errorState(error, 0)
    return false
  }

  function finishKeyRead() {
    if (!root.keyReadBusy) return
    if (keyRead.exitCode === -1) return
    if (!keyRead.stdoutDone) return

    root.keyReadBusy = false
    keyReadWatchdog.stop()

    // head exits nonzero when there was no file to read, which is the
    // difference between "no key file" and "a key file that is not a key".
    var resolved = Balance.resolveKey(root.keyReadEnvironmentValue,
      keyRead.stdoutText, keyRead.exitCode === 0)
    if (resolved.status !== "resolved") return root.reportKeyProblem(resolved.error)

    root.apiKey = resolved.key
    root.apiKeySource = resolved.source
    root.startBalanceRequest()
  }

  function refreshBalance() {
    if (root.balanceBusy || root.keyReadBusy) return false

    // The environment first, and for free: no process, no read.
    root.keyReadEnvironmentValue = String(Quickshell.env("DEEPSEEK_API_KEY") || "")
    var resolved = Balance.resolveKey(root.keyReadEnvironmentValue)
    if (resolved.status === "resolved") {
      root.apiKey = resolved.key
      root.apiKeySource = resolved.source
      return root.startBalanceRequest()
    }

    keyRead.exitCode = -1
    keyRead.stdoutDone = false
    keyRead.stdoutText = ""
    root.keyReadBusy = true
    keyRead.running = true
    keyReadWatchdog.restart()
    return true
  }

  function startBalanceRequest() {
    root.balanceBusy = true
    root.balanceState = Balance.loadingState(root.balanceState)
    balanceProc.exitCode = -1
    balanceProc.outputTooLarge = false
    balanceProc.stdoutBytes = 0
    balanceProc.stdoutText = ""
    balanceProc.stdout.streamEnded = false
    balanceProc.environment = root.balanceEnvironment
    balanceProc.running = true
    balanceWatchdog.restart()
    return true
  }

  // Quickshell invokes the parser's streamEnded before emitting exited, so the
  // onExited handler below sees the complete bounded text and finalizes once.
  function finishBalance() {
    if (!root.balanceBusy) return
    if (balanceProc.exitCode === -1) return
    if (!balanceProc.stdout.streamEnded) return

    balanceWatchdog.stop()
    root.balanceBusy = false
    root.balanceState = Balance.stateFromResponse(balanceProc.exitCode,
      balanceProc.stdoutText, Date.now(), root.balanceUpdatedAt,
      balanceProc.outputTooLarge)
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
    interval: root.balanceRequestSpec.timeoutMs
    repeat: false
    onTriggered: balanceProc.running = false
  }

  Process {
    id: balanceProc
    property int exitCode: -1
    property bool outputTooLarge: false
    property int stdoutBytes: 0
    property string stdoutText: ""
    command: root.balanceArguments

    stdout: SplitParser {
      property bool streamEnded: false
      splitMarker: ""
      onRead: function(data) {
        if (balanceProc.outputTooLarge) return
        var chunk = String(data || "")
        var chunkBytes = Balance.utf8ByteLength(chunk)
        if (chunkBytes > Balance.MAX_RESPONSE_BYTES - balanceProc.stdoutBytes) {
          balanceProc.outputTooLarge = true
          balanceProc.signal(9)
          balanceProc.running = false
          return
        }
        balanceProc.stdoutText += chunk
        balanceProc.stdoutBytes += chunkBytes
      }
    }

    onExited: function(code) {
      balanceProc.stdout.streamEnded = true
      balanceProc.exitCode = code
      root.finishBalance()
    }

    // stderr is deliberately not collected. Nothing reads it, and a collector
    // with waitForEnd buffers without bound — curl's -sS diagnostics are small,
    // but the buffer would hold whatever the interpreter or a broken pipe sent
    // it. Uncollected stderr goes to the shell's own stderr instead.

    // A process that never started (bash missing, resource exhaustion) or was
    // killed never reports an exit code, so `exited` alone would leave the
    // single-flight latch closed forever and every later poll would be a
    // no-op. `running` going false with no code means exactly that.
    onRunningChanged: {
      if (running) return
      if (!root.balanceBusy) return
      if (balanceProc.outputTooLarge) return
      Qt.callLater(root.recoverStuckBalance)
    }
  }

  function recoverStuckBalance() {
    if (!root.balanceBusy) return
    if (balanceProc.exitCode !== -1) return
    balanceWatchdog.stop()
    root.balanceBusy = false
    root.balanceState = Balance.errorState(Balance.ERROR_NETWORK, root.balanceUpdatedAt)
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

  // Recompute the countdown now, re-read the balance, and run the holiday queue
  // again (all single-flight, so a burst of middle-clicks collapses into the
  // work already in progress).
  function refresh() {
    root.nowMs = Date.now()
    root.refreshBalance()
    root.refreshHolidays()
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
      apiKeySource: root.apiKeySource, holidays: root.holidays,
      holidayYears: root.holidayYearsLabel })

  readonly property var statusBalance: root.balanceState

  function statusText() {
    return Status.text(root.statusState, root.statusBalance)
  }

  function statusObject() {
    return Status.object(root.statusState, root.statusBalance)
  }
}
