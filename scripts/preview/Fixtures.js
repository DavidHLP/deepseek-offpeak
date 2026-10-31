// Synthetic account states only; no credentials, files, processes or network.
var scenarios = ["balance", "loading", "cached", "missing", "network", "unavailable", "empty", "long", "holidays", "service", "old", "clock", "rejected", "limited", "keyfile"]
var times = [Date.UTC(2026, 8, 9, 2), Date.UTC(2026, 8, 9, 4), Date.UTC(2026, 8, 12, 12), Date.UTC(2026, 8, 9, 3, 59, 59), Date.UTC(2026, 8, 9, 4)]
function balance(name, nowMs) {
  var now = nowMs === undefined ? times[0] : nowMs
  var amount = name === "long" ? "12345678901234567890.12" : "45.83"
  var rows = [{ currency: "CNY", totalBalance: amount, grantedBalance: "0.00", toppedUpBalance: amount }]
  if (name === "loading") return { status: "loading", error: "", isAvailable: false, balances: [], updatedAtMs: 0 }
  var errors = { missing: "missing_api_key", network: "network_error", rejected: "http_401", limited: "http_429", keyfile: "invalid_api_key_file" }
  if (errors[name]) return { status: "error", error: errors[name], isAvailable: false, balances: [], updatedAtMs: 0 }
  return { status: name === "cached" ? "loading" : "ok", error: "", isAvailable: name !== "unavailable", balances: name === "unavailable" || name === "empty" ? [] : rows, updatedAtMs: now + (name === "clock" ? 60000 : (name === "old" ? -660000 : -60000)) }
}
if (typeof module !== "undefined") module.exports = { scenarios: scenarios, times: times, balance: balance }
