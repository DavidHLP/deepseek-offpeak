// Pure fixture checks: these do not prove desktop input or rendering.
const assert = require('node:assert/strict')
const F = require('../scripts/preview/Fixtures.js')
const B = require('../lib/Balance.js')
const S = require('../lib/Schedule.js')
const H = require('../lib/Holidays.js')
assert.equal(new Set(F.scenarios).size, F.scenarios.length)
for (const name of F.scenarios) {
  const state = F.balance(name)
  assert.ok(['ok', 'loading', 'error'].includes(state.status), name)
  for (const row of state.balances) {
    const parsed = B.fromResponse(0, JSON.stringify({ is_available: true, balance_infos: [{
      currency: row.currency, total_balance: row.totalBalance,
      granted_balance: row.grantedBalance, topped_up_balance: row.toppedUpBalance
    }] }) + "\n200")
    assert.equal(parsed.ok, true, name)
  }
}
assert.equal(F.balance('missing').error, B.ERROR_MISSING_API_KEY)
assert.equal(F.balance('network').error, B.ERROR_NETWORK)
assert.equal(F.balance('loading').balances.length, 0)
assert.equal(F.balance('cached').status, 'loading')
assert.equal(F.balance('cached').balances.length, 1)
assert.ok(F.balance('cached').updatedAtMs > 0)
assert.equal(F.balance('unavailable').isAvailable, false)
assert.equal(F.balance('empty').balances.length, 0)
const states = F.times.map(now => S.stateAt(now, H.fallback()))
assert.deepEqual(states.map(s => s.peak), [true, false, false, true, false])
assert.equal(states[3].secondsToSwitch, 1)
assert.equal(F.times[4] - F.times[3], 1000)
console.log('preview: fixture states and switch boundary passed')
