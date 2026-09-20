// Self-check for the holiday table. Run: node tests/holidays.test.js
//
// Two things are being checked, and they fail differently. The parse is the
// trust boundary — fetched text that ends up on screen and, if it is wrong,
// silently changes which days bill as peak — so the cases below are the shapes a
// hostile or broken response can take. The baked table is data, and a typo in it
// costs a wrong day once a year, so it is checked against the notice it was
// transcribed from: every span, every name, and every date real.

const assert = require("assert")
const H = require("../lib/Holidays.js")

let checks = 0
function check(name, fn) {
  fn()
  checks++
}

// A document in the shape holiday-cn publishes, as the shell would read it.
function document(days, year) {
  return JSON.stringify({ year: year === undefined ? 2026 : year, days: days })
}
// `name` is only defaulted when it is absent: an explicitly empty or non-string
// name is one of the shapes being tested.
const offDay = (date, name) => ({ name: name === undefined ? "春节" : name, date: date, isOffDay: true })
const workday = (date, name) => ({ name: name === undefined ? "春节" : name, date: date, isOffDay: false })

check("a document parses into the dates the schedule keys on", () => {
  const parsed = H.parse(document([
    offDay("2026-10-01", "国庆节"), workday("2026-10-10", "国庆节"), offDay("2026-10-02", "国庆节")
  ]))
  assert.strictEqual(parsed.ok, true, parsed.error)
  assert.deepStrictEqual(Object.keys(parsed.days).sort(), ["2026-10-01", "2026-10-02"])
  assert.strictEqual(parsed.days["2026-10-01"], "国庆节")
})

check("make-up workdays are dropped, not stored", () => {
  // 调休 上班 days are weekends, and weekends are off-peak whether they are
  // worked or not — keeping them would add rows nothing reads.
  const parsed = H.parse(document([workday("2026-02-14"), workday("2026-02-28")]))
  assert.strictEqual(parsed.ok, true)
  assert.deepStrictEqual(parsed.days, {})
})

check("a document that is not the documented shape is rejected whole", () => {
  const cases = [
    ["", "empty"],
    ["not json", "not JSON"],
    ["[]", "an array"],
    ["null", "null"],
    [JSON.stringify({}), "no days"],
    [document("nope"), "days is not an array"],
    [document([1, 2, 3]), "entries are not objects"],
    [document([offDay("2026-10-1")]), "a date without its leading zero"],
    [document([offDay("2026-02-30")]), "a date that does not exist"],
    [document([offDay("2026-13-01")]), "a month that does not exist"],
    [document([offDay("2026-10-01", "")]), "an empty name"],
    [document([offDay("2026-10-01", "x".repeat(H.MAX_NAME_LENGTH + 1))]), "an oversized name"],
    [document([offDay("2026-10-01", "国庆\u001b[31m节")]), "a control character in the name"],
    [document([offDay("2026-10-01", null)]), "a null name"],
    [document([offDay("2026-10-01", "国庆节")], 2025), "a date from another year"],
    [document(new Array(H.MAX_DAYS + 1).fill(offDay("2026-10-01"))), "too many days"],
    ["x".repeat(H.MAX_CACHE_BYTES + 1), "oversized"]
  ]
  for (const [text, label] of cases) {
    const parsed = H.parse(text)
    assert.strictEqual(parsed.ok, false, `${label} was accepted`)
    assert.strictEqual(parsed.error, H.ERROR_INVALID, label)
    assert.deepStrictEqual(parsed.days, {}, label)
  }
  // And the types a caller can get wrong rather than the document.
  for (const value of [null, undefined, 42, {}]) {
    assert.strictEqual(H.parse(value).ok, false, String(value))
  }
})

check("a document with no declared year is still usable", () => {
  const parsed = H.parse(JSON.stringify({ days: [offDay("2026-10-01")] }))
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.days["2026-10-01"], "春节")
})

check("the baked table is the published 2026 arrangement", () => {
  // 国务院办公厅关于2026年部分节假日安排的通知 (国办发明电〔2025〕7号), the notice
  // holiday-cn's own 2026 document cites. Spans as published; the weekends inside
  // them are already off-peak but are kept so this reads as the notice does.
  const spans = [
    ["元旦", "2026-01-01", "2026-01-03"],
    ["春节", "2026-02-15", "2026-02-23"],
    ["清明节", "2026-04-04", "2026-04-06"],
    ["劳动节", "2026-05-01", "2026-05-05"],
    ["端午节", "2026-06-19", "2026-06-21"],
    ["中秋节", "2026-09-25", "2026-09-27"],
    ["国庆节", "2026-10-01", "2026-10-07"]
  ]

  const expected = {}
  for (const [name, from, to] of spans) {
    for (let ms = Date.parse(from + "T00:00:00Z"); ms <= Date.parse(to + "T00:00:00Z"); ms += 86400000) {
      const date = new Date(ms).toISOString().slice(0, 10)
      assert.strictEqual(expected[date], undefined, `${date} is in two spans`)
      expected[date] = name
    }
  }

  const table = H.fallback()
  assert.deepStrictEqual(table, expected, "the baked table is not the published arrangement")
  assert.strictEqual(Object.keys(table).length, 33, "33 放假 days in 2026")
  assert.deepStrictEqual(H.yearsOf(table), [2026])
})

check("every baked date is a real date, and no date is repeated across tables", () => {
  for (const key of Object.keys(H.FALLBACK)) {
    assert.ok(H.isDateKey(key), key)
    assert.strictEqual(typeof H.FALLBACK[key], "string")
    assert.ok(H.FALLBACK[key].length > 0 && H.FALLBACK[key].length <= H.MAX_NAME_LENGTH, key)
  }
})

check("the baked table is handed out as a copy", () => {
  const table = H.fallback()
  table["2026-10-01"] = "something else"
  table["2026-12-25"] = "yes"
  assert.strictEqual(H.FALLBACK["2026-10-01"], "国庆节", "the module's own table was edited")
  assert.strictEqual(H.FALLBACK["2026-12-25"], undefined)
})

check("cache documents override the baked table, and junk is skipped", () => {
  // The fetched name wins for a date both know.
  const table = H.tableFromTexts([document([offDay("2026-10-01", "National Day")])])
  assert.strictEqual(table["2026-10-01"], "National Day")
  assert.deepStrictEqual(H.yearsOf(table), [2026])

  // A document that strays outside the year it declares is rejected whole, so it
  // changes nothing — not even the date it got right.
  const strayed = H.tableFromTexts([document([
    offDay("2026-10-01", "National Day"), offDay("2027-01-01", "New Year")
  ], 2026)])
  assert.strictEqual(strayed["2026-10-01"], "国庆节")
  assert.strictEqual(strayed["2027-01-01"], undefined)

  const merged = H.tableFromTexts([JSON.stringify({ days: [offDay("2027-01-01", "New Year")] })])
  assert.strictEqual(merged["2027-01-01"], "New Year")
  assert.strictEqual(merged["2026-10-01"], "国庆节", "the baked table is still underneath")
  assert.deepStrictEqual(H.yearsOf(merged), [2026, 2027])

  // Every failure shape a caller can hand in, including no texts at all.
  for (const texts of [[], null, undefined, [null, "", "not json", {}], "nope"]) {
    assert.deepStrictEqual(H.tableFromTexts(texts), H.FALLBACK, JSON.stringify(texts))
  }
})

check("years are read off the table, ascending and once each", () => {
  assert.deepStrictEqual(H.yearsOf({}), [])
  assert.deepStrictEqual(H.yearsOf(null), [])
  assert.deepStrictEqual(H.yearsOf({ "2027-01-01": "a", "2026-10-01": "b", "2026-01-01": "c" }), [2026, 2027])
  assert.deepStrictEqual(H.yearsOf({ "nonsense": "a" }), [])
})

check("the cache path comes from the XDG variable, then home", () => {
  const expected = "/tmp/cache/deepseek-offpeak-holidays-2026.json"
  assert.strictEqual(H.cachePath(H.cacheHome("/tmp/cache", "/home/x"), 2026), expected)
  assert.strictEqual(H.cachePath(H.cacheHome("/tmp/cache/", "/home/x"), 2026), expected, "a trailing slash")
  assert.strictEqual(H.cachePath(H.cacheHome(null, "/home/x"), 2026), "/home/x/.cache/deepseek-offpeak-holidays-2026.json")
  assert.strictEqual(H.cachePath(H.cacheHome(undefined, "/home/x/"), 2026), "/home/x/.cache/deepseek-offpeak-holidays-2026.json")
  // No home and no variable: no path, and every caller treats the cache as absent.
  assert.strictEqual(H.cacheHome(null, null), "")
  assert.strictEqual(H.cacheHome("", ""), "")
  // Which is also no path in the filesystem root: the join is skipped, not made
  // against an empty string.
  assert.strictEqual(H.cachePath("", 2026), "")
  assert.strictEqual(H.tmpPath("", 2026), "")
  // Each spec carries that emptiness through instead of filling it in: no
  // adapter runs a command with a path there, and none of them can name a file
  // beside the root directory.
  const emptyFetch = H.fetchSpec("", 2026).command
  assert.strictEqual(emptyFetch[emptyFetch.indexOf("--output") + 1], "")
  assert.strictEqual(H.publishSpec("", 2026).command[4], "")
  assert.strictEqual(H.readSpec("", 2026).command[4], "")
})

check("the fetch is one bounded curl, writing a temporary file", () => {
  for (const year of [2026, 2027]) {
    const spec = H.fetchSpec("/tmp/cache", year)
    const command = spec.command
    assert.strictEqual(command[0], H.CURL_BINARY, "named by absolute path")
    assert.notStrictEqual(command[0], "curl", "not through PATH")
    assert.ok(command.includes("-f"), "a 404 must fail rather than be cached")
    // curl truncates the file it is handed before the first byte arrives, so
    // that file must not be the cache: the move below is what publishes it.
    assert.strictEqual(command[command.indexOf("--output") + 1], H.tmpPath("/tmp/cache", year))
    assert.notStrictEqual(command[command.indexOf("--output") + 1], H.cachePath("/tmp/cache", year))
    assert.strictEqual(command[command.indexOf("--max-filesize") + 1], String(H.MAX_CACHE_BYTES))
    assert.strictEqual(command[command.length - 1], H.sourceUrl(year))
    assert.ok(H.sourceUrl(year).includes("/" + year + ".json"), H.sourceUrl(year))
    assert.strictEqual(spec.timeoutMs, H.STEP_TIMEOUT_MS)
    // No shell, no pipeline: the command is an argv, and every part of it is a
    // literal the module owns.
    assert.ok(command.every((part) => typeof part === "string"))
  }
})

check("a finished fetch is published by a move, not written over the cache", () => {
  const spec = H.publishSpec("/tmp/cache", 2026)
  assert.strictEqual(spec.command[0], H.MV_BINARY, "named by absolute path")
  assert.deepStrictEqual(spec.command, [H.MV_BINARY, "-f", "--",
    H.tmpPath("/tmp/cache", 2026), H.cachePath("/tmp/cache", 2026)])
  assert.strictEqual(spec.path, H.cachePath("/tmp/cache", 2026))
  // Both names are in the cache directory, so the move is a rename on one
  // filesystem: the cache is replaced whole or not at all.
  assert.ok(H.tmpPath("/tmp/cache", 2026).startsWith(H.cachePath("/tmp/cache", 2026)))
})

check("the read stops one byte past the ceiling", () => {
  const spec = H.readSpec("/tmp/cache", 2026)
  assert.strictEqual(spec.command[0], H.HEAD_BINARY)
  assert.strictEqual(spec.command[1], "-c")
  assert.strictEqual(spec.command[2], String(H.MAX_CACHE_BYTES + 1))
  assert.strictEqual(spec.command[3], "--", "so a path beginning with a dash is a path")
  assert.strictEqual(spec.command[4], spec.path)
  assert.strictEqual(spec.path, H.cachePath("/tmp/cache", 2026))
})

console.log(`holidays: ${checks} checks passed`)
