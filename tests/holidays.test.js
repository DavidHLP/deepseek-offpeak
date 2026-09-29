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

check("the cache lives in a directory of its own under the cache home", () => {
  const expected = "/tmp/cache/deepseek-offpeak/deepseek-offpeak-holidays-2026.json"
  assert.strictEqual(H.cacheDir("/tmp/cache"), "/tmp/cache/deepseek-offpeak")
  assert.strictEqual(H.cachePath(H.cacheHome("/tmp/cache", "/home/x"), 2026), expected)
  assert.strictEqual(H.cachePath(H.cacheHome("/tmp/cache/", "/home/x"), 2026), expected, "a trailing slash")
  assert.strictEqual(H.cachePath(H.cacheHome(null, "/home/x"), 2026), "/home/x/.cache/deepseek-offpeak/deepseek-offpeak-holidays-2026.json")
  assert.strictEqual(H.cachePath(H.cacheHome(undefined, "/home/x/"), 2026), "/home/x/.cache/deepseek-offpeak/deepseek-offpeak-holidays-2026.json")
  // No home and no variable: no path, and every caller treats the cache as absent.
  assert.strictEqual(H.cacheHome(null, null), "")
  assert.strictEqual(H.cacheHome("", ""), "")
  // Which is also no path in the filesystem root: the join is skipped, not made
  // against an empty string.
  assert.strictEqual(H.cacheDir(""), "")
  assert.strictEqual(H.cachePath("", 2026), "")
  // Each spec carries that emptiness through instead of filling it in: no
  // adapter runs a command with a path there, and none of them can name a file
  // beside the root directory.
  const emptyFetch = H.fetchSpec("", 2026, "").command
  assert.strictEqual(emptyFetch[emptyFetch.indexOf("--output") + 1], "")
  assert.strictEqual(H.publishSpec("", 2026, "").command[4], "")
  assert.strictEqual(H.readSpec("", 2026).command[4], "")
  assert.strictEqual(H.prepareSpec("").path, "")
  assert.strictEqual(H.stageSpec("", 2026).command[2], "")
})

check("the cache path is judged level by level, in one shared form", () => {
  // stat reports each owner UID with its raw mode as hex, so both adapters use
  // the same ownership and permission verdicts.
  assert.strictEqual(H.guardOk((0o40700).toString(16)), true, "0o40700: a 0700 directory")
  assert.strictEqual(H.guardOk((0o40755).toString(16)), false, "0755 is one anyone can add a name to")
  assert.strictEqual(H.guardOk((0o120777).toString(16)), false, "a symlink is never followed for its type")
  assert.strictEqual(H.guardOk((0o100644).toString(16)), false, "a file is not the directory")
  assert.strictEqual(H.guardOk(""), false, "a path stat could not read")
  assert.strictEqual(H.guardOk("directory|700"), false, "a human line, not a mode number")
  assert.strictEqual(H.guardOk("41c0 trailing"), false, "anything but hex is refused whole")

  // An ancestor owned by the cache owner or root may be owner-writable. A
  // different owner must not have write permission or can replace descendants.
  const normalMode = (0o40755).toString(16)
  const readonlyMode = (0o40555).toString(16)
  assert.strictEqual(H.ancestorOk(normalMode, "1000", "1000"), true, "cache owner may write its ancestors")
  assert.strictEqual(H.ancestorOk(normalMode, "0", "1000"), true, "root-owned ancestors are trusted")
  assert.strictEqual(H.ancestorOk(normalMode, "1001", "1000"), false,
    "a different owner can replace descendants of a 0755 directory")
  assert.strictEqual(H.ancestorOk(readonlyMode, "1001", "1000"), true,
    "a different owner cannot replace descendants without owner-write permission")
  assert.strictEqual(H.ancestorOk((0o40775).toString(16), "1000", "1000"), false, "group-writable")
  assert.strictEqual(H.ancestorOk((0o40757).toString(16), "1000", "1000"), false, "other-writable")
  assert.strictEqual(H.ancestorOk((0o40777).toString(16), "1000", "1000"), false,
    "world-writable is exactly what lets a name in it be swapped")
  assert.strictEqual(H.ancestorOk((0o41777).toString(16), "0", "1000"), false,
    "sticky does not save it: the owner of a directory renames whatever it holds")
  assert.strictEqual(H.ancestorOk((0o120777).toString(16), "1000", "1000"), false,
    "a symlink is not a level of the path")
  assert.strictEqual(H.ancestorOk("", "1000", "1000"), false)
  assert.strictEqual(H.ancestorOk(normalMode, "bad-uid", "1000"), false)
})

check("every prefix of the cache directory is on the chain to check", () => {
  assert.deepStrictEqual(H.ancestryPaths("/home/x/.cache/deepseek-offpeak"),
    ["/", "/home", "/home/x", "/home/x/.cache", "/home/x/.cache/deepseek-offpeak"])
  assert.deepStrictEqual(H.ancestryPaths("/deepseek-offpeak"), ["/", "/deepseek-offpeak"])
  // No path, no chain: a caller with no cache home checks nothing and uses
  // nothing, rather than walking a chain built out of an empty string.
  assert.deepStrictEqual(H.ancestryPaths(""), [])
  assert.deepStrictEqual(H.ancestryPaths(null), [])
  assert.deepStrictEqual(H.ancestryPaths("relative/path"), [])
})

check("the chain passes only when every level does, in order", () => {
  const paths = H.ancestryPaths("/home/x/.cache/deepseek-offpeak")
  const dir = (0o40700).toString(16)
  const normal = (0o40755).toString(16)
  const loose = (0o40777).toString(16)
  const root = "0:" + normal
  const owned = "1000:" + normal
  const cache = "1000:" + dir
  const ok = [root, root, owned, owned, cache]

  assert.strictEqual(H.chainOk(ok.join("\n"), paths.length), true, "the whole path, as stat prints it")
  assert.strictEqual(H.chainOk(ok.join("\n") + "\n", paths.length), true, "the trailing newline stat adds")
  assert.strictEqual(H.chainOk("0:" + loose + "\n" + ok.slice(1).join("\n"), paths.length), false,
    "one writable level and the path below it can be renamed out from under us")
  assert.strictEqual(H.chainOk(root + "\n1001:" + normal + "\n" + ok.slice(2).join("\n"), paths.length), false,
    "an attacker-owned 0755 ancestor can replace the user-owned cache directory")
  assert.strictEqual(H.chainOk(ok.slice(0, 4).join("\n"), paths.length), false,
    "a level stat could not read: one line short, nothing may be written through it")
  assert.strictEqual(H.chainOk(ok.slice(1).join("\n"), paths.length), false, "still short")
  assert.strictEqual(H.chainOk(root + "\n" + root + "\n" + owned + "\n" + owned + "\n" + owned,
    paths.length), false, "the last entry is the cache directory itself: 0700 or not at all")
  assert.strictEqual(H.chainOk("", paths.length), false)
  assert.strictEqual(H.chainOk("", 0), false, "an empty chain is not a verified one")
})

check("the cycle makes the cache directory and reads the path back", () => {
  const paths = ["/", "/tmp", "/tmp/cache", "/tmp/cache/deepseek-offpeak"]
  // Created owner-only, and never judged by its own exit code: `mkdir -p`
  // succeeds through an existing symlink, so what decides is the stat that
  // follows — one process over every level of the path, in the order the
  // verdicts are applied.
  assert.deepStrictEqual(H.prepareSpec("/tmp/cache").command,
    [H.MKDIR_BINARY, "-p", "-m", "0700", "--", "/tmp/cache/deepseek-offpeak"])
  assert.strictEqual(H.prepareSpec("/tmp/cache").command[0], H.MKDIR_BINARY, "named by absolute path")

  const verify = H.verifySpec("/tmp/cache")
  assert.deepStrictEqual(verify.command, [H.STAT_BINARY, "-c", "%u:%f", "--"].concat(paths))
  assert.deepStrictEqual(verify.paths, paths)
  assert.strictEqual(verify.command[0], H.STAT_BINARY, "named by absolute path")
})

check("a fetch stages a file exclusively before curl is handed any path", () => {
  const dir = "/tmp/cache/deepseek-offpeak"
  const staged = dir + "/deepseek-offpeak-holidays-2026.XXXXXX"

  const stage = H.stageSpec("/tmp/cache", 2026)
  assert.strictEqual(stage.command[0], H.MKTEMP_BINARY, "named by absolute path")
  assert.strictEqual(stage.command[stage.command.length - 1], staged)
  assert.ok(/\.XXXXXX$/.test(staged), "the template mktemp needs at the end")
  assert.ok(staged.startsWith(dir), "staged inside the guarded directory, so the move is one rename")

  for (const year of [2026, 2027]) {
    const spec = H.fetchSpec("/tmp/cache", year, staged)
    const command = spec.command
    assert.strictEqual(command[0], H.CURL_BINARY, "named by absolute path")
    assert.notStrictEqual(command[0], "curl", "not through PATH")
    assert.ok(command.includes("-f"), "a 404 must fail rather than be cached")
    // curl truncates the file it is handed before the first byte arrives, so
    // that file must be the one mktemp just created — never the cache, and
    // never a name that was not handed in by the caller.
    assert.strictEqual(command[command.indexOf("--output") + 1], staged)
    assert.notStrictEqual(command[command.indexOf("--output") + 1], H.cachePath("/tmp/cache", year))
    assert.strictEqual(command[command.indexOf("--max-filesize") + 1], String(H.MAX_CACHE_BYTES))
    assert.strictEqual(command[command.length - 1], H.sourceUrl(year))
    assert.ok(H.sourceUrl(year).includes("/" + year + ".json"), H.sourceUrl(year))
    assert.strictEqual(spec.timeoutMs, H.STEP_TIMEOUT_MS)
    // No shell, no pipeline: the command is an argv, and every part of it is a
    // literal the module owns.
    assert.ok(command.every((part) => typeof part === "string"))
  }

  const publish = H.publishSpec("/tmp/cache", 2026, staged)
  assert.strictEqual(publish.command[0], H.MV_BINARY, "named by absolute path")
  assert.deepStrictEqual(publish.command, [H.MV_BINARY, "-f", "--", staged, H.cachePath("/tmp/cache", 2026)])
  assert.strictEqual(publish.path, H.cachePath("/tmp/cache", 2026))
  assert.ok(staged.startsWith(H.cacheDir("/tmp/cache")), "both names are in the cache directory")

  // A staged file that never became a document is removed, not left for the
  // next weekly refresh to find.
  assert.deepStrictEqual(H.discardSpec(staged).command, [H.RM_BINARY, "-f", "--", staged])
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
