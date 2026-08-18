import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Load the built browser bundle the way the shell's ModuleLoader does, then
// reach the pure onboarding helpers through the __onboard test surface
// (same harness as test/annotate.test.mjs).
const require = createRequire(import.meta.url)
let spec = null
globalThis.window = { __ModuleLoader__: { load: (s) => (spec = s) } }
globalThis.document = { body: null }
function stubNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
}
stubNavigator({})
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const mod = spec.factory((n) => (n === 'react' ? require('react') : { createPortal: () => null }))
const B = mod.__onboard

// ---- buildStartMessage: the hand-off the agent receives ----
const msg = B.buildStartMessage('https://jobs.example.com/42', '/tmp/cv.pdf')
assert.ok(msg.includes('Job post link: https://jobs.example.com/42'))
assert.ok(msg.includes('My CV: /tmp/cv.pdf'))
assert.ok(msg.includes('/jobcv/workspace'), 'tells the agent to upsert the candidacy workspace')
assert.ok(msg.includes('/jobcv/doc'), 'tells the agent where to save the tailored CV')

// ---- intakeCv: reads the file as base64, POSTs it, resolves to the path ----
let sent = null
globalThis.fetch = async (url, opts) => {
  sent = [url, JSON.parse(opts.body)]
  return { ok: true, json: async () => ({ ok: true, path: '/intake/s1/cv.pdf', bytes: 3 }) }
}
// A fake FileReader: readAsDataURL is called synchronously, onload fires later.
globalThis.FileReader = function () {
  this.readAsDataURL = (file) => {
    this.result = 'data:application/pdf;base64,' + Buffer.from('ABC').toString('base64')
    process.nextTick(() => this.onload && this.onload())
  }
}
const staged = await B.intakeCv('s1', { name: 'cv.pdf' })
assert.equal(staged.path, '/intake/s1/cv.pdf')
assert.equal(sent[0], '/jobcv/intake')
assert.equal(sent[1].sessionId, 's1')
assert.equal(sent[1].filename, 'cv.pdf')
assert.equal(sent[1].dataBase64, Buffer.from('ABC').toString('base64'))

// ---- failure modes surface as readable errors ----
// a 4xx with a server message names both the message and the status
globalThis.fetch = async () => ({
  ok: false,
  status: 413,
  json: async () => ({ error: 'file too large' }),
})
await assert.rejects(B.intakeCv('s1', { name: 'cv.pdf' }), /file too large \(413\)/)
// a 200 that forgets the path is a contract violation, not "undefined"
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
await assert.rejects(B.intakeCv('s1', { name: 'cv.pdf' }), /no staged path/)

console.log('ok  onboarding helpers')
