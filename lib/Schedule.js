// DeepSeek billing-window math.
//
// Peak hours are weekdays 01:00-04:00 and 06:00-10:00 UTC. Every other
// instant is off-peak, and Saturday/Sunday are off-peak all day. Windows are
// half-open ([01:00, 04:00)) so a boundary instant belongs to the window that
// starts there: 04:00 is off-peak, 06:00 is peak, 10:00 is off-peak.
//
// This is the whole schedule. It never consults the DeepSeek API — server
// load and API availability are not billing state, and the discount windows
// are a published timetable.
//
// Pure and I/O-free: imported by Service.qml and Panel.qml, required by
// bin/deepseek-offpeak and by tests/schedule.test.js. Every function takes the
// instant it should reason about, so nothing here reads the clock implicitly.

var MINUTE_MS = 60000
var HOUR_MS = 3600000
var DAY_MS = 86400000

// Peak windows for a weekday, as [startMinute, endMinute) since 00:00 UTC.
var PEAK_WINDOWS = [[60, 240], [360, 600]]

var WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function utcDayStartMs(ms) {
  var d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

// The day at `dayStartMs` split into contiguous intervals of constant state.
// Weekdays alternate off/peak/off/peak/off; weekends are one off-peak day.
function intervalsForDay(dayStartMs) {
  var dayOfWeek = new Date(dayStartMs).getUTCDay()
  if (dayOfWeek === 0 || dayOfWeek === 6)
    return [{ startMs: dayStartMs, endMs: dayStartMs + DAY_MS, peak: false }]

  var out = []
  var cursor = 0
  for (var i = 0; i < PEAK_WINDOWS.length; i++) {
    var window = PEAK_WINDOWS[i]
    out.push({ startMs: dayStartMs + cursor * MINUTE_MS, endMs: dayStartMs + window[0] * MINUTE_MS, peak: false })
    out.push({ startMs: dayStartMs + window[0] * MINUTE_MS, endMs: dayStartMs + window[1] * MINUTE_MS, peak: true })
    cursor = window[1]
  }
  out.push({ startMs: dayStartMs + cursor * MINUTE_MS, endMs: dayStartMs + DAY_MS, peak: false })
  return out
}

// Contiguous, merged runs of constant state, generated from three days before
// `ms` through three days after it. Adjacent intervals of the same state are
// folded together, which is what makes "off-peak until 01:00 Monday" come out
// as one run across the whole weekend instead of a spurious switch at each
// midnight.
//
// The horizon has to clear the longest possible run in both directions — Friday
// 10:00 to Monday 01:00, 63 hours — with a boundary interval beyond it on
// either side. Too short forward truncates the run at the edge of the generated
// range and invents a switch that never happens; too short backward truncates
// its start and reports the current stretch as having begun at midnight. From
// any instant, ±3 days is 72 hours at minimum, so both the start and the end of
// the run containing `ms` are always real interval boundaries.
function runsAround(ms) {
  var dayStart = utcDayStartMs(ms)
  var intervals = []
  for (var dayOffset = -3; dayOffset <= 3; dayOffset++)
    intervals = intervals.concat(intervalsForDay(dayStart + dayOffset * DAY_MS))

  var runs = []
  for (var i = 0; i < intervals.length; i++) {
    var interval = intervals[i]
    var last = runs.length > 0 ? runs[runs.length - 1] : null
    if (last && last.peak === interval.peak && last.endMs === interval.startMs) last.endMs = interval.endMs
    else runs.push({ startMs: interval.startMs, endMs: interval.endMs, peak: interval.peak })
  }
  return runs
}

function runAt(runs, ms) {
  for (var i = 0; i < runs.length; i++)
    if (runs[i].startMs <= ms && ms < runs[i].endMs) return i
  return -1
}

// Everything the bar, panel, notification, and CLI need for one instant:
//   peak                  current pricing state
//   currentStartMs        when the current (possibly merged) run began
//   nextSwitchMs          when the state next changes
//   nextOffPeakStartMs    start of the off-peak stretch that contains `now`,
//                         or the upcoming off-peak start when `now` is peak —
//                         i.e. the most recent off-peak start, never a future
//                         one beyond the next transition
//   offPeakEndMs          when that off-peak stretch ends
//   peakEndMs             when the current peak ends, or null when off-peak
//   secondsToSwitch       whole seconds until nextSwitchMs, never negative
//   secondsToOffPeakEnd   whole seconds until offPeakEndMs, never negative
function stateAt(ms) {
  var now = Number(ms)
  var runs = runsAround(now)
  var index = runAt(runs, now)
  if (index < 0) {
    // Unreachable for any finite input (the runs span three days), but a
    // NaN or an absurd date must not produce a negative countdown.
    return {
      peak: false,
      currentStartMs: now,
      nextSwitchMs: now,
      nextOffPeakStartMs: now,
      offPeakEndMs: now,
      peakEndMs: null,
      secondsToSwitch: 0,
      secondsToOffPeakEnd: 0
    }
  }

  var run = runs[index]
  var first = index
  while (first > 0 && runs[first - 1].peak === run.peak) first--
  var last = index
  while (last < runs.length - 1 && runs[last + 1].peak === run.peak) last++

  var offPeakEndMs = now
  for (var i = index; i < runs.length; i++) {
    if (!runs[i].peak) { offPeakEndMs = runs[i].endMs; break }
  }

  var nextSwitchMs = runs[last].endMs
  return {
    peak: run.peak,
    currentStartMs: runs[first].startMs,
    nextSwitchMs: nextSwitchMs,
    nextOffPeakStartMs: run.peak ? nextSwitchMs : runs[first].startMs,
    offPeakEndMs: offPeakEndMs,
    peakEndMs: run.peak ? nextSwitchMs : null,
    // Ceiling, not rounding. A countdown must not report zero before its
    // target instant, and rounding reaches zero up to 499ms early — while
    // `peak` still describes the interval being left. The service samples once
    // per second, so that shows up as a whole tick of "Peak 0s".
    secondsToSwitch: Math.max(0, Math.ceil((nextSwitchMs - now) / 1000)),
    secondsToOffPeakEnd: Math.max(0, Math.ceil((offPeakEndMs - now) / 1000))
  }
}

function isPeakAt(ms) {
  return stateAt(ms).peak
}

// The local calendar day containing `ms`: local midnight to the next local
// midnight, so a DST day is 23 or 25 hours rather than an hour that is silently
// the wrong length.
function localDayBounds(ms) {
  var at = new Date(ms)
  return {
    startMs: new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime(),
    endMs: new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime()
  }
}

// The local day split into contiguous peak/off-peak segments, clipped to the
// day. Built from the real run boundaries rather than fixed hour cells, so a
// zone whose offset is not a whole hour (UTC+05:30) still gets a boundary
// exactly where it belongs instead of rounding it into an hour cell.
function daySegments(ms) {
  var day = localDayBounds(ms)
  var runs = runsAround(day.startMs + (day.endMs - day.startMs) / 2)

  var segments = []
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i]
    var start = Math.max(run.startMs, day.startMs)
    var end = Math.min(run.endMs, day.endMs)
    if (end <= start) continue
    segments.push({ startMs: start, endMs: end, peak: run.peak })
  }
  return segments
}

// Peak ranges inside [startMs, endMs), clipped and merged. Drives the panel's
// "peak hours today" list, which has to read in both zones.
function peakRanges(startMs, endMs) {
  var runs = runsAround(startMs + (endMs - startMs) / 2)
  var ranges = []
  for (var i = 0; i < runs.length; i++) {
    if (!runs[i].peak) continue
    var start = Math.max(runs[i].startMs, startMs)
    var end = Math.min(runs[i].endMs, endMs)
    if (end <= start) continue
    ranges.push({ startMs: start, endMs: end })
  }
  return ranges
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value)
}

function hhmmUtc(ms) {
  var d = new Date(ms)
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes())
}

function hhmmLocal(ms) {
  var d = new Date(ms)
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes())
}

function weekdayUtc(ms) {
  return WEEKDAY_NAMES[new Date(ms).getUTCDay()]
}

function weekdayLocal(ms) {
  return WEEKDAY_NAMES[new Date(ms).getDay()]
}

function isoUtc(ms) {
  return new Date(ms).toISOString()
}

// "2:14:37" — h:mm:ss, hours as long as they need to be.
function formatClock(seconds) {
  var total = Math.max(0, Math.round(Number(seconds) || 0))
  var hours = Math.floor(total / 3600)
  var minutes = Math.floor((total % 3600) / 60)
  return hours + ":" + pad2(minutes) + ":" + pad2(total % 60)
}

// "2h 14m" / "14m 37s" / "37s" — the bar-sized form of the same countdown.
function formatShort(seconds) {
  var total = Math.max(0, Math.round(Number(seconds) || 0))
  var hours = Math.floor(total / 3600)
  var minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return hours + "h " + pad2(minutes) + "m"
  if (minutes > 0) return minutes + "m " + pad2(total % 60) + "s"
  return total + "s"
}

// "UTC+02:00" — an offset, not a zone abbreviation: abbreviations are ambiguous
// across regions and the machine's own locale data is the wrong authority for
// the zone the user is in.
function offsetLabel(ms) {
  var offset = -new Date(ms).getTimezoneOffset()
  var sign = offset < 0 ? "-" : "+"
  var abs = Math.abs(offset)
  return "UTC" + sign + pad2(Math.floor(abs / 60)) + ":" + pad2(abs % 60)
}

// "Fri 09-11" — the local calendar date, with the local weekday, so a boundary
// at local Friday 23:00 is labelled Fri and not the Sat it already is in UTC.
function localDayLabel(ms) {
  var d = new Date(ms)
  return weekdayLocal(ms) + " " + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
}

// Same, in UTC, for a boundary the timetable defines in UTC.
function utcDayLabel(ms) {
  var d = new Date(ms)
  return weekdayUtc(ms) + " " + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate())
}

// Everything the panel draws about the local day, derived once from the real
// run boundaries: the day's bounds, its proportional peak/off-peak segments,
// where "now" falls along them, the peak windows written in both zones, and a
// label naming both ends of the bar.
//
// This lives here rather than in QML so the fractions and the zone conversions
// are covered by tests instead of only by pixels, and so the panel and the CLI
// cannot render different days.
function timeline(ms) {
  var bounds = localDayBounds(ms)
  var segments = daySegments(ms)
  var span = Math.max(1, bounds.endMs - bounds.startMs)

  // Fractions accumulate rather than being computed from each segment's own
  // start, so the segments tile the bar with no rounding seam between them.
  var layout = []
  var cursor = 0
  for (var i = 0; i < segments.length; i++) {
    var width = (segments[i].endMs - segments[i].startMs) / span
    layout.push({ startFrac: cursor, endFrac: cursor + width, peak: segments[i].peak })
    cursor += width
  }

  var peaks = []
  var ranges = peakRanges(bounds.startMs, bounds.endMs)
  for (var j = 0; j < ranges.length; j++) {
    peaks.push({
      localLabel: hhmmLocal(ranges[j].startMs) + " \u2013 " + hhmmLocal(ranges[j].endMs),
      utcLabel: hhmmUtc(ranges[j].startMs) + " \u2013 " + hhmmUtc(ranges[j].endMs)
    })
  }

  return {
    bounds: bounds,
    layout: layout,
    peaks: peaks,
    nowFrac: Math.max(0, Math.min(1, (ms - bounds.startMs) / span)),
    // Both ends named: the day runs local midnight to local midnight, so the
    // closing instant belongs to the following day. Labelling it with the day
    // it closes ("Thu 00:00 -> Thu 00:00") reads as a zero-length span.
    dayLabel: weekdayLocal(bounds.startMs) + " " + hhmmLocal(bounds.startMs) + " \u2192 "
      + weekdayLocal(bounds.endMs) + " " + hhmmLocal(bounds.endMs) + " local"
  }
}

// Shortest honest unit for a sliver of bar space: "10h", "52m", "30s". The
// full "10h 52m" form needs more width than a vertical bar slot has.
function formatCompact(seconds) {
  var total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total >= 3600) return Math.floor(total / 3600) + "h"
  if (total >= 60) return Math.floor(total / 60) + "m"
  return total + "s"
}

// The status document both consumers render, assembled once. The shell passes
// its live `billing`; the CLI passes the same value computed from its own clock.
// Neither maintains a field list, so a field added here appears in both and a
// field removed here leaves both — two hand-kept lists is exactly how the
// shell's `nowLocalOffset` went missing while the CLI's stayed.
//
// Here rather than in Status.js because this is the module both runtimes reach:
// QML imports it, node requires it, and no interop is needed.
//
// Field contract: every `*Utc` field is an ISO 8601 instant, every `*Clock`
// field is "HH:MM", `*LocalDay` is "Fri 09-11". Nothing carries one meaning in
// one consumer and another in the other.
function statusState(billing, overrides) {
  var extra = overrides || {}
  var nowMs = extra.nowMs === undefined ? Date.now() : extra.nowMs
  return {
    peak: billing.peak,
    phaseLabel: billing.peak ? "Peak" : "Off-peak",
    nowMs: nowMs,
    nowLocalClock: hhmmLocal(nowMs),
    nowLocalOffset: offsetLabel(nowMs),
    nowUtcClock: hhmmUtc(nowMs),
    nowUtcInstant: isoUtc(nowMs),
    nextSwitchLabel: billing.peak ? "Off-peak starts" : "Peak starts",
    nextSwitchLocalClock: hhmmLocal(billing.nextSwitchMs),
    nextSwitchUtcClock: hhmmUtc(billing.nextSwitchMs),
    nextSwitchUtcInstant: isoUtc(billing.nextSwitchMs),
    nextSwitchMs: billing.nextSwitchMs,
    nextSwitchLocalDay: localDayLabel(billing.nextSwitchMs),
    nextSwitchUtcDay: utcDayLabel(billing.nextSwitchMs),
    remainingShort: formatShort(billing.secondsToSwitch),
    remainingClock: formatClock(billing.secondsToSwitch),
    secondsToSwitch: billing.secondsToSwitch,
    currentPeriodStartMs: billing.currentStartMs,
    currentPeriodStartUtc: isoUtc(billing.currentStartMs),
    nextOffPeakStartMs: billing.nextOffPeakStartMs,
    nextOffPeakStartUtc: isoUtc(billing.nextOffPeakStartMs),
    offPeakEndMs: billing.offPeakEndMs,
    offPeakEndLocalClock: hhmmLocal(billing.offPeakEndMs),
    offPeakEndUtcClock: hhmmUtc(billing.offPeakEndMs),
    offPeakEndUtcInstant: isoUtc(billing.offPeakEndMs),
    secondsToOffPeakEnd: billing.secondsToOffPeakEnd,
    notificationsEnabled: extra.notificationsEnabled === undefined ? null : extra.notificationsEnabled,
    apiKeySource: extra.apiKeySource === undefined ? "" : extra.apiKeySource,
    schedule: scheduleSummary()
  }
}

function scheduleSummary() {
  return "Peak: weekdays 01:00-04:00 and 06:00-10:00 UTC. Off-peak: all other times, and all weekend."
}

// Which off-peak notification, if any, a tick should send:
//   ""           nothing
//   "startup"    the plugin started in off-peak
//   "transition" peak just became off-peak
//
// `primed` is false only on the very first tick after the plugin loaded. Without
// that distinction every subsequent tick would also look like "we are off-peak
// and the last tick was not", and the startup notice would repeat once a second
// for the entire off-peak stretch. `enabled` is checked here rather than at the
// sender so no caller can send while the switch is off.
function notificationForTick(primed, wasPeak, peak, enabled) {
  if (!enabled) return ""
  if (!primed) return peak ? "" : "startup"
  return (wasPeak && !peak) ? "transition" : ""
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MINUTE_MS: MINUTE_MS,
    HOUR_MS: HOUR_MS,
    DAY_MS: DAY_MS,
    PEAK_WINDOWS: PEAK_WINDOWS,
    utcDayStartMs: utcDayStartMs,
    runsAround: runsAround,
    stateAt: stateAt,
    isPeakAt: isPeakAt,
    localDayBounds: localDayBounds,
    daySegments: daySegments,
    peakRanges: peakRanges,
    hhmmUtc: hhmmUtc,
    hhmmLocal: hhmmLocal,
    weekdayUtc: weekdayUtc,
    weekdayLocal: weekdayLocal,
    isoUtc: isoUtc,
    formatClock: formatClock,
    formatShort: formatShort,
    formatCompact: formatCompact,
    offsetLabel: offsetLabel,
    localDayLabel: localDayLabel,
    utcDayLabel: utcDayLabel,
    timeline: timeline,
    notificationForTick: notificationForTick,
    statusState: statusState,
    scheduleSummary: scheduleSummary
  }
}
