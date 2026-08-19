import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Per-session preferences. loadPrefs normalizes a stored shape; savePrefs
// merges into it. The dock writes open/chatW and the pane writes
// swipeHintSeen, so a replace instead of a merge would silently drop
// whichever key the other half wrote first.
const require = createRequire(import.meta.url)
let spec = null
globalThis.window = { __ModuleLoader__: { load: (s) => (spec = s) } }
globalThis.document = { body: null }
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
}
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const mod = spec.factory((n) => (n === 'react' ? require('react') : { createPortal: () => null }))
const P = mod.__prefs

// an empty key falls back to the full shape, and the hint is unseen
assert.deepEqual(P.loadPrefs('s1'), { open: true, chatW: null, swipeHintSeen: false })

// a save round-trips through the normalized shape
P.savePrefs('s1', { open: false, chatW: 420 })
assert.deepEqual(P.loadPrefs('s1'), { open: false, chatW: 420, swipeHintSeen: false })

// the pane's hint write MERGES — it must not drop the dock's open/chatW
P.savePrefs('s1', { swipeHintSeen: true })
assert.deepEqual(P.loadPrefs('s1'), { open: false, chatW: 420, swipeHintSeen: true })

// ...and a later dock write must not drop the hint flag either
P.savePrefs('s1', { open: true, chatW: 500 })
assert.deepEqual(P.loadPrefs('s1'), { open: true, chatW: 500, swipeHintSeen: true })

// corrupt JSON reads as empty, never throws
store.set(P.prefsKey('s2'), '{not json')
assert.deepEqual(P.loadPrefs('s2'), { open: true, chatW: null, swipeHintSeen: false })

console.log('ok  prefs: session-scoped, merge-on-save, normalized on load')
