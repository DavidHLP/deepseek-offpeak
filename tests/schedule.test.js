// Self-check for the billing-window math. Run: node tests/schedule.test.js
//
// Every case pins an instant in UTC and asserts the state, the boundaries, and
// the countdown at that instant. The four boundary times are the ones that can
// be got wrong (04:00 and 10:00 must be off-peak, 01:00 and 06:00 peak), and
// the weekend cases are the ones where a naive per-day implementation produces
// a switch at midnight that never happens.

const assert = require("assert")
const S = require("../lib/Schedule.js")

const at = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h || 0, min || 0)
const iso = (ms) => new Date(ms).toISOString()

let checks = 0
function check(name, fn) {
  fn()
  checks++
}

// 2026-09-09 is a Wednesday, 2026-09-11 a Friday, 2026-09-12/13 the weekend.

check("peak windows on a weekday", () => {
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 0, 59)), false, "00:59")
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 1, 0)), true, "01:00 is the start")
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 3, 59)), true, "03:59")
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 4, 0)), false, "04:00 is the end, half-open")
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 5, 59)), false, "05:59")
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 6, 0)), true, "06:00 is the start")
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 9, 59)), true, "09:59")
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 10, 0)), false, "10:00 is the end, half-open")
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 23, 59)), false, "23:59")
})

check("weekends are off-peak all day", () => {
  for (const day of [12, 13]) {
    for (let hour = 0; hour < 24; hour++) {
      assert.strictEqual(S.isPeakAt(at(2026, 9, day, hour, 0)), false,
        `2026-09-${day} ${hour}:00 UTC`)
    }
  }
  // The windows themselves, on a weekend day: still off-peak.
  assert.strictEqual(S.isPeakAt(at(2026, 9, 12, 2, 0)), false, "Saturday inside the 01:00 window")
  assert.strictEqual(S.isPeakAt(at(2026, 9, 13, 8, 0)), false, "Sunday inside the 06:00 window")
})

check("Monday 01:00 is peak again", () => {
  assert.strictEqual(S.isPeakAt(at(2026, 9, 14, 0, 59)), false, "Monday 00:59")
  assert.strictEqual(S.isPeakAt(at(2026, 9, 14, 1, 0)), true, "Monday 01:00")
})

check("boundaries report the right next switch", () => {
  const before = S.stateAt(at(2026, 9, 9, 0, 30))
  assert.strictEqual(iso(before.nextSwitchMs), iso(at(2026, 9, 9, 1, 0)), "01:00 next")
  assert.strictEqual(before.secondsToSwitch, 1800, "30 minutes")

  const peak = S.stateAt(at(2026, 9, 9, 3, 0))
  assert.strictEqual(iso(peak.nextSwitchMs), iso(at(2026, 9, 9, 4, 0)), "04:00 next")
  assert.strictEqual(iso(peak.offPeakEndMs), iso(at(2026, 9, 9, 6, 0)), "off-peak runs to 06:00")

  const second = S.stateAt(at(2026, 9, 9, 9, 0))
  assert.strictEqual(iso(second.nextSwitchMs), iso(at(2026, 9, 9, 10, 0)), "10:00 next")
  assert.strictEqual(iso(second.offPeakEndMs), iso(at(2026, 9, 10, 1, 0)), "off-peak runs to tomorrow 01:00")
})

check("weekend off-peak runs to Monday 01:00, not midnight", () => {
  const friday = S.stateAt(at(2026, 9, 11, 10, 0))
  assert.strictEqual(friday.peak, false)
  assert.strictEqual(iso(friday.nextSwitchMs), iso(at(2026, 9, 14, 1, 0)),
    "Friday 10:00 is off-peak until Monday 01:00")

  const sunday = S.stateAt(at(2026, 9, 13, 23, 0))
  assert.strictEqual(iso(sunday.nextSwitchMs), iso(at(2026, 9, 14, 1, 0)), "Sunday 23:00")
  assert.strictEqual(sunday.secondsToSwitch, 2 * 3600, "two hours left")

  const monday = S.stateAt(at(2026, 9, 14, 0, 30))
  assert.strictEqual(monday.peak, false)
  assert.strictEqual(iso(monday.offPeakEndMs), iso(at(2026, 9, 14, 1, 0)), "half an hour of off-peak left")
})

check("currentPeriodStart spans the merged off-peak run", () => {
  const sunday = S.stateAt(at(2026, 9, 13, 12, 0))
  assert.strictEqual(iso(sunday.currentStartMs), iso(at(2026, 9, 11, 10, 0)),
    "the stretch began Friday 10:00")
})

check("countdowns are never negative, at either edge of a window", () => {
  const edges = [
    at(2026, 9, 9, 1, 0), at(2026, 9, 9, 4, 0), at(2026, 9, 9, 6, 0), at(2026, 9, 9, 10, 0),
    at(2026, 9, 12, 0, 0), at(2026, 9, 14, 1, 0)
  ]
  for (const edge of edges) {
    const state = S.stateAt(edge)
    assert.ok(state.secondsToSwitch >= 0, `secondsToSwitch at ${iso(edge)}`)
    assert.ok(state.secondsToOffPeakEnd >= 0, `secondsToOffPeakEnd at ${iso(edge)}`)
    assert.ok(state.nextSwitchMs >= edge, `nextSwitchMs at ${iso(edge)}`)
  }
  // One millisecond before each boundary must already be counting to it.
  for (const edge of edges) {
    const justBefore = S.stateAt(edge - 1)
    assert.ok(justBefore.nextSwitchMs >= edge - 1, `nextSwitchMs at ${iso(edge - 1)}`)
    assert.ok(justBefore.secondsToSwitch >= 0, `seconds at ${iso(edge - 1)}`)
  }
})

check("a whole week of ticks never goes backwards or negative", () => {
  let previous
  for (let ms = at(2026, 9, 7, 0, 0); ms < at(2026, 9, 14, 0, 0); ms += 60 * 1000) {
    const state = S.stateAt(ms)
    assert.ok(state.secondsToSwitch >= 0, `negative at ${iso(ms)}`)
    if (previous) {
      assert.ok(state.nextSwitchMs >= previous.nextSwitchMs, `switch time moved back at ${iso(ms)}`)
    }
    previous = state
  }
})

check("off-peak start reported while off-peak is already running", () => {
  const peak = S.stateAt(at(2026, 9, 9, 3, 0))
  assert.strictEqual(iso(peak.nextOffPeakStartMs), iso(at(2026, 9, 9, 4, 0)),
    "from peak, the next off-peak start is the upcoming switch")

  const flat = S.stateAt(at(2026, 9, 9, 5, 0))
  assert.strictEqual(iso(flat.nextOffPeakStartMs), iso(flat.currentStartMs),
    "already off-peak: it started when this stretch did")
})

check("notifications fire once for a transition, once for a startup, never when off", () => {
  // Startup while off-peak: exactly one, on the first tick.
  assert.strictEqual(S.notificationForTick(false, false, false, true), "startup")
  // Every later tick while still off-peak: nothing.
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(S.notificationForTick(true, false, false, true), "")
  }
  // Peak -> off-peak: one notification, and only on that tick.
  assert.strictEqual(S.notificationForTick(true, true, false, true), "transition")
  assert.strictEqual(S.notificationForTick(true, false, false, true), "")
  // Startup while peak: nothing (there was no off-peak to announce).
  assert.strictEqual(S.notificationForTick(false, true, true, true), "")
  // A transition while the switch is off: nothing, and the switch stays off.
  assert.strictEqual(S.notificationForTick(true, true, false, false), "")
  assert.strictEqual(S.notificationForTick(false, false, false, false), "")
})

check("day segments tile the local day exactly", () => {
  const day = S.localDayBounds(at(2026, 9, 9, 12, 0))
  const segments = S.daySegments(at(2026, 9, 9, 12, 0))
  assert.ok(segments.length > 0, "segments exist")
  assert.strictEqual(segments[0].startMs, day.startMs, "starts at local midnight")
  assert.strictEqual(segments[segments.length - 1].endMs, day.endMs, "ends at next local midnight")
  for (let i = 1; i < segments.length; i++) {
    assert.strictEqual(segments[i].startMs, segments[i - 1].endMs, "no gap between segments")
    assert.notStrictEqual(segments[i].peak, segments[i - 1].peak, "adjacent segments differ")
  }
  const peakSeconds = segments.filter((s) => s.peak)
    .reduce((sum, s) => sum + (s.endMs - s.startMs), 0) / 1000
  assert.strictEqual(peakSeconds, 7 * 3600, "7 peak hours on a weekday")
})

check("peak ranges are the windows themselves on a weekday", () => {
  const day = S.localDayBounds(at(2026, 9, 9, 12, 0))
  const ranges = S.peakRanges(day.startMs, day.endMs)
  assert.strictEqual(ranges.length, 2, "two peak ranges")
  for (const range of ranges) {
    assert.ok(range.endMs > range.startMs, "range is not empty")
  }
})

check("weekend has no peak ranges", () => {
  const day = S.localDayBounds(at(2026, 9, 12, 12, 0))
  assert.deepStrictEqual(S.peakRanges(day.startMs, day.endMs), [], "Saturday")
})

check("formatters", () => {
  assert.strictEqual(S.formatClock(0), "0:00:00")
  assert.strictEqual(S.formatClock(-5), "0:00:00", "negative clamps")
  assert.strictEqual(S.formatClock(3661), "1:01:01")
  assert.strictEqual(S.formatClock(11 * 3600 + 32 * 60 + 44), "11:32:44")
  assert.strictEqual(S.formatShort(59), "59s")
  assert.strictEqual(S.formatShort(60), "1m 00s")
  assert.strictEqual(S.formatShort(3600), "1h 00m")
  assert.strictEqual(S.formatShort(-1), "0s", "negative clamps")
  assert.strictEqual(S.hhmmUtc(at(2026, 9, 9, 1, 0)), "01:00")
})

check("the day timeline tiles the local day and marks it in both zones", () => {
  const day = S.timeline(at(2026, 9, 9, 12, 0))

  // Layout fractions: contiguous, starting at 0, ending at 1, alternating state.
  assert.strictEqual(day.layout[0].startFrac, 0, "bar starts at the left edge")
  assert.ok(Math.abs(day.layout[day.layout.length - 1].endFrac - 1) < 1e-9, "bar reaches the right edge")
  for (let i = 1; i < day.layout.length; i++) {
    assert.ok(Math.abs(day.layout[i].startFrac - day.layout[i - 1].endFrac) < 1e-9,
      "no seam between segments")
    assert.notStrictEqual(day.layout[i].peak, day.layout[i - 1].peak, "adjacent segments differ")
  }

  // "now" is a real fraction of that day, never outside it.
  assert.ok(day.nowFrac >= 0 && day.nowFrac <= 1, `nowFrac ${day.nowFrac}`)

  // Peak windows, written in both zones, are the two weekday windows.
  assert.strictEqual(day.peaks.length, 2, "two peak windows")
  for (const peak of day.peaks) {
    assert.ok(/^\d{2}:\d{2} \u2013 \d{2}:\d{2}$/.test(peak.localLabel), peak.localLabel)
    assert.ok(/^\d{2}:\d{2} \u2013 \d{2}:\d{2}$/.test(peak.utcLabel), peak.utcLabel)
  }
})

check("the timeline label names both ends, so it never reads as zero-length", () => {
  const day = S.timeline(at(2026, 9, 9, 12, 0))
  const [startLabel, endLabel] = day.dayLabel.replace(" local", "").split(" \u2192 ")
  assert.ok(startLabel && endLabel, day.dayLabel)
  // Midnight to midnight: the two ends are the same clock time on different
  // days. Printing the opening day for both is the bug this guards.
  const startClock = startLabel.split(" ")[1]
  const endClock = endLabel.split(" ")[1]
  assert.strictEqual(startClock, endClock, "the span runs midnight to midnight")
  assert.notStrictEqual(startLabel.split(" ")[0], endLabel.split(" ")[0],
    `the closing end must name the next day: ${day.dayLabel}`)
})

check("a weekend day's timeline has no peak segments at all", () => {
  const day = S.timeline(at(2026, 9, 12, 12, 0))
  assert.deepStrictEqual(day.peaks, [], "Saturday has no peak windows")
  assert.strictEqual(day.layout.length, 1, "one continuous off-peak bar")
  assert.strictEqual(day.layout[0].peak, false)
})

check("day labels carry the weekday of the zone they are written in", () => {
  // 23:00 UTC on a Friday is already Saturday in UTC+8, and these two labels
  // must not agree about which day it is outside UTC.
  const fridayLate = at(2026, 9, 11, 23, 0)
  const utc = S.utcDayLabel(fridayLate)
  const local = S.localDayLabel(fridayLate)
  assert.ok(utc.startsWith("Fri "), utc)
  assert.ok(/^(Fri|Sat) /.test(local), local)
  assert.strictEqual(utc, "Fri 09-11")
  // The UTC label is the UTC calendar date, always.
  assert.ok(utc.includes("09-11"), utc)
})

check("compact durations stay inside a bar slot", () => {
  assert.strictEqual(S.formatCompact(0), "0s")
  assert.strictEqual(S.formatCompact(-5), "0s", "negative clamps")
  assert.strictEqual(S.formatCompact(45), "45s")
  assert.strictEqual(S.formatCompact(60), "1m")
  assert.strictEqual(S.formatCompact(3599), "59m")
  assert.strictEqual(S.formatCompact(3600), "1h")
  assert.strictEqual(S.formatCompact(11 * 3600 + 52 * 60), "11h")
  // Never longer than four characters, which is what the vertical slot holds.
  for (const seconds of [0, 9, 59, 60, 599, 3599, 3600, 35999, 86399, 999999]) {
    assert.ok(S.formatCompact(seconds).length <= 4, `${seconds} -> ${S.formatCompact(seconds)}`)
  }
})

console.log(`schedule: ${checks} checks passed`)
