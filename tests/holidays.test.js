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
const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

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
  assert.strictEqual(H.cacheHome("/tmp/cache/../target", "/home/x"), "", "reject parent traversal")
  assert.strictEqual(H.cacheHome("/tmp/cache/./nested", "/home/x"), "", "reject dot components")
  assert.strictEqual(H.cacheDir("/tmp/cache/../target"), "", "reject traversal for direct callers")
  assert.deepStrictEqual(H.ancestryPaths("/tmp/cache/../target/deepseek-offpeak"), [],
    "never build a trusted prefix chain for a path that mkdir normalizes")
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

check("cache ownership is bound to the effective UID", () => {
  const uid = "1000"
  const dir = (0o40700).toString(16)
  const normalMode = (0o40755).toString(16)
  const readonlyMode = (0o40555).toString(16)

  assert.strictEqual(H.guardOk(dir, uid, uid), true, "a private cache owned by this process")
  assert.strictEqual(H.guardOk(dir, "1001", uid), false, "a foreign-owned cache is not trusted")
  assert.strictEqual(H.guardOk(dir, uid), false, "the expected effective UID is required")
  assert.strictEqual(H.guardOk((0o40755).toString(16), uid, uid), false, "the cache directory must be private")
  assert.strictEqual(H.guardOk((0o120777).toString(16), uid, uid), false, "a symlink is never followed for its type")
  assert.strictEqual(H.guardOk((0o100644).toString(16), uid, uid), false, "a file is not the directory")
  assert.strictEqual(H.guardOk("", uid, uid), false, "a path stat could not read")
  assert.strictEqual(H.guardOk("directory|700", uid, uid), false, "a human line, not a mode number")
  assert.strictEqual(H.guardOk("41c0 trailing", uid, uid), false, "anything but hex is refused whole")

  // An ancestor owned by root or the effective UID is trusted. Another owner
  // can change its permissions and replace descendants after this check.
  assert.strictEqual(H.ancestorOk(normalMode, uid, uid), true, "the effective user may write its ancestors")
  assert.strictEqual(H.ancestorOk(normalMode, "0", uid), true, "root-owned ancestors are trusted")
  assert.strictEqual(H.ancestorOk(normalMode, "1001", uid), false,
    "a different owner can replace descendants of a 0755 directory")
  assert.strictEqual(H.ancestorOk(readonlyMode, "1001", uid), false,
    "a different owner can change permissions before replacing descendants")
  assert.strictEqual(H.ancestorOk((0o40775).toString(16), uid, uid), false, "group-writable")
  assert.strictEqual(H.ancestorOk((0o40757).toString(16), uid, uid), false, "other-writable")
  assert.strictEqual(H.ancestorOk((0o40777).toString(16), uid, uid), false,
    "world-writable is rejected")
  assert.strictEqual(H.ancestorOk((0o41777).toString(16), "0", uid), false,
    "sticky does not make a world-writable parent safe")
  assert.strictEqual(H.ancestorOk((0o120777).toString(16), uid, uid), false, "a symlink is not a path directory")
  assert.strictEqual(H.ancestorOk("", uid, uid), false)
  assert.strictEqual(H.ancestorOk(normalMode, "bad-uid", uid), false)
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

check("the chain binds every owner and mode to the effective UID", () => {
  const paths = H.ancestryPaths("/home/x/.cache/deepseek-offpeak")
  const dir = (0o40700).toString(16)
  const normal = (0o40755).toString(16)
  const loose = (0o40777).toString(16)
  const uid = "1000"
  const root = "0:" + normal
  const owned = uid + ":" + normal
  const cache = uid + ":" + dir
  const ok = [root, root, owned, owned, cache]

  assert.strictEqual(H.chainOk(ok.join("\n"), paths.length, uid), true, "the whole path, as stat prints it")
  assert.strictEqual(H.chainOk(ok.join("\n") + "\n", paths.length, uid), true, "the trailing newline stat adds")
  assert.strictEqual(H.chainOk(ok.join("\n"), paths.length, "2000"), false,
    "a cache owned by a different effective UID is rejected")
  assert.strictEqual(H.chainOk("0:" + loose + "\n" + ok.slice(1).join("\n"), paths.length, uid), false,
    "one writable level and the path below it can be renamed out from under us")
  assert.strictEqual(H.chainOk(root + "\n1001:" + normal + "\n" + ok.slice(2).join("\n"), paths.length, uid), false,
    "an attacker-owned 0755 ancestor can replace the user-owned cache directory")
  const foreignCache = ok.slice(0, -1).concat(["1001:" + dir])
  assert.strictEqual(H.chainOk(foreignCache.join("\n"), paths.length, uid), false,
    "a privileged process must not trust a cache owned by its caller")
  assert.strictEqual(H.chainOk("x:" + normal + "\n" + ok.slice(1).join("\n"), paths.length, uid), false,
    "malformed owner output fails closed")
  const existingParents = ok.slice(0, -1).join("\n")
  assert.strictEqual(H.chainOk(existingParents, paths.length, uid), false,
    "a partial stat chain is not a final verification")
  assert.strictEqual(H.chainOk(existingParents, paths.length, uid, true), true,
    "trusted existing parents allow creation of the missing cache leaf")
  const foreignParent = ok.slice(0, -1)
  foreignParent[2] = "1001:" + normal
  assert.strictEqual(H.chainOk(foreignParent.join("\n"), paths.length, uid, true), false,
    "an untrusted existing parent fails the preflight")
  assert.strictEqual(H.chainOk(ok.slice(0, 2).join("\n"), paths.length, uid, true), true,
    "multiple missing trailing directories may still be created under trusted parents")
  const symlinkParent = ok.slice(0, -1)
  symlinkParent[1] = uid + ":" + (0o120777).toString(16)
  assert.strictEqual(H.chainOk(symlinkParent.join("\n"), paths.length, uid, true), false,
    "an existing symlink prefix must be rejected before directory creation")
  assert.strictEqual(H.chainOk(root + "\n" + root + "\n" + owned + "\n" + owned + "\n" + owned,
    paths.length, uid), false, "the last entry is the cache directory itself: 0700 or not at all")
  assert.strictEqual(H.chainOk("", paths.length, uid), false)
  assert.strictEqual(H.chainOk("", 0, uid), false, "an empty chain is not a verified one")
  assert.strictEqual(H.chainOk(ok.join("\n"), paths.length, "bad-uid"), false, "a malformed effective UID fails closed")
})

check("the cycle makes the cache directory and reads the path back", () => {
  const paths = ["/", "/tmp", "/tmp/cache", "/tmp/cache/deepseek-offpeak"]
  // A private umask applies to every missing ancestor; the full-chain stat still
  // decides whether the resulting path is safe.
  assert.deepStrictEqual(H.prepareSpec("/tmp/cache").command,
    ["/bin/sh", "-c", 'umask 077; exec "$1" -p -m 0700 -- "$2"',
      "deepseek-offpeak-mkdir", H.MKDIR_BINARY, "/tmp/cache/deepseek-offpeak"])
  assert.strictEqual(H.prepareSpec("/tmp/cache").command[0], "/bin/sh", "named by absolute path")

  assert.deepStrictEqual(H.uidSpec().command, [H.ID_BINARY, "-u"])

  const verify = H.verifySpec("/tmp/cache")
  assert.deepStrictEqual(verify.command, [H.STAT_BINARY, "-c", "%u:%f", "--"].concat(paths))
  assert.deepStrictEqual(verify.paths, paths)
  assert.strictEqual(verify.command[0], H.STAT_BINARY, "named by absolute path")
})

check("QML cache preparation keeps every new directory private under a permissive umask", () => {
  const temp = fs.mkdtempSync(path.join(os.homedir(), ".deepseek-offpeak-test-"))
  const cacheHome = path.join(temp, "missing", "cache-home")
  const spec = H.prepareSpec(cacheHome)
  const oldUmask = process.umask(0o002)
  try {
    const result = childProcess.spawnSync(spec.command[0], spec.command.slice(1), {
      encoding: "utf8",
      timeout: 5000
    })
    assert.strictEqual(result.error, undefined, String(result.error || ""))
    assert.strictEqual(result.status, 0, result.stderr || "cache preparation should succeed")
    for (const dir of [path.join(temp, "missing"), cacheHome, spec.path]) {
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, dir + " is private")
    }
  } finally {
    process.umask(oldUmask)
    fs.rmSync(temp, { recursive: true, force: true })
  }
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

check("QML holiday steps drain stdout before advancing", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../Service.qml"), "utf8")
  const start = source.indexOf("function finishHolidayStep()")
  const end = source.indexOf("function adoptHolidayCache(", start)
  assert.ok(start !== -1 && end > start, "find the QML holiday step handler")
  const handler = source.slice(start, end)
  const stdoutGate = handler.indexOf("if (!holidayProc.stdoutDone) return false")
  const nextStep = handler.indexOf("var step = root.holidayStep")
  assert.ok(stdoutGate !== -1 && stdoutGate < nextStep,
    "even non-consuming steps must drain their collector before another step starts")
})

check("CLI creates every cache directory privately under a permissive umask", () => {
  const temp = fs.mkdtempSync(path.join(os.homedir(), ".deepseek-offpeak-test-"))
  const cacheHome = path.join(temp, "missing", "xdg-cache")
  const oldUmask = process.umask(0o002)
  try {
    const cli = path.resolve(__dirname, "../bin/deepseek-offpeak")
    const proxy = "127.0.0.1:1"
    const result = childProcess.spawnSync(process.execPath, [cli, "status"], {
      cwd: temp,
      encoding: "utf8",
      timeout: 5000,
      env: {
        HOME: temp,
        XDG_CONFIG_HOME: path.join(temp, "config"),
        XDG_CACHE_HOME: cacheHome,
        DEEPSEEK_API_KEY: "",
        ALL_PROXY: proxy,
        all_proxy: proxy,
        NO_PROXY: "",
        no_proxy: "",
        PATH: process.env.PATH
      }
    })
    assert.strictEqual(result.error, undefined, String(result.error || ""))
    assert.strictEqual(result.status, 0, result.stderr || "CLI status should remain available")
    for (const dir of [path.join(temp, "missing"), cacheHome, path.join(cacheHome, "deepseek-offpeak")]) {
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, dir + " is private")
    }
  } finally {
    process.umask(oldUmask)
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

check("CLI rejects dot-dot paths before mkdir can normalize and create elsewhere", () => {
  const temp = fs.mkdtempSync(path.join(os.homedir(), ".deepseek-offpeak-test-"))
  try {
    const prefix = path.join(temp, "prefix")
    const target = path.join(temp, "target")
    fs.mkdirSync(prefix)
    fs.mkdirSync(target)
    const cacheHome = prefix + "/missing/../../target"
    const cli = path.resolve(__dirname, "../bin/deepseek-offpeak")
    const result = childProcess.spawnSync(process.execPath, [cli, "status"], {
      cwd: temp,
      encoding: "utf8",
      timeout: 5000,
      env: {
        HOME: temp,
        XDG_CONFIG_HOME: path.join(temp, "config"),
        XDG_CACHE_HOME: cacheHome,
        DEEPSEEK_API_KEY: "",
        PATH: process.env.PATH
      }
    })
    assert.strictEqual(result.error, undefined, String(result.error || ""))
    assert.strictEqual(result.status, 0, result.stderr || "CLI status should remain available")
    assert.strictEqual(fs.existsSync(path.join(target, "deepseek-offpeak")), false,
      "invalid path components must not create a directory outside the literal chain")
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

check("QML watchdog recovery waits for the timed-out collector", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../Service.qml"), "utf8")
  const recoveryStart = source.indexOf("function recoverStuckHolidayStep(seq)")
  const recoveryEnd = source.indexOf("  Process {", recoveryStart)
  assert.ok(recoveryStart !== -1 && recoveryEnd > recoveryStart, "find watchdog recovery")
  const recovery = source.slice(recoveryStart, recoveryEnd)
  const stdoutGate = recovery.indexOf("if (holidayProc.startedForStep && !holidayProc.stdoutDone)")
  const pendingMark = recovery.indexOf("root.holidayRecoveryPendingSeq = seq")
  const advance = recovery.indexOf("root.startHolidayStep()")
  assert.ok(stdoutGate !== -1 && pendingMark > stdoutGate && advance > pendingMark,
    "recovery must defer starting another process until the current collector drains")

  const collectorStart = source.indexOf("onStreamFinished: {", recoveryEnd)
  const collectorEnd = source.indexOf("onExited: function(code)", collectorStart)
  assert.ok(collectorStart !== -1 && collectorEnd > collectorStart, "find stdout completion callback")
  const collector = source.slice(collectorStart, collectorEnd)
  const seq = collector.indexOf("var seq = holidayProc.stepSeq")
  const pendingGate = collector.indexOf("root.holidayRecoveryPendingSeq === seq")
  const recover = collector.indexOf("root.recoverStuckHolidayStep", pendingGate)
  const finish = collector.indexOf("root.finishHolidayStep()", pendingGate)
  assert.ok(seq !== -1 && pendingGate > seq && recover > pendingGate && finish > pendingGate,
    "collector completion must resume pending recovery or normal completion for this step")
})

check("CLI does not create cache content through a symlink parent", () => {
  const temp = fs.mkdtempSync(path.join(os.homedir(), ".deepseek-offpeak-test-"))
  try {
    const target = path.join(temp, "target")
    const cacheHome = path.join(temp, "cache-home")
    fs.mkdirSync(target)
    fs.symlinkSync(target, cacheHome)
    const cli = path.resolve(__dirname, "../bin/deepseek-offpeak")
    const result = childProcess.spawnSync(process.execPath, [cli, "status"], {
      cwd: temp,
      encoding: "utf8",
      timeout: 5000,
      env: {
        HOME: temp,
        XDG_CONFIG_HOME: path.join(temp, "config"),
        XDG_CACHE_HOME: cacheHome,
        DEEPSEEK_API_KEY: "",
        PATH: process.env.PATH
      }
    })
    assert.strictEqual(result.error, undefined, String(result.error || ""))
    assert.strictEqual(result.status, 0, result.stderr || "CLI status should remain available")
    assert.strictEqual(fs.existsSync(path.join(target, "deepseek-offpeak")), false,
      "reject the symlink parent before creating the cache leaf at its target")
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

// Execute the actual QML function and signal-handler bodies with a small host
// adapter. This is a signal-order regression, not a Quickshell runtime test.
// Quickshell 41651d7's FailedToStart emits runningChanged, with no started,
// exited or streamFinished; a started process must still drain before reuse.
function holidayQueueHarness(steps) {
  const vm = require("vm")
  const source = fs.readFileSync(path.resolve(__dirname, "../Service.qml"), "utf8")
  function bodyAfter(marker) {
    const start = source.indexOf(marker)
    assert.notStrictEqual(start, -1, "find " + marker)
    const open = source.indexOf("{", start)
    let depth = 1
    let end = open + 1
    for (; depth > 0 && end < source.length; end++) {
      if (source[end] === "{") depth++
      if (source[end] === "}") depth--
    }
    assert.strictEqual(depth, 0, "balanced body for " + marker)
    return source.slice(open + 1, end - 1)
  }
  const pending = []
  const adopted = []
  const commands = []
  const root = {
    holidaySteps: steps.slice(), holidayStep: null, holidayStepActive: false,
    holidayStepSeq: 0, holidayRecoveryPendingSeq: -1, holidayStagedPath: "",
    holidayEffectiveUid: "", holidayCycleDone: false, holidayCacheHome: "/unused",
    holidayStepSpec: step => ({ command: [step.kind] }),
    adoptHolidayCache: (...args) => adopted.push(args)
  }
  const proc = { exitCode: -1, stdoutDone: false, stdoutText: "", stepSeq: 0, running: false }
  const watchdog = {
    running: false,
    restart() { this.running = true; commands.push(proc.command.slice()) },
    stop() { this.running = false }
  }
  const context = vm.createContext({ root, holidayProc: proc, holidayWatchdog: watchdog,
    Holidays: H, Qt: { callLater: fn => pending.push(fn) } })
  for (const name of ["dropHolidaySteps", "abandonHolidayStep", "startHolidayStep",
    "finishHolidayStep", "recoverStuckHolidayStep", "refreshHolidays"]) {
    const args = { dropHolidaySteps: "kinds", abandonHolidayStep: "dropKinds",
      recoverStuckHolidayStep: "seq" }[name] || ""
    root[name] = vm.runInContext(`(function(${args}) {${bodyAfter("function " + name + "(")}})`, context)
  }
  const stream = vm.runInContext(`(function(text) {${bodyAfter("onStreamFinished: {")}})`, context)
  const exited = vm.runInContext(`(function(code) {${bodyAfter("onExited: function(code)")}})`, context)
  const runningChanged = vm.runInContext(`(function(running) {${bodyAfter("onRunningChanged: {")}})`, context)
  const startedLine = source.match(/^\s*onStarted: (.+)$/m)
  assert.ok(startedLine, "track actual Process.started")
  const started = vm.runInContext(`(function() {${startedLine[1]}})`, context)
  return { root, proc, watchdog, adopted, commands, stream, exited, started,
    stopped() { proc.running = false; runningChanged(false) },
    flush() { while (pending.length) pending.shift()() } }
}

check("QML normal and nonzero exits require both exit and stdout in either order", () => {
  for (const code of [0, 7]) for (const streamFirst of [true, false]) {
    const h = holidayQueueHarness([{ kind: "read", year: 2026 }])
    h.root.startHolidayStep()
    h.started()
    if (streamFirst) h.stream("document")
    else h.exited(code)
    assert.strictEqual(h.root.holidayStepActive, true)
    if (streamFirst) h.exited(code)
    else h.stream("document")
    h.stopped()
    h.flush()
    assert.deepStrictEqual(h.adopted, [[code, "document", 2026]])
    assert.strictEqual(h.root.holidayStepActive, false)
    assert.strictEqual(h.root.holidayCycleDone, true)
    assert.strictEqual(h.watchdog.running, false)
  }
})

check("QML a missing executable releases the queue without a stream callback", () => {
  const missing = path.join(os.tmpdir(), "deepseek-missing-" + process.pid, "no-such-program")
  const result = childProcess.spawnSync(missing, [], { encoding: "utf8" })
  assert.strictEqual(result.error.code, "ENOENT")
  for (const kind of ["uid", "preflight", "prepare", "verify", "read", "stage", "fetch", "publish", "discard"]) {
    const h = holidayQueueHarness([{ kind, year: 2026 }])
    h.root.startHolidayStep()
    h.stopped() // Replay Quickshell FailedToStart: no started/exited/streamFinished.
    h.flush()
    assert.strictEqual(h.root.holidayStepActive, false, kind)
    assert.strictEqual(h.root.holidayCycleDone, true, kind)
    assert.strictEqual(h.proc.stdoutDone, false, "do not invent stream completion")
    assert.strictEqual(h.watchdog.running, false)
    h.root.holidayStepQueue = () => [{ kind: "read", year: 2026 }]
    assert.strictEqual(h.root.refreshHolidays(), true, "next refresh is accepted: " + kind)
    h.started()
    h.stream("next cycle")
    h.exited(0)
    assert.strictEqual(h.root.holidayStepActive, false)
  }
})

check("QML fetch startup failure discards staging and leaves the cache untouched", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-startup-test-"))
  try {
    const cache = path.join(temp, "cache.json")
    const stage = path.join(temp, "stage.json")
    fs.writeFileSync(cache, "last good document")
    fs.writeFileSync(stage, "partial transfer")
    const before = fs.statSync(cache)
    const h = holidayQueueHarness([{ kind: "fetch" }, { kind: "publish" }, { kind: "read", year: 2026 }])
    h.root.holidayStagedPath = stage
    h.root.startHolidayStep()
    h.stopped()
    h.flush()
    assert.strictEqual(h.root.holidayStep.kind, "discard")
    const command = H.discardSpec(h.root.holidayStep.path).command
    const result = childProcess.spawnSync(command[0], command.slice(1), { encoding: "utf8" })
    assert.strictEqual(result.status, 0, result.stderr)
    h.started()
    h.stream(result.stdout)
    h.exited(result.status)
    assert.strictEqual(h.root.holidayStagedPath, "")
    assert.strictEqual(h.root.holidayStep.kind, "read")
    assert.strictEqual(h.proc.startedForStep, false, "reset the previous step's started flag")
    h.started()
    h.stream(fs.readFileSync(cache, "utf8"))
    h.exited(0)
    assert.strictEqual(h.root.holidayCycleDone, true)
    assert.deepStrictEqual(h.commands.map(command => command[0]), ["fetch", "discard", "read"])
    assert.strictEqual(fs.existsSync(stage), false)
    assert.strictEqual(fs.readFileSync(cache, "utf8"), "last good document")
    assert.strictEqual(fs.statSync(cache).mtimeMs, before.mtimeMs)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

check("QML started timeout waits for late output and ignores old deferred recovery", () => {
  for (const exitBeforeDrain of [false, true]) {
    const h = holidayQueueHarness([{ kind: "read", year: 2026 }, { kind: "read", year: 2027 }])
    h.root.startHolidayStep()
    h.started()
    const oldSeq = h.root.holidayStepSeq
    h.stopped()
    h.flush()
    assert.strictEqual(h.root.holidayStepSeq, oldSeq, "no collector reuse while draining")
    assert.strictEqual(h.root.holidayRecoveryPendingSeq, oldSeq)
    assert.strictEqual(h.root.refreshHolidays(), false)
    h.stopped() // A second deferred callback remains queued while stdout arrives.
    if (exitBeforeDrain) h.exited(9)
    h.stream("old late output")
    assert.strictEqual(h.root.holidayStepSeq, oldSeq + 1)
    assert.strictEqual(h.proc.stdoutDone, false)
    assert.strictEqual(h.proc.stdoutText, "")
    assert.strictEqual(h.proc.startedForStep, false)
    h.flush()
    h.root.recoverStuckHolidayStep(oldSeq)
    assert.strictEqual(h.root.holidayStepSeq, oldSeq + 1, "stale callbacks do not advance twice")
    assert.strictEqual(h.root.holidayStepActive, true)
    h.started()
    h.exited(0)
    assert.strictEqual(h.root.holidayStepActive, true, "old stdout cannot finish the new step")
    h.stream("new output")
    assert.strictEqual(h.root.holidayCycleDone, true)
    assert.deepStrictEqual(h.adopted, exitBeforeDrain
      ? [[9, "old late output", 2026], [0, "new output", 2027]]
      : [[0, "new output", 2027]])
    assert.strictEqual(h.commands.length, 2)
  }
})

console.log(`holidays: ${checks} checks passed`)
