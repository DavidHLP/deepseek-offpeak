// DeepSeek /user/balance response handling.
//
// Split out of Service.qml so the failure paths are testable without a network:
// what counts as a good response, and which error each bad one produces.
//
// Errors, exactly one per outcome:
//   missing_api_key   no usable DEEPSEEK_API_KEY in the environment
//   network_error     curl failed (DNS, connect, TLS, the 10s total timeout)
//   http_<code>       the request completed with a non-200 status
//   invalid_response  a 200 that is not the documented JSON shape
//
// Money stays a string. The API sends decimals like "110.00"; parsing them into
// floats to re-print them only invents rounding.

var ERROR_MISSING_API_KEY = "missing_api_key"
var ERROR_NETWORK = "network_error"
var ERROR_INVALID_RESPONSE = "invalid_response"

// The API key is read from the process environment and from nowhere else.
//
// An earlier version also ran an interactive bash to read ~/.bashrc, because
// exporting the key there is a common setup. That meant executing the user's
// startup files as code inside the long-lived shell process, started by a
// background widget — a modified ~/.bashrc, or anything earlier on PATH,
// becomes code the shell runs on its own. The environment is enough: export
// DEEPSEEK_API_KEY into the session that starts omarchy-shell.

// The two binaries the request names, by absolute path. Resolving either
// through PATH would mean a writable directory earlier in the search order
// chooses what actually runs.
var BASH_BINARY = "/usr/bin/bash"
var CURL_BINARY = "/usr/bin/curl"

// The most curl may write before the transfer is aborted, and the most this
// module will look at. curl's --max-time bounds how long a transfer may take,
// not how much it may deliver, so without a byte bound a hostile or broken
// endpoint decides how much memory the request costs.
var MAX_RESPONSE_BYTES = 65536

// Longest possible request, from process start to kill. Sits above curl's own
// 10s --max-time so the normal path ends on curl's terms, and below anything
// that would leave the caller waiting on a process that never reports back.
var REQUEST_TIMEOUT_MS = 15000

// curl's exit status when --max-filesize aborts the transfer.
var CURL_EXIT_MAX_FILESIZE = 63

// Longest key this module will hold. A real one is about 35 characters.
var KEY_MAX_LENGTH = 64

// The exact shell used to read the balance, in one place because both the
// shell's Process and the CLI's spawnSync run it and a drift between two copies
// would be a security regression, not just a cosmetic one: this snippet is what
// keeps the API key out of argv.
//
// The key arrives on stdin, is read by `read`, and is formatted into a curl
// config that `printf` pipes to curl — so the key appears in no command line and
// in no environment. `--config -` then makes curl read that config from its own
// stdin. The trailing `-w "\n%{http_code}"` is what fromResponse() splits off.
//
// `isUsableKey` is the guard on interpolating into that config: a quote or a
// backslash would let a key rewrite the config, and whitespace would end the
// line early.
var BALANCE_REQUEST_SCRIPT = [
  "IFS= read -r key || exit 1",
  "printf 'header = \"Authorization: Bearer %s\"\\n' \"$key\" | "
    + CURL_BINARY + " -sS --connect-timeout 5 --max-time 10"
    + " --max-filesize " + MAX_RESPONSE_BYTES
    + " --config - -w \"\\n%{http_code}\""
    + " https://api.deepseek.com/user/balance"
].join("\n")

// A DeepSeek API key and nothing else.
//
// The shape is the documented one — `sk-` followed by an opaque alphanumeric
// body — and it is enforced strictly for safety rather than for tidiness: the
// key is interpolated into a curl config (see BALANCE_REQUEST_SCRIPT), so a
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
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  return text
}

function parseBalanceEntry(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.currency !== "string" || raw.currency.length === 0) return null
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
  if (result.error === ERROR_MISSING_API_KEY) return "Set DEEPSEEK_API_KEY to show the balance"
  if (result.error === ERROR_NETWORK) return "Could not reach api.deepseek.com"
  if (result.error === ERROR_INVALID_RESPONSE) return "Unexpected response from the balance API"
  if (String(result.error).indexOf("http_") === 0)
    return "Balance API returned " + String(result.error).slice(5)
  return "Balance unavailable"
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    BALANCE_REQUEST_SCRIPT: BALANCE_REQUEST_SCRIPT,
    BASH_BINARY: BASH_BINARY,
    CURL_BINARY: CURL_BINARY,
    KEY_MAX_LENGTH: KEY_MAX_LENGTH,
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
