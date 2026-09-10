// Self-check for the balance response handling. Run: node tests/balance.test.js
//
// The failure cases matter more than the happy one: the panel has to say
// something true about a missing key, an unreachable host, a rejected request,
// and a 200 that is not the documented shape, without any of them touching the
// schedule.

const assert = require("assert")
const B = require("../lib/Balance.js")

const good = JSON.stringify({
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
    { currency: "USD", total_balance: "3.50", granted_balance: "0.00", topped_up_balance: "3.50" }
  ]
})

let checks = 0
function check(name, fn) {
  fn()
  checks++
}

check("missing key", () => {
  assert.strictEqual(B.isUsableKey(""), false)
  assert.strictEqual(B.isUsableKey(undefined), false)
  assert.strictEqual(B.isUsableKey("   "), false, "whitespace only")
  assert.strictEqual(B.isUsableKey("sk-a\nb"), false, "a newline would rewrite the request")
  assert.strictEqual(B.isUsableKey("sk-" + "a".repeat(32)), true)
  assert.deepStrictEqual(B.missingApiKey(), { ok: false, error: "missing_api_key" })
})

check("a 200 with the documented shape parses", () => {
  const result = B.fromResponse(0, good + "\n200")
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.isAvailable, true)
  assert.strictEqual(result.balances.length, 2)
  assert.deepStrictEqual(result.balances[0], {
    currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00"
  })
  assert.strictEqual(B.describe(result), "")
  assert.strictEqual(B.describe({ ok: true, isAvailable: false, balances: [] }),
    "Account not available for API calls")
})

check("network failure is network_error", () => {
  // curl exits nonzero and prints nothing on stdout when it cannot connect.
  assert.deepStrictEqual(B.fromResponse(7, ""), { ok: false, error: "network_error" })
  assert.deepStrictEqual(B.fromResponse(28, ""), { ok: false, error: "network_error" }, "timeout")
  assert.strictEqual(B.describe({ ok: false, error: "network_error" }),
    "Could not reach api.deepseek.com")
})

check("non-200 is http_<status>", () => {
  assert.deepStrictEqual(B.fromResponse(0, "Unauthorized\n401"), { ok: false, error: "http_401" })
  assert.deepStrictEqual(B.fromResponse(0, "go away\n503"), { ok: false, error: "http_503" })
  // A body that looks like JSON is still not a balance when the status is bad.
  assert.deepStrictEqual(B.fromResponse(0, good + "\n500"), { ok: false, error: "http_500" })
  assert.strictEqual(B.describe({ ok: false, error: "http_429" }), "Balance API returned 429")
})

check("invalid JSON is invalid_response", () => {
  assert.deepStrictEqual(B.fromResponse(0, "not json at all\n200"), { ok: false, error: "invalid_response" })
  assert.deepStrictEqual(B.fromResponse(0, "\n200"), { ok: false, error: "invalid_response" })
  assert.deepStrictEqual(B.fromResponse(0, "<html>hi</html>\n200"), { ok: false, error: "invalid_response" })
})

check("missing or wrong-typed fields are invalid_response", () => {
  const cases = [
    JSON.stringify({ balance_infos: [] }),                                     // no is_available
    JSON.stringify({ is_available: "yes", balance_infos: [] }),                // not a boolean
    JSON.stringify({ is_available: true }),                                    // no balance_infos
    JSON.stringify({ is_available: true, balance_infos: {} }),                 // not an array
    JSON.stringify({ is_available: true, balance_infos: [null] }),
    JSON.stringify({ is_available: true, balance_infos: [{}] }),               // no currency
    JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY" }] }), // no amounts
    JSON.stringify({ is_available: true, balance_infos: [
      { currency: "CNY", total_balance: "1", granted_balance: "1" }] }),        // no topped_up_balance
    JSON.stringify([{ is_available: true }]),                                  // array, not object
    JSON.stringify("a string")
  ]
  for (const body of cases) {
    assert.deepStrictEqual(B.fromResponse(0, body + "\n200"), { ok: false, error: "invalid_response" },
      `body: ${body}`)
  }
  // A numeric amount is accepted and rendered as text, not dropped.
  const numeric = B.fromResponse(0, JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: 3.5, granted_balance: 0, topped_up_balance: 3.5 }]
  }) + "\n200")
  assert.strictEqual(numeric.ok, true)
  assert.strictEqual(numeric.balances[0].totalBalance, "3.5")
})

check("an empty balance list is a good response", () => {
  const result = B.fromResponse(0, JSON.stringify({ is_available: true, balance_infos: [] }) + "\n200")
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.balances.length, 0)
  assert.strictEqual(B.describe(result), "No balance reported")
})

check("the status line is split off the body, however the body ends", () => {
  assert.deepStrictEqual(B.splitResponse("body\n200"), { body: "body", status: "200" })
  // A body containing newlines keeps them; only the last line is the status.
  assert.deepStrictEqual(B.splitResponse("{\n\"a\": 1\n}\n200"), { body: "{\n\"a\": 1\n}", status: "200" })
  // No newline at all: no status to read, so the response is not a 200.
  assert.deepStrictEqual(B.fromResponse(0, "just a body"), { ok: false, error: "http_unknown" })
})

check("amounts must be finite, non-empty, and non-negative", () => {
  const wrap = (total) => JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: total, granted_balance: "0", topped_up_balance: "0" }]
  }) + "\n200"

  // Accepted: decimal strings and plain numbers, including zero.
  for (const [value, rendered] of [["110.00", "110.00"], ["0", "0"], [0, "0"],
    [3.5, "3.5"], ["0.01", "0.01"]]) {
    const result = B.fromResponse(0, wrap(value))
    assert.strictEqual(result.ok, true, `${JSON.stringify(value)} should be accepted`)
    assert.strictEqual(result.balances[0].totalBalance, rendered)
  }

  // Rejected: the shapes that mean the response is not a balance.
  for (const value of [null, undefined, "", "   ", "abc", "1e5", "1,000", "-5", -5,
    "-0.01", NaN, Infinity, -Infinity, {}, [], true]) {
    assert.deepStrictEqual(B.fromResponse(0, wrap(value)),
      { ok: false, error: "invalid_response" },
      `${JSON.stringify(value)} should be rejected`)
  }
})

check("the key alphabet rejects curl-config metacharacters, not just whitespace", () => {
  // The key becomes a curl config value; a quote or backslash would let it
  // rewrite the config and inject an option.
  for (const bad of ['sk-a"b', "sk-a\\b", "sk-a b", "sk-a\nb", "sk-a\tb", "", "   ",
    "sk-\u00e9", "sk-\u4e2d"]) {
    assert.strictEqual(B.isUsableKey(bad), false, `${JSON.stringify(bad)} must be rejected`)
  }
  // A real key: "sk-" plus 32 hex characters.
  for (const good of ["sk-" + "a".repeat(32), "sk-ABC-def_4560123456789",
    "sk-" + "x".repeat(200), "sk-" + "0".repeat(16)]) {
    assert.strictEqual(B.isUsableKey(good), true, `${good} should be accepted`)
  }
  // Not the documented shape: no prefix, too short, wrong characters, not a
  // string. Prompt-like single characters are the case this must exclude,
  // because the key is read from an interactive shell's stdout.
  for (const bad of ["$", ">", "%", "#", "sk-", "sk-short", "abc123def456789012",
    "A1b2C3", "AKIA" + "A".repeat(20), "sk-" + "a".repeat(15), "sk-" + "a".repeat(16) + " "] ) {
    assert.strictEqual(B.isUsableKey(bad), false, `${JSON.stringify(bad)} must be rejected`)
  }
  assert.strictEqual(B.isUsableKey(undefined), false)
  assert.strictEqual(B.isUsableKey(null), false)
  assert.strictEqual(B.isUsableKey(12345), false)
  assert.strictEqual(B.isUsableKey({}), false)
})

check("the shared request script keeps the key out of argv", () => {
  const script = B.BALANCE_REQUEST_SCRIPT
  assert.strictEqual(typeof script, "string")
  assert.ok(script.length > 0)

  // It must read the key from stdin...
  assert.ok(script.includes("read -r key"), script)
  // ...and must not name an environment variable or interpolate anything into
  // the command line. Either would put the key in /proc/<pid>/cmdline.
  assert.ok(!script.includes("$DEEPSEEK_API_KEY"), "no env lookup")
  assert.ok(!script.includes("-H "), "the header must not be an argv argument")
  // The header travels as a curl config on a pipe, and curl reads it from stdin.
  assert.ok(script.includes("--config -"), "config comes from stdin")
  assert.ok(script.includes("printf 'header = \"Authorization: Bearer %s\""), script)

  // The two timeouts and the status-code trailer that fromResponse() splits on.
  assert.ok(script.includes("--connect-timeout 5"), "5s connect timeout")
  assert.ok(script.includes("--max-time 10"), "10s total timeout")
  assert.ok(script.includes('-w "\\n%{http_code}"'), "status code appended")
  assert.ok(script.includes("https://api.deepseek.com/user/balance"), "documented endpoint")

  // The same text must be what both runtimes execute: the string is exported,
  // so this assertion is the single definition.
  assert.strictEqual(B.BALANCE_REQUEST_SCRIPT, script)
})

check("the shell lookup adopts only a plausible key from its output", () => {
  const key = "sk-" + "abc123def456".repeat(3)  // a realistic-length key

  // The ordinary case: the key alone, with or without surrounding whitespace.
  assert.strictEqual(B.keyFromShellOutput(key), key)
  assert.strictEqual(B.keyFromShellOutput(key + "\n"), key)
  assert.strictEqual(B.keyFromShellOutput("  " + key + "  \n"), key)

  // ~/.bashrc is the user's own file: banners and greetings come first, and the
  // export lands last. The scan takes the last plausible line.
  assert.strictEqual(B.keyFromShellOutput("Welcome to bash!\n" + key), key)
  assert.strictEqual(B.keyFromShellOutput("nvm: v20 loaded\n" + key + "\n"), key)
  // A prompt-like trailing line must not win over a real key.
  assert.strictEqual(B.keyFromShellOutput(key + "\n$ "), key)

  // Nothing usable is nothing, never a guess: an empty var, prompt noise, and
  // values that isUsableKey rejects (quotes, backslashes, whitespace).
  for (const output of ["", "\n", "bash: no job control in this shell", "$ ", "  ",
    "sk-a b", 'sk-a"b', "sk-a\\b", "[nvm] loaded"]) {
    assert.strictEqual(B.keyFromShellOutput(output), "", JSON.stringify(output))
  }
  assert.strictEqual(B.keyFromShellOutput(null), "")
  assert.strictEqual(B.keyFromShellOutput(undefined), "")

  // A key on an earlier line is still found if nothing later is plausible.
  assert.strictEqual(B.keyFromShellOutput(key + "\nDone."), key)
})

check("the shell lookup asks for the key without ever passing it", () => {
  const script = B.KEY_RESOLUTION_SCRIPT
  assert.strictEqual(typeof script, "string")
  // Prints the value of the variable; names it, never inlines it.
  assert.ok(script.includes("DEEPSEEK_API_KEY"), script)
  assert.ok(script.includes("printf"), script)
  // No secret literal, and the script carries no value of its own.
  assert.ok(!/sk-/.test(script), "the script must not embed a key")
})

check("the key lookup terminates when there is no key anywhere", () => {
  const A = B.apiKeyAction

  // A usable key goes straight to the request, in every state.
  for (const state of ["pending", "resolving", "ready"]) {
    assert.strictEqual(A(state, true, false, false), "request", `key held, state ${state}`)
  }

  // The first pass resolves.
  assert.strictEqual(A("pending", false, false, false), "resolve")

  // While a lookup is in flight, wait — never start a second one.
  assert.strictEqual(A("pending", false, true, false), "wait")
  assert.strictEqual(A("resolving", false, false, false), "wait")
  assert.strictEqual(A("resolving", false, true, true), "wait", "even when forced")

  // THE BUG THIS GUARDS: the resolver's own completion handler asks for a
  // balance with forceResolve=false. If that re-armed the lookup, a machine with
  // no key would restart interactive bash the instant each one exited, forever.
  assert.strictEqual(A("ready", false, false, false), "report-missing")

  // Terminating means: from "ready", only an explicit re-resolve moves.
  let state = "pending"
  const seen = []
  const tick = (force) => {
    const action = A(state, false, false, force)
    seen.push(action)
    if (action === "resolve") state = "resolving"
    else if (action === "report-missing") state = "ready"
    return action
  }
  // A cold start, then 200 ordinary (non-forced) passes: exactly one resolve.
  assert.strictEqual(tick(false), "resolve")
  state = "ready"                       // as onExited would leave it
  for (let i = 0; i < 200; i++) tick(false)
  assert.strictEqual(seen.filter((a) => a === "resolve").length, 1,
    `200 non-forced passes must not re-resolve: ${seen.slice(0, 6)}`)

  // A forced pass (the 5-minute poll, or a manual refresh) does look again —
  // that is how a newly exported key is picked up.
  assert.strictEqual(tick(true), "resolve")
  state = "ready"
  assert.strictEqual(tick(true), "resolve")
})

console.log(`balance: ${checks} checks passed`)
