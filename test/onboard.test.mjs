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

// ---- offlineReason: a stalled preview has to say WHY ----
// A 403 is the failure that looks like a hang: the host trusts loopback only,
// so a GUI opened on a LAN address or a tunnel polls forever and shows
// nothing. The message has to point at that, not just "unreachable".
Object.defineProperty(globalThis, 'location', {
  value: { hostname: '192.168.1.106' },
  configurable: true,
  writable: true,
})
const forbidden = mod.__diagnostics.offlineReason(Object.assign(new Error('x'), { status: 403 }))
assert.ok(forbidden.includes('localhost'), 'names the fix: ' + forbidden)
assert.ok(forbidden.includes('192.168.1.106'), 'names the offending origin')
assert.equal(
  mod.__diagnostics.offlineReason(Object.assign(new Error('x'), { status: 500 })),
  'the host answered 500',
)
assert.ok(mod.__diagnostics.offlineReason(new Error('network')).includes('dsh web'))
assert.ok(mod.__diagnostics.offlineReason(undefined).includes('dsh web'))

// ---- buildStartMessage: the hand-off the agent receives ----
// the session id has to travel with the brief: the agent cannot derive one
const withSession = B.buildStartMessage(
  'https://jobs.example.com/42',
  '/tmp/cv.pdf',
  'Acme',
  null,
  'session-343d8da6-3066-4cd7-b5b7-e12f2dabdd9a',
)
assert.ok(
  withSession.includes('Session id: session-343d8da6-3066-4cd7-b5b7-e12f2dabdd9a'),
  'the brief states the session id verbatim',
)
assert.ok(!B.buildStartMessage('u', 'p').includes('Session id:'), 'omitted when unknown')

const msg = B.buildStartMessage('https://jobs.example.com/42', '/tmp/cv.pdf')
assert.ok(msg.includes('Job post link: https://jobs.example.com/42'))
assert.ok(msg.includes('My CV: /tmp/cv.pdf'))
assert.ok(msg.includes('/jobcv/workspace'), 'tells the agent to upsert the candidacy workspace')
assert.ok(msg.includes('/jobcv/doc'), 'tells the agent where to save the tailored CV')
assert.ok(!msg.includes('Company:'), 'no company given, no company line')

// an optional company name steers the agent's upsert
const withCompany = B.buildStartMessage('https://jobs.example.com/42', '/tmp/cv.pdf', 'Acme Corp')
assert.ok(withCompany.includes('Company: Acme Corp'))

// when the form already opened the workspace, the message names the exact
// path so the agent adopts it rather than deriving a different folder
const adopted = B.buildStartMessage(
  'https://jobs.example.com/42',
  '/tmp/cv.pdf',
  'Acme Corp',
  '/apps/acme-corp/42',
)
assert.ok(adopted.includes('already open at /apps/acme-corp/42'))
assert.ok(adopted.includes('created:false'), 'tells the agent the upsert will resume, not fork')
assert.ok(adopted.includes('adopt that folder'))

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

// ---- upsertWorkspace: the direct fallback posts to /jobcv/workspace ----
let wsSent = null
globalThis.fetch = async (url, opts) => {
  wsSent = [url, JSON.parse(opts.body)]
  return {
    ok: true,
    json: async () => ({ ok: true, path: '/apps/acme-corp/42', created: true }),
  }
}
const ws = await B.upsertWorkspace('s1', 'Acme Corp', 'https://jobs.example.com/42')
assert.equal(ws.path, '/apps/acme-corp/42')
assert.equal(wsSent[0], '/jobcv/workspace')
assert.equal(wsSent[1].sessionId, 's1')
assert.equal(wsSent[1].company, 'Acme Corp')
assert.equal(wsSent[1].jobUrl, 'https://jobs.example.com/42')
// a 4xx surfaces the server message + status; a 200 without a path rejects
globalThis.fetch = async () => ({
  ok: false,
  status: 400,
  json: async () => ({ error: 'company must be a non-empty string' }),
})
await assert.rejects(
  B.upsertWorkspace('s1', ' ', 'https://x'),
  /company must be a non-empty string \(400\)/,
)
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
await assert.rejects(B.upsertWorkspace('s1', 'Acme', 'https://x'), /no workspace path/)

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
