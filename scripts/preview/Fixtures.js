// Synthetic account states only; no credentials, files, processes or network.
var scenarios = ["balance", "loading", "cached", "missing", "network", "unavailable", "empty", "long", "holidays", "service"]
var times = [Date.UTC(2026, 8, 9, 2), Date.UTC(2026, 8, 9, 4), Date.UTC(2026, 8, 12, 12), Date.UTC(2026, 8, 9, 3, 59, 59), Date.UTC(2026, 8, 9, 4)]
function balance(name) {
  var amount = name === "long" ? "12345678901234567890.12" : "45.83"
  var rows = [{ currency: "CNY", totalBalance: amount, grantedBalance: "0.00", toppedUpBalance: amount }]
  if (name === "loading") return { status: "loading", error: "", isAvailable: false, balances: [], updatedAtMs: 0 }
  if (name === "missing" || name === "network") return { status: "error", error: name === "missing" ? "missing_api_key" : "network_error", isAvailable: false, balances: [], updatedAtMs: 0 }
  return { status: name === "cached" ? "loading" : "ok", error: "", isAvailable: name !== "unavailable", balances: name === "unavailable" || name === "empty" ? [] : rows, updatedAtMs: times[0] - 60000 }
}
if (typeof module !== "undefined") module.exports = { scenarios: scenarios, times: times, balance: balance }
