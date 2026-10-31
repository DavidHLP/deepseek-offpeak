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

assert.equal(B.readingInfo(F.balance('old'), F.times[0]).old, true)
assert.equal(B.readingInfo(F.balance('clock'), F.times[0]).old, true)
assert.equal(B.readingInfo(F.balance('balance', F.times[2]), F.times[2]).old, false)
assert.equal(F.balance('limited').error, 'http_429')
// Exercise the actual panel action; a busy/no-service click must be a no-op.
const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../Panel.qml'), 'utf8')
const refresh = source.match(/function refreshBalance\(\) \{[\s\S]*?\n  \}/)
assert.ok(refresh, 'find actual panel balance action')
let calls = 0
const root = { service: { refreshBalance() { calls++ } }, balanceLoading: true }
const activate = require('node:vm').runInNewContext(refresh[0] + '; refreshBalance;', { root })
activate()
assert.equal(calls, 0)
root.balanceLoading = false
activate()
assert.equal(calls, 1)
root.service = null
activate()
assert.equal(calls, 1)
// Execute actual scrolling code against measured-layout stand-ins.
const reveal = source.match(/function revealCursor\(\) \{[\s\S]*?\n  \}/)
assert.ok(reveal)
const viewport = { contentY: 0, height: 100, contentHeight: 600 }
const targets = [20, 250, 500].map(y => ({ height: 40, mapToItem() { return { y } } }))
const navigation = { cursor: 2, scrollBy(delta) {
  viewport.contentY = Math.max(0, Math.min(viewport.contentHeight - viewport.height, viewport.contentY + delta))
} }
const revealSelected = require('node:vm').runInNewContext(reveal[0] + '; revealCursor;', {
  root: navigation, panelScroll: viewport, panelColumn: {},
  timelineAction: targets[0], balanceAction: targets[1], notificationAction: targets[2]
})
revealSelected()
assert.equal(viewport.contentY, 440, 'notification row comes into view')
revealSelected()
assert.equal(viewport.contentY, 440, 'already visible row does not jump')
navigation.cursor = 0
revealSelected()
assert.equal(viewport.contentY, 20, 'wrapping back reveals the first action')
viewport.contentY = 0
viewport.height = 600
revealSelected()
assert.equal(viewport.contentY, 0, 'no scroll when the panel fits')
// Deferred reveals are one-shot; manual scrolling cancels a queued reveal.
const deferred = []
let layouts = 0
const actions = ['moveCursor', 'requestCursorReveal', 'flushCursorReveal', 'scrollBy'].map(name => {
  const match = source.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}'))
  assert.ok(match, name)
  return match[0]
})
Object.assign(navigation, { cursor: 1, cursorCount: 3, cursorRevealPending: false, opened: true,
  revealCursor: revealSelected })
Object.assign(navigation, require('node:vm').runInNewContext(actions.join('\n') +
  '; ({moveCursor, requestCursorReveal, flushCursorReveal, scrollBy});', {
    root: navigation, panelScroll: viewport,
    panelColumn: { forceLayout() { layouts++ } },
    timelineDetails: { forceLayout() { layouts++ } },
    timelineSection: { forceLayout() { layouts++ } },
    balanceContent: { forceLayout() { layouts++ } },
    Qt: { callLater(fn) { deferred.push(fn) } }
  }))
const drain = () => { while (deferred.length) deferred.shift()() }
viewport.height = 100
viewport.contentY = 0
navigation.moveCursor(1)
assert.equal(navigation.cursorRevealPending, true)
drain()
assert.equal(viewport.contentY, 440, 'deferred keyboard selection revealed')
assert.equal(navigation.cursorRevealPending, false)
assert.equal(layouts, 4)
// A later layout/data update must not move a viewport manually scrolled down.
navigation.cursor = 0
navigation.scrollBy(-140)
assert.equal(viewport.contentY, 300)
navigation.flushCursorReveal()
assert.equal(viewport.contentY, 300, 'background layout has no pending reveal')
navigation.requestCursorReveal()
navigation.scrollBy(10)
drain()
assert.equal(viewport.contentY, 310, 'manual scroll overrides queued navigation')
navigation.requestCursorReveal()
navigation.opened = false
drain()
assert.equal(navigation.cursorRevealPending, false)
assert.equal(viewport.contentY, 310, 'closing cancels queued navigation')
console.log('preview: fixture states and switch boundary passed')
