import { strict as assert } from 'node:assert'
import { defineJobCvRoutes } from '../lib/routes/routes.js'
import { renderRouteSummary, guardHandler } from '../lib/routes/mount.js'
import { isTrustedRequest, readJsonBody, sendJson } from '../lib/http/http-utils.js'
import { skillInstructions } from '../lib/preset/preset-seed.js'

// the contract the seeded /job skill points the agent at
const skill = skillInstructions()
assert.ok(skill.includes('/jobcv/doc'), 'skill names the document route')
assert.ok(skill.includes('POST'), 'skill explains the save verb')
assert.ok(skill.includes('A4'), 'skill pins the A4 print size')
assert.ok(skill.includes('@page'), 'skill requires the @page rule')
assert.ok(skill.includes('http://127.0.0.1:'), 'skill URLs use the derived host base')
assert.ok(skill.includes('curl'), 'skill names a tool that can actually POST')
assert.ok(
  skill.includes('Content-Type: application/json'),
  'skill demands the header the trust gate requires -- curl -d would 403',
)

// route surface: exactly ONE exact-path registration per route (the webServer
// rejects duplicate exact paths — the boot crash this test guards against)
const groups = defineJobCvRoutes({
  store: { get: async () => ({ version: 0 }) },
  skillText: skill,
  sendText: () => {},
})
const paths = groups.flatMap((g) => g.entries.map((e) => e.path))
assert.deepEqual(paths, [...new Set(paths)], 'one registration per exact path')
assert.deepEqual(paths.sort(), ['/jobcv/doc', '/jobcv/skill'])

const summary = renderRouteSummary(
  groups.map((g) => [
    g.group,
    g.entries.flatMap((e) =>
      e.docs.map(function (d) {
        return [d[0], e.path, d[1]]
      }),
    ),
  ]),
)
assert.ok(summary.includes('[dsh-job-cv] host routes ready'))
assert.ok(summary.includes('GET /jobcv/doc'))
assert.ok(summary.includes('POST /jobcv/doc'))
assert.ok(summary.includes('GET /jobcv/skill'))

// the doc handler dispatches GET vs POST itself
function fakeRes() {
  return {
    code: 0,
    body: null,
    writeHead(c) {
      this.code = c
    },
    end(b) {
      if (b) this.body = JSON.parse(b)
    },
  }
}
const docEntry = groups[0].entries[0]

// GET: requires ?session=
const g1 = fakeRes()
await docEntry.handler({ method: 'GET', url: '/jobcv/doc' }, g1)
assert.equal(g1.code, 400)
// GET: happy path
const g2 = fakeRes()
await docEntry.handler({ method: 'GET', url: '/jobcv/doc?session=s1' }, g2)
assert.equal(g2.code, 200)
// POST: rejects missing body
import { EventEmitter } from 'node:events'
function fakeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json' }
  process.nextTick(function () {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}
const p1 = fakeRes()
await docEntry.handler(fakeReq('POST', '/jobcv/doc', {}), p1)
assert.equal(p1.code, 400)
const p2 = fakeRes()
await docEntry.handler(fakeReq('POST', '/jobcv/doc', { sessionId: 'ok', html: '   ' }), p2)
assert.equal(p2.code, 400)
const groups2 = defineJobCvRoutes({
  store: { get: async () => ({ version: 0 }), save: async () => 7 },
  skillText: skill,
  sendText: () => {},
})
const docEntry2 = groups2[0].entries[0]
const p3 = fakeRes()
await docEntry2.handler(
  fakeReq('POST', '/jobcv/doc', { sessionId: 'ok', html: '<html></html>' }),
  p3,
)
assert.equal(p3.code, 200)
assert.equal(p3.body.version, 7)
// other verbs: 405
const m = fakeRes()
await docEntry.handler({ method: 'DELETE', url: '/jobcv/doc' }, m)
assert.equal(m.code, 405)

// ---- the guards the webServer actually mounts ----
// The handler assertions above call entry.handler directly, which skips the
// wrapper the routes are really registered with. Exercise it for real.
const guardDeps = { isTrusted: isTrustedRequest, readJsonBody, sendJson }
const guarded = guardHandler(groups[0].entries[0], guardDeps)

const untrusted = fakeRes()
await guarded(
  { method: 'GET', url: '/jobcv/doc?session=s1', headers: { host: 'evil.com' } },
  untrusted,
)
assert.equal(untrusted.code, 403, 'a non-loopback Host never reaches the handler')
assert.equal(untrusted.body.error, 'untrusted request')

const forged = fakeRes()
await guarded(
  {
    method: 'GET',
    url: '/jobcv/doc?session=s1',
    headers: { host: '127.0.0.1:3080', origin: 'http://evil.com' },
  },
  forged,
)
assert.equal(forged.code, 403, 'cross-origin Origin rejects even on loopback')

const okGuarded = fakeRes()
await guarded(
  { method: 'GET', url: '/jobcv/doc?session=s1', headers: { host: '127.0.0.1:3080' } },
  okGuarded,
)
assert.equal(okGuarded.code, 200)

// the method guard fires for entries that declare one
const skillEntry = groups[1].entries[0]
assert.equal(skillEntry.method, 'GET')
const wrongVerb = fakeRes()
await guardHandler(skillEntry, guardDeps)(
  { method: 'POST', url: '/jobcv/skill', headers: { host: '127.0.0.1:3080' } },
  wrongVerb,
)
assert.equal(wrongVerb.code, 405)

// a throwing handler becomes a 500 rather than an unhandled rejection
const boom = fakeRes()
await guardHandler(
  {
    path: '/x',
    docs: [],
    handler: async function () {
      throw new Error('kaboom')
    },
  },
  guardDeps,
)({ method: 'GET', url: '/x', headers: { host: '127.0.0.1:3080' } }, boom)
assert.equal(boom.code, 500)
assert.equal(boom.body.error, 'kaboom')

console.log('ok  routes + skill contract')
