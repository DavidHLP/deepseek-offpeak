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
  // A real key: "sk-" plus 32 hex characters. The alphabet and the length
  // ceiling are separate rules; the ceiling has its own check below.
  for (const good of ["sk-" + "a".repeat(32), "sk-ABC-def_4560123456789",
    "sk-" + "x".repeat(61), "sk-" + "0".repeat(16)]) {
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

check("the request is one process, and the key is not in its argv", () => {
  const argv = B.CURL_ARGUMENTS
  assert.ok(Array.isArray(argv) && argv.length > 0)

  // curl is named by absolute path (the caller prepends B.CURL_BINARY), so
  // nothing earlier on PATH decides what runs.
  assert.ok(B.CURL_BINARY.startsWith("/"), "curl must be an absolute path")

  // No shell, no pipeline: one process, which is what makes killing it mean
  // the whole request is dead and no descendant can hold the stdout pipe.
  for (const arg of argv) {
    assert.ok(!/(^|\s)(bash|sh|head|printf|curl)(\s|$)/.test(arg),
      `argv must name no other program: ${JSON.stringify(arg)}`)
    assert.ok(!arg.includes("|"), `no pipeline: ${JSON.stringify(arg)}`)
  }

  // The key travels in the child's environment and is expanded by curl, so the
  // value is in no command line — argv carries only the variable's name.
  assert.ok(argv.includes("%" + B.KEY_ENVIRONMENT_VARIABLE), "curl reads the variable")
  assert.ok(argv.includes("Authorization: Bearer {{" + B.KEY_ENVIRONMENT_VARIABLE + "}}"),
    "the header is a template, not a value")
  assert.ok(!argv.some((arg) => /sk-/.test(arg)), "no key literal in argv")
  assert.ok(!argv.some((arg) => arg.includes("-H ")), "the header is not an argv literal")

  // The two timeouts, the byte cap, and the status-code trailer that
  // fromResponse() splits on.
  assert.ok(argv.includes("--connect-timeout") && argv.includes("5"), "5s connect timeout")
  assert.ok(argv.includes("--max-time") && argv.includes("10"), "10s total timeout")
  assert.ok(argv.includes("--max-filesize") && argv.includes(String(B.MAX_RESPONSE_BYTES)),
    "the body is capped in bytes, not just in time")
  assert.deepStrictEqual(argv.slice(-3),
    ["-w", "\n%{http_code}", "https://api.deepseek.com/user/balance"],
    "status code appended, documented endpoint last")
})

check("a key longer than the ceiling is not a key", () => {
  // The bound exists so nothing unbounded — a hostile environment, a secret
  // provider writing a wall of text — is held in memory and pushed through a
  // config line. A real key is about 35 characters.
  assert.strictEqual(B.isUsableKey("sk-" + "a".repeat(B.KEY_MAX_LENGTH - 3)), true,
    "exactly at the ceiling")
  assert.strictEqual(B.isUsableKey("sk-" + "a".repeat(B.KEY_MAX_LENGTH - 2)), false,
    "one character over the ceiling")
  assert.strictEqual(B.isUsableKey("sk-" + "a".repeat(4096)), false, "a wall of text")
})

check("the document has limits on its shape, not just on its size", () => {
  const wrap = (payload) => JSON.stringify(payload) + "\n200"
  const entry = (currency, total) => ({
    currency: currency, total_balance: total, granted_balance: "0", topped_up_balance: "0"
  })

  // Cardinality: a body under the byte cap can still be one huge array.
  const many = { is_available: true, balance_infos: [] }
  for (let i = 0; i <= B.MAX_BALANCES; i++) many.balance_infos.push(entry("CNY", "1"))
  assert.deepStrictEqual(B.fromResponse(0, wrap(many)), { ok: false, error: "invalid_response" },
    "one currency over the ceiling")
  assert.strictEqual(B.fromResponse(0, wrap({ is_available: true,
    balance_infos: many.balance_infos.slice(0, B.MAX_BALANCES) })).ok, true, "exactly at the ceiling")

  // Strings: a currency code is three letters, and an amount is a decimal — not
  // a 16 KiB field that fits inside the byte cap.
  assert.deepStrictEqual(B.fromResponse(0, wrap({ is_available: true,
    balance_infos: [entry("X".repeat(B.MAX_CURRENCY_LENGTH + 1), "1")] })),
  { ok: false, error: "invalid_response" }, "currency over the ceiling")
  assert.deepStrictEqual(B.fromResponse(0, wrap({ is_available: true,
    balance_infos: [entry("CNY", "1".repeat(B.MAX_AMOUNT_LENGTH + 1))] })),
  { ok: false, error: "invalid_response" }, "amount over the ceiling")
  assert.strictEqual(B.fromResponse(0, wrap({ is_available: true,
    balance_infos: [entry("CNY", "1".repeat(B.MAX_AMOUNT_LENGTH))] })).ok, true,
    "an amount at the ceiling is still a balance")
})

check("an oversized response is invalid_response, not a parse", () => {
  // curl aborts the transfer itself at --max-filesize, and reports 63.
  assert.deepStrictEqual(B.fromResponse(63, ""), { ok: false, error: "invalid_response" })
  // Belt and braces for anything else that hands a body in: the same bound is
  // applied to the text before it is parsed.
  const huge = good + " ".repeat(B.MAX_RESPONSE_BYTES) + "\n200"
  assert.deepStrictEqual(B.fromResponse(0, huge), { ok: false, error: "invalid_response" })

  // A body right at the bound is still read normally.
  assert.strictEqual(B.fromResponse(0, good + "\n200").ok, true)
})

console.log(`balance: ${checks} checks passed`)
