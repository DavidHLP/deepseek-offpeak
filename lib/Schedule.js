// DeepSeek billing-window math.
//
// Peak hours are weekdays 01:00-04:00 and 06:00-10:00 UTC — 09:00-12:00 and
// 14:00-18:00 Beijing time, which is the zone DeepSeek publishes the timetable
// in. Every other instant is off-peak; Saturday and Sunday are off-peak all
// day; and so is a Chinese public holiday, which is why every function that
// asks "is this hour peak?" takes a holiday table as well as an instant. See
// lib/Holidays.js for where that table comes from.
//
// Windows are half-open ([01:00, 04:00)) so a boundary instant belongs to the
// window that starts there: 04:00 is off-peak, 06:00 is peak, 10:00 is off-peak.
//
// The table is a parameter rather than a lookup performed here: the math stays
// pure and testable, and a caller that passes no table gets the weekday rule on
// its own — which is what this module did before the table existed.
//
// This module never consults the DeepSeek API — server load and API
// availability are not billing state, and the discount windows are a published
// timetable.
//
// Pure and I/O-free: imported by Service.qml and Panel.qml, required by
// bin/deepseek-offpeak and by tests/schedule.test.js. Every function takes the
// instant it should reason about, so nothing here reads the clock implicitly.

var MINUTE_MS = 60000
var HOUR_MS = 3600000
var DAY_MS = 86400000

// Beijing is UTC+8 all year — no daylight saving, so this is an offset and not a
// zone rule. It is used only to name the calendar date a holiday table is keyed
// by, never to move a window.
var BEIJING_OFFSET_MS = 8 * HOUR_MS

// How far `runsAround` will walk looking for the boundaries of the run holding
// an instant before it gives up and reports what it has. The longest run the
// published timetable can produce is the Spring Festival break, ten days and
// more; this sits far above it. It is a stop for a table that is wrong, not a
// horizon the normal case approaches — see runsAround.
var HORIZON_CAP_DAYS = 32

// Peak windows for a weekday, as [startMinute, endMinute) since 00:00 UTC.
var PEAK_WINDOWS = [[60, 240], [360, 600]]

var WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function utcDayStartMs(ms) {
  var d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

// "2026-10-01" — a UTC calendar date, the key a holiday table is written in.
function dateKeyUtc(ms) {
  var d = new Date(ms)
  return String(d.getUTCFullYear()) + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate())
}

// The same for the Beijing calendar date containing `ms`. A Chinese holiday is
// a date in Beijing, so this — not the local date and not the UTC one — is the
// date that decides billing: at 2026-10-07 23:00 UTC it is already the 8th in
// Beijing, and the 8th is an ordinary Thursday.
function beijingDateKey(ms) {
  var d = new Date(Number(ms) + BEIJING_OFFSET_MS)
  return String(d.getUTCFullYear()) + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate())
}

function beijingYear(ms) {
  return Number(beijingDateKey(ms).slice(0, 4))
}

// Does the day beginning at `dayStartMs` — a UTC midnight — contain peak
// windows? It does when it is a Monday to Friday that is not a Chinese public
// holiday.
//
// One lookup decides the whole day, and the date it looks up is the day's UTC
// date, which for every peak window in it is also its Beijing date: the windows
// sit at 01:00-10:00 UTC, i.e. 09:00-18:00 Beijing, inside the same calendar
// date. The hours of a UTC day that fall on the following Beijing date are
// off-peak under every rule, so no window is ever decided by them.
function hasPeakWindows(dayStartMs, holidays) {
  var dayOfWeek = new Date(dayStartMs).getUTCDay()
  if (dayOfWeek === 0 || dayOfWeek === 6) return false
  if (holidays && holidays[dateKeyUtc(dayStartMs)]) return false
  return true
}

// The Chinese public holiday covering `ms`, by name, or "". This answers for the
// Beijing date containing `ms` — the date whose holiday status decides the
// day's pricing — not for the local or the UTC date.
function holidayName(ms, holidays) {
  if (!holidays) return ""
  var name = holidays[beijingDateKey(ms)]
  return typeof name === "string" ? name : ""
}

// The day at `dayStartMs` split into contiguous intervals of constant state.
// A day with peak windows alternates off/peak/off/peak/off; a weekend or a
// holiday is one off-peak day.
function intervalsForDay(dayStartMs, holidays) {
  if (!hasPeakWindows(dayStartMs, holidays))
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

// Contiguous, merged runs of constant state, generated outward from the day
// containing `ms` until a day with peak windows has been included on each side.
// Adjacent intervals of the same state are folded together, which is what makes
// "off-peak until 01:00 Monday" come out as one run across the whole weekend
// instead of a spurious switch at each midnight.
//
// The horizon is walked rather than fixed, because how long a run can be is now
// data: a day with peak windows is what bounds a run, and the holiday table
// decides which days have any. Before that table the longest run was Friday
// 10:00 to Monday 01:00 — 63 hours, cleared by a fixed ±3 days — and with it the
// Spring Festival break runs off-peak from the Friday before it to the Tuesday
// after: ten days and more. A horizon that no longer reaches a boundary
// truncates the run, inventing a switch at the edge of the generated range
// forward and reporting the current stretch as having begun there backward.
//
// So the walk is the horizon: back until a day with peak windows is included
// (its last window ends where the run containing `ms` starts), forward until one
// is included too (its first window is where that run ends). HORIZON_CAP_DAYS
// stops a table that marks every day off-peak from walking forever; a run longer
// than the cap would be reported as starting at the cap, and nothing the
// published timetable can produce comes close to it.
function runsAround(ms, holidays) {
  var dayStart = utcDayStartMs(ms)

  // Whole days off a UTC midnight stay UTC midnights, so this is exact.
  //
  // Both walks start one day out and stop at a day that has peak windows, so
  // there is always one on each side of the day holding `ms` — even when that
  // day has windows of its own. They are what bound the runs on either side of
  // the one containing `ms`, and the day after a peak run is where the off-peak
  // stretch following it ends.
  var back = 1
  while (back < HORIZON_CAP_DAYS && !hasPeakWindows(dayStart - back * DAY_MS, holidays)) back++
  var forward = 1
  while (forward < HORIZON_CAP_DAYS && !hasPeakWindows(dayStart + forward * DAY_MS, holidays)) forward++

  var intervals = []
  for (var dayOffset = -back; dayOffset <= forward; dayOffset++)
    intervals = intervals.concat(intervalsForDay(dayStart + dayOffset * DAY_MS, holidays))

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
//
// `holidays` is the table from lib/Holidays.js, or nothing (see the header).
function stateAt(ms, holidays) {
  var now = Number(ms)
  var runs = runsAround(now, holidays)
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

function isPeakAt(ms, holidays) {
  return stateAt(ms, holidays).peak
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
function daySegments(ms, holidays) {
  var day = localDayBounds(ms)
  var runs = runsAround(day.startMs + (day.endMs - day.startMs) / 2, holidays)

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
function peakRanges(startMs, endMs, holidays) {
  var runs = runsAround(startMs + (endMs - startMs) / 2, holidays)
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
function timeline(ms, holidays) {
  var bounds = localDayBounds(ms)
  var segments = daySegments(ms, holidays)
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
  var ranges = peakRanges(bounds.startMs, bounds.endMs, holidays)
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
    // The holiday behind today's pricing, or "". Passed in through `overrides`
    // because this module reads no table of its own.
    holidayName: holidayName(nowMs, extra.holidays),
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
    schedule: scheduleSummary(extra.holidayYears)
  }
}

// The rule in one sentence, for the panel and the CLI. The windows are given in
// both zones because they are published in Beijing and the timetable here is
// UTC, and the years are named when a caller supplies them: which years the
// holiday table covers is the one visible sign that it is being read rather than
// falling back to the years baked into lib/Holidays.js.
function scheduleSummary(holidayYears) {
  var years = holidayYears === undefined || holidayYears === null ? "" : String(holidayYears)
  return "Peak: weekdays 01:00-04:00 and 06:00-10:00 UTC, 09:00-12:00 and 14:00-18:00 Beijing."
    + " Off-peak: every other hour, all weekend, and Chinese public holidays all day"
    + (years === "" ? "." : " (" + years + ").")
}

// Which off-peak notification, if any, a tick should send:
//   ""           nothing
//   "transition" peak just became off-peak, and this session watched it happen
//
// A transition the caller watched, and nothing else. Starting in off-peak is not
// an event: the state is on screen already, and "off-peak has started" would be
// a claim about a boundary that may be hours old. It is also not once per
// session — the shell rebuilds a plugin's service on every file change and every
// reload (see omarchy's `onLocalPluginChanged`), so a notice sent at startup is
// sent again on every edit, which is 10 notifications in four minutes the last
// time this plugin was worked on.
//
// A caller that starts in off-peak therefore stays quiet, and the first state it
// compares against is the one it found: `wasPeak` and `peak` both come from the
// ticks it actually sees.
//
// `enabled` is checked here rather than at the sender so no caller can send
// while the switch is off.
function notificationForTick(wasPeak, peak, enabled) {
  if (!enabled) return ""
  return (wasPeak && !peak) ? "transition" : ""
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MINUTE_MS: MINUTE_MS,
    HOUR_MS: HOUR_MS,
    DAY_MS: DAY_MS,
    BEIJING_OFFSET_MS: BEIJING_OFFSET_MS,
    HORIZON_CAP_DAYS: HORIZON_CAP_DAYS,
    PEAK_WINDOWS: PEAK_WINDOWS,
    utcDayStartMs: utcDayStartMs,
    dateKeyUtc: dateKeyUtc,
    beijingDateKey: beijingDateKey,
    beijingYear: beijingYear,
    hasPeakWindows: hasPeakWindows,
    holidayName: holidayName,
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
