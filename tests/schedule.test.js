// Self-check for the billing-window math. Run: node tests/schedule.test.js
//
// Every case pins an instant in UTC and asserts the state, the boundaries, and
// the countdown at that instant. The four boundary times are the ones that can
// be got wrong (04:00 and 10:00 must be off-peak, 01:00 and 06:00 peak), the
// weekend cases are the ones where a naive per-day implementation produces a
// switch at midnight that never happens, and the holiday cases are the ones
// where a run of off-peak days outlasts any fixed horizon.

const assert = require("assert")
const S = require("../lib/Schedule.js")
const H = require("../lib/Holidays.js")

// The published 2026 arrangement, which is what the plugin schedules from when
// it cannot fetch anything: 元旦 01-01..01-03, 春节 02-15..02-23, 清明节
// 04-04..04-06, 劳动节 05-01..05-05, 端午节 06-19..06-21, 中秋节 09-25..09-27,
// 国庆节 10-01..10-07. Its own correctness is checked in holidays.test.js.
const holidays = H.fallback()

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

check("a countdown reads zero only after its boundary, never just before", () => {
  // Ceiling, not rounding. Rounding reaches zero up to 499ms before the switch,
  // and the service samples once per second, so a whole tick of "Peak 0s" could
  // be shown while `peak` still described the interval being left. Sub-second
  // steps are the only way to land inside that window — a whole-second sweep
  // steps straight over it.
  for (let ms = at(2026, 9, 10, 0, 59, 0); ms < at(2026, 9, 10, 1, 1, 0); ms += 37) {
    const state = S.stateAt(ms)
    if (state.secondsToSwitch === 0) {
      assert.ok(ms >= state.nextSwitchMs,
        `read 0s at ${iso(ms)} with the switch still ahead at ${iso(state.nextSwitchMs)}`)
    }
    if (state.secondsToOffPeakEnd === 0) {
      assert.ok(ms >= state.offPeakEndMs,
        `read 0s of off-peak at ${iso(ms)} with it ending at ${iso(state.offPeakEndMs)}`)
    }
  }

  // One millisecond before the boundary is one second on the clock, and the
  // state has not flipped. Those are the two facts rounding got wrong.
  const before = S.stateAt(at(2026, 9, 10, 1, 0, 0) - 1)
  assert.strictEqual(before.secondsToSwitch, 1, "1ms before the switch must read 1s")
  assert.strictEqual(before.peak, false, "and must not have flipped yet")

  // At the boundary the new window is already in force — half-open, so 01:00 is
  // peak — and the countdown is that window's full length rather than zero.
  const boundary = S.stateAt(at(2026, 9, 10, 1, 0, 0))
  assert.strictEqual(boundary.peak, true, "01:00 UTC is peak")
  assert.strictEqual(boundary.secondsToSwitch, 3 * 3600, "with three hours left in it")
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

// ---------------------------------------------------------------- holidays
//
// A Chinese public holiday is billed off-peak all day, so a weekday that is one
// has no peak windows. The four checks below are the rule, the two long runs it
// produces, and the make-up workdays that change nothing.

check("a public holiday has no peak windows, and the same weekday without one does", () => {
  // Monday 2026-10-05, inside 国庆节.
  for (let hour = 0; hour < 24; hour++) {
    assert.strictEqual(S.isPeakAt(at(2026, 10, 5, hour, 0), holidays), false,
      `2026-10-05 ${hour}:00 UTC is in a holiday`)
  }
  // Monday 2026-10-12, an ordinary Monday: both windows fire.
  assert.strictEqual(S.isPeakAt(at(2026, 10, 12, 1, 0), holidays), true, "01:00")
  assert.strictEqual(S.isPeakAt(at(2026, 10, 12, 6, 0), holidays), true, "06:00")
  assert.strictEqual(S.isPeakAt(at(2026, 10, 12, 10, 0), holidays), false, "10:00")

  // The table is what did it: with no table the holiday schedules as a weekday.
  assert.strictEqual(S.isPeakAt(at(2026, 10, 5, 1, 0)), true, "no table, no holidays")
})

check("a holiday week is one off-peak run, to the minute it ends", () => {
  // 国庆节 10-01..10-07 is Thursday to Wednesday, so the run starts after
  // Wednesday 09-30's last window and ends at Thursday 10-08's first.
  const before = S.stateAt(at(2026, 9, 30, 10, 0), holidays)
  assert.strictEqual(before.peak, false)
  assert.strictEqual(iso(before.nextSwitchMs), iso(at(2026, 10, 8, 1, 0)),
    "off-peak from Wednesday 10:00 until the following Thursday 01:00")

  const inside = S.stateAt(at(2026, 10, 5, 3, 0), holidays)
  assert.strictEqual(inside.peak, false)
  assert.strictEqual(iso(inside.currentStartMs), iso(at(2026, 9, 30, 10, 0)),
    "the stretch began the day the holiday did")
  assert.strictEqual(inside.secondsToSwitch, (at(2026, 10, 8, 1, 0) - at(2026, 10, 5, 3, 0)) / 1000)

  // And Thursday 08-10 is peak again, one second into its first window.
  assert.strictEqual(S.isPeakAt(at(2026, 10, 8, 1, 0), holidays), true)
  assert.strictEqual(S.isPeakAt(at(2026, 10, 8, 0, 59), holidays), false)

  const day = S.timeline(at(2026, 10, 5, 12, 0), holidays)
  assert.deepStrictEqual(day.peaks, [], "a holiday has no peak windows to list")
  assert.strictEqual(day.layout.length, 1, "one continuous off-peak bar")
  assert.strictEqual(day.layout[0].peak, false)
})

check("the Spring Festival run is longer than any fixed horizon could reach", () => {
  // 春节 02-15..02-23 is nine days starting on a Sunday, so the surrounding
  // weekend and the days either side make one run from Friday 02-13 10:00 to
  // Tuesday 02-24 01:00 — 255 hours. A horizon of a few days would truncate it,
  // reporting a switch that never happens and a stretch that began at midnight.
  const start = S.stateAt(at(2026, 2, 13, 10, 0), holidays)
  assert.strictEqual(start.peak, false)
  assert.strictEqual(iso(start.nextSwitchMs), iso(at(2026, 2, 24, 1, 0)))

  const inside = S.stateAt(at(2026, 2, 20, 3, 0), holidays)
  assert.ok(inside.nextSwitchMs - inside.currentStartMs > 10 * 24 * 3600 * 1000,
    "the run is more than ten days long")
  assert.strictEqual(iso(inside.currentStartMs), iso(at(2026, 2, 13, 10, 0)))
  assert.strictEqual(iso(inside.nextSwitchMs), iso(at(2026, 2, 24, 1, 0)))
  assert.strictEqual(inside.peak, false)

  // Tuesday 02-24 is an ordinary Tuesday, and its first window is peak.
  assert.strictEqual(S.isPeakAt(at(2026, 2, 24, 1, 0), holidays), true)
})

check("the 调休 make-up workdays change nothing: they are weekends either way", () => {
  // 元旦 01-04 (Sunday), 春节 02-14 and 02-28 (Saturdays), 劳动节 05-09, 国庆节
  // 09-20 and 10-10 — the days the notice makes people work. DeepSeek bills them
  // off-peak, which is what a Saturday or a Sunday is here.
  for (const [month, day] of [[1, 4], [2, 14], [2, 28], [5, 9], [9, 20], [10, 10]]) {
    const ms = at(2026, month, day, 2, 0)
    const weekday = new Date(ms).getUTCDay()
    assert.ok(weekday === 0 || weekday === 6, `2026-${month}-${day} is not a weekend`)
    assert.strictEqual(S.isPeakAt(ms, holidays), false, `2026-${month}-${day} must be off-peak`)
  }
})

check("a table changes only the dates it names", () => {
  // Wednesday 2026-09-09, named by a table of one date, against the day after.
  const table = { "2026-09-09": "test" }
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 1, 0), table), false)
  assert.strictEqual(S.isPeakAt(at(2026, 9, 9, 6, 0), table), false)
  assert.strictEqual(S.isPeakAt(at(2026, 9, 10, 1, 0), table), true, "Thursday is untouched")
  assert.strictEqual(S.holidayName(at(2026, 9, 9, 1, 0), table), "test")
  assert.strictEqual(S.holidayName(at(2026, 9, 10, 1, 0), table), "", "no holiday, no name")
})

check("the holiday a name belongs to is the Beijing date's", () => {
  // 16:00 UTC is midnight in Beijing, which is where the date changes. 国庆节
  // ends on 10-07, so the last instant that is still in it is 15:59 UTC.
  assert.strictEqual(S.holidayName(at(2026, 10, 7, 15, 59), holidays), "国庆节")
  assert.strictEqual(S.holidayName(at(2026, 10, 7, 16, 0), holidays), "", "already 10-08 in Beijing")
  assert.strictEqual(S.holidayName(at(2026, 10, 6, 15, 0), holidays), "国庆节", "Beijing 23:00 on the 6th")

  // The same boundary at the year end: 2026-12-31 16:00 UTC is 2027 in Beijing,
  // which is the year whose arrangement a January fetch has to ask for.
  assert.strictEqual(S.beijingDateKey(at(2026, 12, 31, 15, 59)), "2026-12-31")
  assert.strictEqual(S.beijingDateKey(at(2026, 12, 31, 16, 0)), "2027-01-01")
  assert.strictEqual(S.beijingYear(at(2026, 12, 31, 16, 0)), 2027)
  assert.strictEqual(S.beijingDateKey(at(2026, 12, 31, 16, 0)), S.dateKeyUtc(at(2027, 1, 1, 0, 0)),
    "the Beijing date is the UTC date eight hours later")
})

check("a whole holiday window never goes backwards or negative", () => {
  // Five-minute steps from the last ordinary day of September through the whole
  // 国庆节 stretch. The countdown crosses two merged runs and a holiday in the
  // middle of the week, which is where a walked horizon can go wrong.
  let previous
  for (let ms = at(2026, 9, 29, 0, 0); ms < at(2026, 10, 10, 0, 0); ms += 5 * 60 * 1000) {
    const state = S.stateAt(ms, holidays)
    assert.ok(state.secondsToSwitch >= 0, `negative at ${iso(ms)}`)
    assert.ok(state.nextSwitchMs >= ms, `a switch in the past at ${iso(ms)}`)
    if (previous) {
      assert.ok(state.nextSwitchMs >= previous.nextSwitchMs, `switch time moved back at ${iso(ms)}`)
      assert.ok(state.currentStartMs >= previous.currentStartMs, `run start moved back at ${iso(ms)}`)
    }
    previous = state
  }
})

console.log(`schedule: ${checks} checks passed`)
