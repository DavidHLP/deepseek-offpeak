// DeepSeek /user/balance response handling.
//
// Split out of Service.qml so the failure paths are testable without a network:
// what counts as a good response, and which error each bad one produces.
//
// Errors, exactly one per outcome:
//   missing_api_key       no usable key in the environment or the key file
//   invalid_api_key_file  a key file exists but is not one key line
//   network_error         curl failed (DNS, connect, TLS, the 10s total timeout)
//   http_<code>           the request completed with a non-200 status
//   invalid_response      a 200 that is not the documented JSON shape
//
// Money stays a string. The API sends decimals like "110.00"; parsing them into
// floats to re-print them only invents rounding.

var ERROR_MISSING_API_KEY = "missing_api_key"
var ERROR_INVALID_KEY_FILE = "invalid_api_key_file"
var ERROR_NETWORK = "network_error"
var ERROR_INVALID_RESPONSE = "invalid_response"

// The API key is read from two places, in this order, and from nowhere else:
//
//   1. the process environment (DEEPSEEK_API_KEY), which an existing setup
//      already has and which therefore wins;
//   2. a key file at $XDG_CONFIG_HOME/deepseek-offpeak/key (mode 600), which
//      needs no session configuration at all.
//
// An earlier version ran `bash -ic` to read ~/.bashrc instead. That executed
// the user's startup files as code inside the long-lived shell process, started
// by a background widget — a modified ~/.bashrc, or a shadowed bash earlier on
// PATH, becomes code the shell runs on its own. A file that is read and parsed
// is the same convenience without the execution.
//
// The file is parsed, never evaluated, and the parse is strict: one line, the
// documented key shape, nothing else. See parseKeyFile.

// The one binary the request runs, by absolute path. Resolving it through PATH
// would mean a writable directory earlier in the search order chooses what
// actually runs.
var CURL_BINARY = "/usr/bin/curl"

// The most the request may deliver. curl's --max-time bounds how long a
// transfer may take, not how much it may deliver, so a hostile or broken
// endpoint would otherwise decide how much memory the request costs. A balance
// document is a few hundred bytes, so this is generous and still small, and the
// same bound is applied to the text before it is parsed.
var MAX_RESPONSE_BYTES = 16384

// Longest possible request, from process start to kill. Sits above curl's own
// 10s --max-time so the normal path ends on curl's terms, and below anything
// that would leave the caller waiting on a process that never reports back.
var REQUEST_TIMEOUT_MS = 15000

// curl's exit status when --max-filesize aborts the transfer.
var CURL_EXIT_MAX_FILESIZE = 63

// The variable curl reads the key from, out of its own environment.
var KEY_ENVIRONMENT_VARIABLE = "DEEPSEEK_API_KEY"

// The key file, relative to the config home. The plugin's own namespace, so it
// is obvious what reads it and it survives a plugin update — the plugin's
// directory is a git checkout that `omarchy plugin update` replaces.
var KEY_FILE_RELATIVE_PATH = "deepseek-offpeak/key"

// Most a key file may hold. A key is ~35 characters; anything larger is not
// this file, and reading it would cost memory for a value that will be rejected
// anyway.
var KEY_FILE_MAX_BYTES = 256

// Where the key file lives, from the two variables that decide it. The XDG
// variable wins when it is set, as it does for every other XDG path.
function keyFilePath(configHome, home) {
  var base = String(configHome === null || configHome === undefined ? "" : configHome)
  if (base === "") base = String(home === null || home === undefined ? "" : home) + "/.config"
  if (base === "/.config") return ""
  return base.replace(/\/+$/, "") + "/" + KEY_FILE_RELATIVE_PATH
}

// The key in a key file, or "" if the file is not exactly that.
//
// Strict on purpose. The file is the user's, but "the user's" is not a parse
// strategy: a file can hold a stray line, a trailing comment, or a value whose
// whitespace would end up inside the Authorization header. So: at most
// KEY_FILE_MAX_BYTES, one line (a trailing newline is fine, CRLF is fine),
// optional surrounding whitespace, and then the same shape `isUsableKey`
// demands of an environment value — nothing else is ever adopted.
function parseKeyFile(text) {
  if (typeof text !== "string") return ""
  if (text.length > KEY_FILE_MAX_BYTES) return ""
  var lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")
  if (lines.length !== 1) return ""
  var value = lines[0].replace(/^\s+|\s+$/g, "")
  return isUsableKey(value) ? value : ""
}

// Longest key this module will hold. A real one is about 35 characters.
var KEY_MAX_LENGTH = 64

// Bounds on the document itself. A 16 KiB body is already capped above, but a
// cap on bytes is not a cap on shape: 16 KiB of JSON can still be one array of
// ten thousand entries, or one field holding a 16 KiB string. These are the
// limits that keep what this module keeps in memory proportional to what a
// balance document actually is. The real response is one or two currencies with
// three-letter codes and short decimal strings.
var MAX_BALANCES = 16
var MAX_CURRENCY_LENGTH = 8
var MAX_AMOUNT_LENGTH = 32

// The request, as curl's own argv — one process, no shell, no pipeline, in one
// place because both the shell's Process and the CLI's spawnSync run it and a
// drift between two copies would be a security regression rather than a
// cosmetic one.
//
// curl reads the key from its own environment (`--variable %NAME`) and expands
// it into the header, so the value reaches neither the command line nor a pipe:
// argv carries the variable's name, and the key itself lives only in the
// child's environment — the same environment the shell process already has.
// `isUsableKey` is what makes that expansion safe: a quote, a backslash, a
// brace, or whitespace in the key would otherwise reach curl's header parser.
//
// Running curl directly is what makes the deadline real. Under a shell, killing
// the Process kills the shell, and a curl descendant can keep the stdout pipe
// open past it, so a `waitForEnd` collector would wait on a process nobody
// killed. Here the only process there is, is the one being killed.
//
// The trailing `-w "\n%{http_code}"` is what fromResponse() splits off.
var CURL_ARGUMENTS = [
  "--variable", "%" + KEY_ENVIRONMENT_VARIABLE,
  "--expand-header", "Authorization: Bearer {{" + KEY_ENVIRONMENT_VARIABLE + "}}",
  "-sS",
  "--connect-timeout", "5",
  "--max-time", "10",
  "--max-filesize", String(MAX_RESPONSE_BYTES),
  "-w", "\n%{http_code}",
  "https://api.deepseek.com/user/balance"
]

// A DeepSeek API key and nothing else.
//
// The shape is the documented one — `sk-` followed by an opaque alphanumeric
// body — and it is enforced strictly for safety rather than for tidiness: the
// key is expanded into curl's header (see CURL_ARGUMENTS), so a
// quote or backslash could rewrite that config and inject an option, and
// whitespace would end the line early.
//
// Both bounds matter. The floor rejects empty values, prompt-like noise, and
// the shapes an environment variable is likely to hold by accident. The ceiling
// is what keeps an unbounded string — from a hostile environment, or from a
// secret provider that writes one — from being held in memory and pushed
// through a config line. A real key is about 35 characters.
function isUsableKey(key) {
  if (typeof key !== "string") return false
  if (key.length > KEY_MAX_LENGTH) return false
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(key)
}

function missingApiKey() {
  return { ok: false, error: ERROR_MISSING_API_KEY }
}

function failure(error) {
  return { ok: false, error: error }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Amounts arrive as decimal strings ("110.00") and occasionally as numbers.
// Both are accepted; anything else is not a balance. Money stays a string: the
// API sends a fixed-precision decimal, and parsing it into a float only to
// re-print it invents rounding.
//
// Rejected: null/undefined, "", "   ", non-numeric text, NaN, Infinity, and
// negative values — the field is a prepaid balance, so a negative total means
// the response is not the shape this module documents, not that the account
// owes money.
function decimalOrNull(value) {
  var text
  if (typeof value === "number") {
    if (!isFinite(value)) return null
    text = String(value)
  } else if (typeof value === "string") {
    text = value.replace(/^\s+|\s+$/g, "")
  } else {
    return null
  }
  if (text.length === 0) return null
  if (text.length > MAX_AMOUNT_LENGTH) return null
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  return text
}

function parseBalanceEntry(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.currency !== "string" || raw.currency.length === 0) return null
  if (raw.currency.length > MAX_CURRENCY_LENGTH) return null
  var total = decimalOrNull(raw.total_balance)
  var granted = decimalOrNull(raw.granted_balance)
  var toppedUp = decimalOrNull(raw.topped_up_balance)
  if (total === null || granted === null || toppedUp === null) return null
  return {
    currency: raw.currency,
    totalBalance: total,
    grantedBalance: granted,
    toppedUpBalance: toppedUp
  }
}

function parsePayload(payload) {
  if (!isPlainObject(payload)) return null
  if (typeof payload.is_available !== "boolean") return null
  if (!Array.isArray(payload.balance_infos)) return null
  if (payload.balance_infos.length > MAX_BALANCES) return null

  var balances = []
  for (var i = 0; i < payload.balance_infos.length; i++) {
    var entry = parseBalanceEntry(payload.balance_infos[i])
    if (!entry) return null
    balances.push(entry)
  }
  return { isAvailable: payload.is_available, balances: balances }
}

// curl writes the body to stdout and appends `-w "\n%{http_code}"`, so the last
// line of stdout is the status code and everything before it is the body.
function splitResponse(stdout) {
  var text = String(stdout === null || stdout === undefined ? "" : stdout)
  var split = text.lastIndexOf("\n")
  if (split < 0) return { body: text, status: "" }
  return { body: text.slice(0, split), status: text.slice(split + 1).replace(/^\s+|\s+$/g, "") }
}

function fromResponse(exitCode, stdout) {
  // The transfer was cut off at the byte bound, so what arrived is a truncated
  // document, not a response to read. Reported as a bad response rather than as
  // a network failure: the network worked, the answer was oversized.
  if (Number(exitCode) === CURL_EXIT_MAX_FILESIZE) return failure(ERROR_INVALID_RESPONSE)
  if (Number(exitCode) !== 0) return failure(ERROR_NETWORK)

  // curl is capped at MAX_RESPONSE_BYTES, and this is the same bound applied to
  // whatever else calls in — the CLI's spawnSync, or a test.
  if (String(stdout === null || stdout === undefined ? "" : stdout).length > MAX_RESPONSE_BYTES)
    return failure(ERROR_INVALID_RESPONSE)

  var response = splitResponse(stdout)
  if (response.status !== "200") return failure("http_" + (response.status || "unknown"))

  var payload
  try {
    payload = JSON.parse(response.body)
  } catch (e) {
    return failure(ERROR_INVALID_RESPONSE)
  }

  var parsed = parsePayload(payload)
  if (!parsed) return failure(ERROR_INVALID_RESPONSE)
  return { ok: true, isAvailable: parsed.isAvailable, balances: parsed.balances }
}

// Human-readable line for the panel's balance section.
function describe(result) {
  if (!result) return "No balance data yet"
  if (result.ok) {
    if (!result.isAvailable) return "Account not available for API calls"
    if (result.balances.length === 0) return "No balance reported"
    return ""
  }
  if (result.error === ERROR_MISSING_API_KEY)
    return "Set DEEPSEEK_API_KEY, or write the key to the key file, to show the balance"
  if (result.error === ERROR_INVALID_KEY_FILE)
    return "The key file must hold one sk-… line and nothing else"
  if (result.error === ERROR_NETWORK) return "Could not reach api.deepseek.com"
  if (result.error === ERROR_INVALID_RESPONSE) return "Unexpected response from the balance API"
  if (String(result.error).indexOf("http_") === 0)
    return "Balance API returned " + String(result.error).slice(5)
  return "Balance unavailable"
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CURL_ARGUMENTS: CURL_ARGUMENTS,
    CURL_BINARY: CURL_BINARY,
    KEY_ENVIRONMENT_VARIABLE: KEY_ENVIRONMENT_VARIABLE,
    KEY_FILE_RELATIVE_PATH: KEY_FILE_RELATIVE_PATH,
    KEY_FILE_MAX_BYTES: KEY_FILE_MAX_BYTES,
    keyFilePath: keyFilePath,
    parseKeyFile: parseKeyFile,
    ERROR_INVALID_KEY_FILE: ERROR_INVALID_KEY_FILE,
    KEY_MAX_LENGTH: KEY_MAX_LENGTH,
    MAX_BALANCES: MAX_BALANCES,
    MAX_CURRENCY_LENGTH: MAX_CURRENCY_LENGTH,
    MAX_AMOUNT_LENGTH: MAX_AMOUNT_LENGTH,
    MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
    REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
    ERROR_MISSING_API_KEY: ERROR_MISSING_API_KEY,
    ERROR_NETWORK: ERROR_NETWORK,
    ERROR_INVALID_RESPONSE: ERROR_INVALID_RESPONSE,
    isUsableKey: isUsableKey,
    missingApiKey: missingApiKey,
    parsePayload: parsePayload,
    splitResponse: splitResponse,
    fromResponse: fromResponse,
    describe: describe
  }
}
