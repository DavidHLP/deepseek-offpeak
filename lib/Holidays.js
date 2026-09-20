// Chinese public holiday dates, for the billing-window math in lib/Schedule.js.
//
// DeepSeek's timetable, in its own words: 北京时间周一至周五（不含中国法定节
// 假日）9:00-12:00、14:00-18:00 为高峰时段；其余时段，包括周末及中国法定节
// 假日全天均为空闲时段。So a Chinese public holiday that falls on a Monday to
// Friday has no peak windows at all — which is the whole of what this module
// adds to the schedule.
//
// Weekends need no table: Schedule.js has that rule already, and it is the right
// one for the weekends the State Council designates as make-up workdays
// (调休上班的周末) too. DeepSeek bills those off-peak as well, so a designated
// workday on a Saturday changes nothing.
//
// Where the dates come from. holiday-cn (github.com/NateScarlet/holiday-cn) is a
// machine-readable transcription of 国务院办公厅's annual 部分节假日安排通知,
// published as one JSON file per year through jsDelivr — no key, no rate limit,
// and each document names the government paper it was transcribed from. The same
// file marks the 调休 make-up workdays (isOffDay: false); this module keeps only
// the 放假 days, because those are the only ones the billing math needs.
//
// The fetch is the second and last network call this plugin makes, and it is as
// strictly additive as the balance: the cache is read first and the baked
// FALLBACK below covers a machine that has never been online. A cache file that
// is missing, stale, oversized, or not the documented shape leaves the table
// exactly as it was.
//
// Pure and I/O-free, like lib/Balance.js: this module holds the URLs, the cache
// paths, the commands, and the parse, while the shell's Process and the CLI's
// spawnSync do the executing. Both adapters run the same spec, so the two cannot
// fetch different years or disagree about what a valid document is.

var ERROR_INVALID = "invalid_holiday_data"

// The binaries the plugin runs, by absolute path — the same rule lib/Balance.js
// applies: a directory earlier on PATH must not choose what runs.
var CURL_BINARY = "/usr/bin/curl"
var HEAD_BINARY = "/usr/bin/head"
var MV_BINARY = "/usr/bin/mv"

// Most a cache file may hold. A year of holidays is under 5 KiB; this is
// generous and still small, and it is applied three times over: curl refuses to
// write more (--max-filesize), the read stops at one byte past it, and the parse
// rejects anything longer.
var MAX_CACHE_BYTES = 65536

// Longest a step may take, from process start to kill. Sits above curl's own
// --max-time so the normal path ends on curl's terms.
var STEP_TIMEOUT_MS = 15000
var CURL_CONNECT_TIMEOUT_SECONDS = 5
var CURL_MAX_TIME_SECONDS = 10

// How long a cache file is trusted before the shell fetches again. The
// arrangement for a year is published once, in the November before it, so a week
// is far more often than the data changes — it is there to pick up a corrected
// document and to notice a new year without a restart.
var STALE_AFTER_MS = 7 * 24 * 3600 * 1000

// How near the year's end the next year's document starts being asked for. It is
// published in early November, so before this window a fetch is a guaranteed
// 404: harmless once a week from the shell, a wasted request per invocation from
// the CLI. Both adapters ask only inside the window, and inside it both keep
// asking weekly until it appears.
var NEXT_YEAR_FETCH_LEAD_MS = 60 * 24 * 3600 * 1000

// Bounds on the document's shape. A cap on bytes is not a cap on shape: 64 KiB
// of JSON can still be one array of a hundred thousand entries. A year has about
// 40 holiday days; the ceiling is slack around that.
var MAX_DAYS = 400
var MAX_NAME_LENGTH = 48

// Holiday names are rendered by the plain-text status command and by the panel.
// Reject terminal/control characters at the document boundary instead of letting
// display data become terminal instructions downstream — the same rule
// lib/Balance.js applies to currency codes.
var NAME_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/

// The cache lives in the cache directory, not the config directory: it is
// fetched data that can be regenerated, and losing it costs one request. Flat
// files rather than a subdirectory, so nothing has to create a directory the
// shell could not create anyway (QML has no mkdir; a namespace of its own would
// mean running one more process to make it).
var CACHE_FILE_PREFIX = "deepseek-offpeak-holidays-"
var SOURCE_BASE_URL = "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/"

// The table as a machine that has never been online sees it: 2026, transcribed
// from 国务院办公厅关于2026年部分节假日安排的通知 (国办发明电〔2025〕7号), the
// notice holiday-cn's own 2026 document cites. Dates are the published 放假
// days, weekends inside a span included, so this reads as the notice does.
//
// It is a floor, not a second source of truth: the fetched table is merged over
// it, so a year present in both is decided by the fetch. A later year is only in
// the fetched table, and a machine that cannot fetch simply has no holidays for
// it — the weekday rule, which is what the plugin did before this module existed.
var FALLBACK = {
  "2026-01-01": "元旦", "2026-01-02": "元旦", "2026-01-03": "元旦",
  "2026-02-15": "春节", "2026-02-16": "春节", "2026-02-17": "春节", "2026-02-18": "春节",
  "2026-02-19": "春节", "2026-02-20": "春节", "2026-02-21": "春节", "2026-02-22": "春节",
  "2026-02-23": "春节",
  "2026-04-04": "清明节", "2026-04-05": "清明节", "2026-04-06": "清明节",
  "2026-05-01": "劳动节", "2026-05-02": "劳动节", "2026-05-03": "劳动节",
  "2026-05-04": "劳动节", "2026-05-05": "劳动节",
  "2026-06-19": "端午节", "2026-06-20": "端午节", "2026-06-21": "端午节",
  "2026-09-25": "中秋节", "2026-09-26": "中秋节", "2026-09-27": "中秋节",
  "2026-10-01": "国庆节", "2026-10-02": "国庆节", "2026-10-03": "国庆节",
  "2026-10-04": "国庆节", "2026-10-05": "国庆节", "2026-10-06": "国庆节",
  "2026-10-07": "国庆节"
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isValidYear(year) {
  var value = Number(year)
  return isFinite(value) && Math.floor(value) === value && value >= 2000 && value <= 2100
}

function sourceUrl(year) {
  return SOURCE_BASE_URL + Number(year) + ".json"
}

// Where the cache lives, from the two variables that decide it. XDG wins when it
// is set, as it does for every other XDG path; without either, "" and every
// caller treats the cache as absent rather than guessing a path.
function cacheHome(cacheHomeEnv, home) {
  var base = String(cacheHomeEnv === null || cacheHomeEnv === undefined ? "" : cacheHomeEnv)
  if (base === "") {
    // Trailing slashes go before the join, not after it: "home/" + "/.cache"
    // would otherwise be left with a doubled separator in the middle.
    var homePath = String(home === null || home === undefined ? "" : home).replace(/\/+$/, "")
    if (homePath === "") return ""
    return homePath + "/.cache"
  }
  return base.replace(/\/+$/, "")
}

// "" when there is no cache home at all — no XDG variable and no HOME. Every
// caller treats that as no cache rather than joining onto nothing, which would
// name a file in the filesystem root.
function cachePath(cacheHomeDir, year) {
  var home = String(cacheHomeDir === null || cacheHomeDir === undefined ? "" : cacheHomeDir)
  if (home === "") return ""
  return home + "/" + CACHE_FILE_PREFIX + Number(year) + ".json"
}

// Where a fetch writes while the body is still arriving. publishSpec renames it
// over cachePath once the transfer has finished, which is what makes the cache
// whole or absent and never truncated.
function tmpPath(cacheHomeDir, year) {
  var path = cachePath(cacheHomeDir, year)
  return path === "" ? "" : path + ".tmp"
}

// curl writes the body to a temporary file beside the cache, which is what keeps
// the shell out of the writing business: QML has no file-write API, and the
// alternatives are a second process per refresh or no cache at all.
//
// The temporary file is also what keeps a failed transfer from costing the copy
// that is already there. curl truncates the file it is given before the first
// byte arrives, so a fetch written straight to the cache would empty a good
// document the moment the network dropped — offline, which is when the cache was
// worth having. Only a curl that exited zero is published, so the cache file is
// replaced whole or not at all.
//
// `-f` is what makes a year that is not announced yet a failure instead of a
// cached error page: without it a 404 body would be written to the cache and
// read back as a document. curl fails before writing when the status is 4xx or
// 5xx, and the empty file it leaves is rejected by the parse.
function fetchSpec(cacheHomeDir, year) {
  return {
    url: sourceUrl(year),
    timeoutMs: STEP_TIMEOUT_MS,
    command: [CURL_BINARY,
      "-f", "-sS",
      "--connect-timeout", String(CURL_CONNECT_TIMEOUT_SECONDS),
      "--max-time", String(CURL_MAX_TIME_SECONDS),
      "--max-filesize", String(MAX_CACHE_BYTES),
      "--output", tmpPath(cacheHomeDir, year),
      sourceUrl(year)]
  }
}

// The rename that publishes a finished fetch: one move inside the cache
// directory, so no reader can see half a document. `-f` because the destination
// is meant to exist; `--` so a path that begins with a dash is still a path.
//
// A caller runs this only after the fetch it belongs to exited zero. Run anyway,
// it publishes nothing: a failed transfer leaves no temporary file to rename.
function publishSpec(cacheHomeDir, year) {
  return {
    path: cachePath(cacheHomeDir, year),
    timeoutMs: STEP_TIMEOUT_MS,
    command: [MV_BINARY, "-f", "--", tmpPath(cacheHomeDir, year), cachePath(cacheHomeDir, year)]
  }
}

// The bounded read, the same trick the key file uses: one byte past the ceiling,
// so a file that is too large is recognizable as too large without being read
// whole. `--` ends the options, so a path that begins with a dash is a path.
function readSpec(cacheHomeDir, year) {
  var path = cachePath(cacheHomeDir, year)
  return {
    path: path,
    timeoutMs: STEP_TIMEOUT_MS,
    command: [HEAD_BINARY, "-c", String(MAX_CACHE_BYTES + 1), "--", path]
  }
}

// A real calendar date, in the "YYYY-MM-DD" shape the table is keyed by. The
// round-trip is what rejects 2026-02-30 and 2026-13-01: a date that does not
// exist cannot be one the State Council announced, and a table entry that can
// never match an instant is one that silently does nothing.
function isDateKey(value) {
  if (typeof value !== "string") return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  var year = Number(value.slice(0, 4))
  var month = Number(value.slice(5, 7))
  var day = Number(value.slice(8, 10))
  var date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

// A holiday-cn document: {year, days:[{name, date, isOffDay}]}. Parsed strictly,
// for the same reason the balance response is: this is fetched text that ends up
// on screen. Every entry has to be right or the whole document is rejected —
// half a holiday table is a schedule that is wrong on some days and right on
// others, which is worse than the weekday rule it would replace.
//
// Only 放假 days become entries. A 调休 make-up workday is a weekend, and
// weekends are already off-peak, so carrying them would add rows no caller reads.
function parse(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_CACHE_BYTES)
    return { ok: false, days: {}, error: ERROR_INVALID }

  var payload
  try {
    payload = JSON.parse(text)
  } catch (e) {
    return { ok: false, days: {}, error: ERROR_INVALID }
  }

  if (!isPlainObject(payload)) return { ok: false, days: {}, error: ERROR_INVALID }
  if (!Array.isArray(payload.days) || payload.days.length > MAX_DAYS)
    return { ok: false, days: {}, error: ERROR_INVALID }

  // The document names its own year. When it does, every date in it has to
  // belong to that year: a stale or wrong file served for the year we asked for
  // is exactly the failure this catches.
  var declaredYear = isValidYear(payload.year) ? Number(payload.year) : null
  var yearPrefix = declaredYear === null ? "" : String(declaredYear) + "-"

  var days = {}
  for (var i = 0; i < payload.days.length; i++) {
    var entry = payload.days[i]
    if (!isPlainObject(entry)) return { ok: false, days: {}, error: ERROR_INVALID }
    if (entry.isOffDay !== true) continue
    if (!isDateKey(entry.date)) return { ok: false, days: {}, error: ERROR_INVALID }
    if (yearPrefix !== "" && entry.date.indexOf(yearPrefix) !== 0)
      return { ok: false, days: {}, error: ERROR_INVALID }
    if (typeof entry.name !== "string" || entry.name.length === 0) return { ok: false, days: {}, error: ERROR_INVALID }
    if (entry.name.length > MAX_NAME_LENGTH) return { ok: false, days: {}, error: ERROR_INVALID }
    if (NAME_CONTROL_RE.test(entry.name)) return { ok: false, days: {}, error: ERROR_INVALID }
    days[entry.date] = entry.name
  }
  return { ok: true, days: days, error: "" }
}

// The baked table, as a fresh object — a caller that merges into what it is
// given must not be able to edit the module's own data.
function fallback() {
  return merge({}, FALLBACK)
}

function merge(base, extra) {
  var out = {}
  var tables = [base, extra]
  for (var t = 0; t < tables.length; t++) {
    var table = tables[t]
    if (!isPlainObject(table)) continue
    for (var key in table) {
      if (Object.prototype.hasOwnProperty.call(table, key)) out[key] = table[key]
    }
  }
  return out
}

// The table the schedule runs on: the baked floor with every readable cache
// document merged over it, in the order given. Unreadable documents are skipped
// rather than fatal — one year that failed to fetch must not cost the other.
function tableFromTexts(texts) {
  var table = fallback()
  var list = Array.isArray(texts) ? texts : []
  for (var i = 0; i < list.length; i++) {
    var parsed = parse(list[i])
    if (parsed.ok) table = merge(table, parsed.days)
  }
  return table
}

// The years a table covers, ascending. The status summary prints these, so the
// one visible signal that the fetched table is alive is also the one that says
// which years it knows about.
function yearsOf(table) {
  var seen = {}
  var years = []
  if (isPlainObject(table)) {
    for (var key in table) {
      if (!Object.prototype.hasOwnProperty.call(table, key)) continue
      var year = Number(String(key).slice(0, 4))
      if (!isFinite(year) || seen[year]) continue
      seen[year] = true
      years.push(year)
    }
  }
  return years.sort(function (a, b) { return a - b })
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CURL_BINARY: CURL_BINARY,
    HEAD_BINARY: HEAD_BINARY,
    MV_BINARY: MV_BINARY,
    ERROR_INVALID: ERROR_INVALID,
    MAX_CACHE_BYTES: MAX_CACHE_BYTES,
    MAX_DAYS: MAX_DAYS,
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    STEP_TIMEOUT_MS: STEP_TIMEOUT_MS,
    STALE_AFTER_MS: STALE_AFTER_MS,
    NEXT_YEAR_FETCH_LEAD_MS: NEXT_YEAR_FETCH_LEAD_MS,
    CACHE_FILE_PREFIX: CACHE_FILE_PREFIX,
    SOURCE_BASE_URL: SOURCE_BASE_URL,
    FALLBACK: FALLBACK,
    isValidYear: isValidYear,
    sourceUrl: sourceUrl,
    cacheHome: cacheHome,
    cachePath: cachePath,
    tmpPath: tmpPath,
    fetchSpec: fetchSpec,
    publishSpec: publishSpec,
    readSpec: readSpec,
    isDateKey: isDateKey,
    parse: parse,
    fallback: fallback,
    merge: merge,
    tableFromTexts: tableFromTexts,
    yearsOf: yearsOf
  }
}
