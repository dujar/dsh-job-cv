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
assert.ok(skill.includes('What is needed:'), 'skill decodes the marked-up revision format')
assert.ok(skill.includes('advice'), 'skill tells the agent to answer with judgement')

// route surface: exactly ONE exact-path registration per route (the webServer
// rejects duplicate exact paths — the boot crash this test guards against)
const groups = defineJobCvRoutes({
  store: { get: async () => ({ version: 0 }) },
  skillText: skill,
  sendText: () => {},
})
const paths = groups.flatMap((g) => g.entries.map((e) => e.path))
assert.deepEqual(paths, [...new Set(paths)], 'one registration per exact path')
assert.deepEqual(paths.sort(), [
  '/jobcv/doc',
  '/jobcv/history',
  '/jobcv/intake',
  '/jobcv/restore',
  '/jobcv/skill',
  '/jobcv/workspace',
])

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
assert.ok(summary.includes('GET /jobcv/workspace'))
assert.ok(summary.includes('POST /jobcv/workspace'))
assert.ok(summary.includes('POST /jobcv/intake'))
assert.ok(summary.includes('GET /jobcv/history'))
assert.ok(summary.includes('POST /jobcv/restore'))

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
const skillEntry = groups[3].entries[0]
assert.equal(skillEntry.method, 'GET')
const wrongVerb = fakeRes()
await guardHandler(skillEntry, guardDeps)(
  { method: 'POST', url: '/jobcv/skill', headers: { host: '127.0.0.1:3080' } },
  wrongVerb,
)
assert.equal(wrongVerb.code, 405)

// ---- the candidacy + intake routes ----
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
const wsRoot = await mkdtemp(pathJoin(tmpdir(), 'jobcv-routes-'))
try {
  const wsGroups = defineJobCvRoutes({
    store: {
      get: async () => ({ version: 0 }),
      setWorkspace: async () => '/apps/acme/job-1',
    },
    applicationsRoot: pathJoin(wsRoot, 'apps'),
    intakeRoot: pathJoin(wsRoot, 'intake'),
    skillText: skill,
    sendText: () => {},
    // real workspace/intake so the upsert really creates a folder
  })
  const wsEntry = wsGroups[1].entries[0]
  assert.equal(wsEntry.path, '/jobcv/workspace')
  assert.equal(wsEntry.method, undefined, 'the workspace handler dispatches GET vs POST itself')

  // workspace: missing sessionId
  const w1 = fakeRes()
  await wsEntry.handler(fakeReq('POST', '/jobcv/workspace', { company: 'Acme' }), w1)
  assert.equal(w1.code, 400)
  // workspace: missing company
  const w2 = fakeRes()
  await wsEntry.handler(fakeReq('POST', '/jobcv/workspace', { sessionId: 's1' }), w2)
  assert.equal(w2.code, 400)
  // workspace: happy path upserts and records the dir
  const w3 = fakeRes()
  await wsEntry.handler(
    fakeReq('POST', '/jobcv/workspace', {
      sessionId: 's1',
      company: 'Acme Corp',
      jobUrl: 'https://jobs.example.com/42',
    }),
    w3,
  )
  assert.equal(w3.code, 200)
  assert.equal(w3.body.ok, true)
  assert.equal(w3.body.path, pathJoin(wsRoot, 'apps', 'acme-corp', '42'))
  assert.equal(w3.body.company, 'acme-corp')
  assert.equal(w3.body.jobId, '42')
  assert.equal(w3.body.created, true)

  // workspace GET: lists the candidacy folder's files for the dock
  const wsGetStore = {
    get: async (sid) =>
      sid === 's1'
        ? {
            version: 1,
            workspace: pathJoin(wsRoot, 'apps', 'acme-corp', '42'),
            company: 'Acme Corp',
            jobTitle: 'Senior Engineer',
          }
        : { version: 0, workspace: '' },
  }
  const wsGetGroups = defineJobCvRoutes({
    store: wsGetStore,
    applicationsRoot: pathJoin(wsRoot, 'apps'),
    intakeRoot: pathJoin(wsRoot, 'intake'),
    skillText: skill,
    sendText: () => {},
  })
  const wsGetEntry = wsGetGroups[1].entries[0]
  // no workspace yet -> empty listing
  const wg0 = fakeRes()
  await wsGetEntry.handler({ method: 'GET', url: '/jobcv/workspace?session=other' }, wg0)
  assert.equal(wg0.code, 200)
  assert.equal(wg0.body.path, '')
  assert.deepEqual(wg0.body.files, [])
  // workspace present -> files sorted newest first, candidacy label carried
  const wg = fakeRes()
  await wsGetEntry.handler({ method: 'GET', url: '/jobcv/workspace?session=s1' }, wg)
  assert.equal(wg.code, 200)
  assert.equal(wg.body.path, pathJoin(wsRoot, 'apps', 'acme-corp', '42'))
  assert.deepEqual(
    wg.body.files.map((f) => f.name),
    ['README.md'],
    'the breadcrumb written by the upsert is listed',
  )
  assert.equal(wg.body.company, 'Acme Corp')
  assert.equal(wg.body.jobTitle, 'Senior Engineer')
  // missing session
  const wgMiss = fakeRes()
  await wsGetEntry.handler({ method: 'GET', url: '/jobcv/workspace' }, wgMiss)
  assert.equal(wgMiss.code, 400)
  // wrong verb -> 405
  const wg405 = fakeRes()
  await wsGetEntry.handler({ method: 'DELETE', url: '/jobcv/workspace?session=s1' }, wg405)
  assert.equal(wg405.code, 405)

  // ---- the version history + restore routes ----
  const verGroups = defineJobCvRoutes({
    store: {
      get: async () => ({ version: 0 }),
      history: async () => [
        { version: 4, updatedAt: 4 },
        { version: 3, updatedAt: 3 },
        { version: 2, updatedAt: 2 },
      ],
      restore: async (sid, version) => (version === 2 ? 5 : null),
    },
    skillText: skill,
    sendText: () => {},
  })
  const historyEntry = verGroups[2].entries[0]
  assert.equal(historyEntry.path, '/jobcv/history')
  assert.equal(historyEntry.method, 'GET')
  // missing session
  const h0 = fakeRes()
  await historyEntry.handler({ method: 'GET', url: '/jobcv/history' }, h0)
  assert.equal(h0.code, 400)
  // happy path: newest first, bodies omitted
  const h1 = fakeRes()
  await historyEntry.handler({ method: 'GET', url: '/jobcv/history?session=s1' }, h1)
  assert.equal(h1.code, 200)
  assert.deepEqual(
    h1.body.versions.map((v) => v.version),
    [4, 3, 2],
  )

  const restoreEntry = verGroups[2].entries[1]
  assert.equal(restoreEntry.path, '/jobcv/restore')
  assert.equal(restoreEntry.method, 'POST')
  // validation: missing session / bad version
  const r0 = fakeRes()
  await restoreEntry.handler(fakeReq('POST', '/jobcv/restore', { version: 2 }), r0)
  assert.equal(r0.code, 400)
  const r1 = fakeRes()
  await restoreEntry.handler(fakeReq('POST', '/jobcv/restore', { sessionId: 's1', version: 0 }), r1)
  assert.equal(r1.code, 400)
  // happy path
  const r2 = fakeRes()
  await restoreEntry.handler(fakeReq('POST', '/jobcv/restore', { sessionId: 's1', version: 2 }), r2)
  assert.equal(r2.code, 200)
  assert.equal(r2.body.version, 5)
  // unknown version -> 404
  const r3 = fakeRes()
  await restoreEntry.handler(
    fakeReq('POST', '/jobcv/restore', { sessionId: 's1', version: 99 }),
    r3,
  )
  assert.equal(r3.code, 404)

  // intake: rejects a missing or empty payload
  const intakeEntry = wsGroups[1].entries[1]
  assert.equal(intakeEntry.path, '/jobcv/intake')
  const i1 = fakeRes()
  await intakeEntry.handler(fakeReq('POST', '/jobcv/intake', {}), i1)
  assert.equal(i1.code, 400)
  const i2 = fakeRes()
  await intakeEntry.handler(
    fakeReq('POST', '/jobcv/intake', { sessionId: 's1', filename: 'cv.pdf', dataBase64: '' }),
    i2,
  )
  assert.equal(i2.code, 400)
  // intake: happy path stages the file and returns its path
  const i3 = fakeRes()
  await intakeEntry.handler(
    fakeReq('POST', '/jobcv/intake', {
      sessionId: 's1',
      filename: 'cv.pdf',
      dataBase64: Buffer.from('%PDF-1.4 hello').toString('base64'),
    }),
    i3,
  )
  assert.equal(i3.code, 200)
  assert.equal(i3.body.ok, true)
  assert.equal(i3.body.bytes, 14)
  assert.ok(i3.body.path.endsWith('cv.pdf'), 'staged under the intake root with the sanitized name')
} finally {
  await rm(wsRoot, { recursive: true, force: true })
}

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
