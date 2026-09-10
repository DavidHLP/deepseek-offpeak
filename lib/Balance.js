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

// Reads the API key out of the user's shell startup files, for the common case
// where it is exported from ~/.bashrc rather than the graphical session's
// environment.
//
// `-i` is required, not `-l`: bash sources ~/.bashrc only for *interactive*
// shells. A login shell (`bash -lc`) reads ~/.bash_profile / ~/.profile and
// never sees a .bashrc export. Verified both ways during development.
//
// The key is printed, never passed as an argument, so this command line is safe
// to show in `ps`. `HISTFILE=/dev/null` keeps the interactive shell from
// touching history, and the caller discards stderr (an interactive bash without
// a controlling terminal writes job-control warnings there — measured as the
// only noise produced against a real ~/.bashrc).
var KEY_RESOLUTION_SCRIPT = "printf '%s' \"${DEEPSEEK_API_KEY:-}\""

// Picks the key out of whatever the interactive shell printed.
//
// stdout should be the key alone, but ~/.bashrc is the user's own file and may
// echo a banner, a version manager's greeting, or a prompt-like line before it
// gets to the export. Scanning from the END takes the last thing printed — ours
// — and `isUsableKey` rejects the shape of the noise. Anything that is not a
// plausible key is never adopted.
function keyFromShellOutput(stdout) {
  var lines = String(stdout === null || stdout === undefined ? "" : stdout).split("\n")
  for (var i = lines.length - 1; i >= 0; i--) {
    var candidate = lines[i].replace(/^\s+|\s+$/g, "")
    if (isUsableKey(candidate)) return candidate
  }
  return ""
}

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
    + "curl -sS --connect-timeout 5 --max-time 10 --config -"
    + " -w \"\\n%{http_code}\""
    + " https://api.deepseek.com/user/balance"
].join("\n")

// Decides what the key lookup should do next. Pure, so the terminating
// behaviour is testable without a shell.
//
// `reason` is who is asking. One state calls for different answers depending
// on that, and collapsing the two questions into a single boolean is what made
// the code disagree with its own comments:
//
//   "completion"  the resolver just finished. Never re-arm it from here — a
//                 machine with no key would restart interactive bash the
//                 moment each one exited, forever.
//   "poll"        the timer. Look again only when no key is held: that is how
//                 a key added to ~/.bashrc takes effect without restarting the
//                 shell, at one lookup per interval rather than one per
//                 completion. With a key already in hand this is the common
//                 case, and it must not pay for an interactive shell every
//                 five minutes.
//   "manual"      the user just asked. Look again even with a key in hand: a
//                 rotated or revoked key would otherwise be sent forever,
//                 because nothing else ever re-reads a key that works.
//
// Returns:
//   "request"        a usable key is held; go make the balance request
//   "resolve"        start a key lookup
//   "wait"           a lookup is already in flight
//   "report-missing" settled with no key, and nothing asked us to look again
function apiKeyAction(state, hasKey, resolverRunning, reason) {
  if (state === "resolving" || resolverRunning === true) return "wait"
  if (hasKey && reason !== "manual") return "request"
  if (state === "ready" && reason === "completion") return "report-missing"
  return "resolve"
}

// A DeepSeek API key and nothing else.
//
// The shape is the documented one — `sk-` followed by an opaque alphanumeric
// body — and it is enforced strictly for two reasons:
//
//   1. Safety. The key is interpolated into a curl config (see
//      BALANCE_REQUEST_SCRIPT), so a quote or backslash could rewrite that
//      config and inject an option.
//   2. Provenance. `keyFromShellOutput` reads an interactive shell's stdout,
//      where ~/.bashrc may print a banner and bash may print a prompt-like
//      line. Adopting "the last printable token" would happily accept "$" or
//      ">" as the key; requiring the real prefix makes prompt noise
//      unmatchable rather than merely unlikely.
//
// The 16-character floor is well below the 32 hex characters a real key carries,
// so a genuine key is never rejected for being short.
function isUsableKey(key) {
  if (typeof key !== "string") return false
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
  if (Number(exitCode) !== 0) return failure(ERROR_NETWORK)

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
    KEY_RESOLUTION_SCRIPT: KEY_RESOLUTION_SCRIPT,
    keyFromShellOutput: keyFromShellOutput,
    apiKeyAction: apiKeyAction,
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
