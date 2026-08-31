import { strict as assert } from 'node:assert'
import { defineJobCvRoutes } from '../lib/routes/routes.js'
import { renderRouteSummary, guardHandler } from '../lib/routes/mount.js'
import { isTrustedRequest, readJsonBody, sendJson } from '../lib/http/http-utils.js'
import { skillInstructions, PRESET_COMPOSITION } from '../lib/preset/preset-seed.js'

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

// The preset must not enable a web capability the harness cannot serve.
// dsh-web resolves a provider per capability and only a SEARCH provider is
// ever registered (dsh-web-search-deepseek); nothing calls
// registerFetchProvider. web_fetch therefore dies on every call with
// "no usable web provider is registered" — which is why the shipped
// 'standard' preset also pins fetch:false.
assert.ok(
  /- id: tool-web[\s\S]*?fetch: false/.test(PRESET_COMPOSITION),
  'tool-web must keep fetch disabled: there is no fetch provider to serve it',
)
assert.ok(
  !/fetch: true/.test(PRESET_COMPOSITION),
  'nothing in the preset may turn web fetch back on',
)
assert.ok(
  skill.includes('no usable web provider is registered'),
  'the contract names the exact error, so the agent does not retry web_fetch',
)
assert.ok(skill.includes('curl -sSL'), 'the contract shows how to read a post instead')
assert.ok(
  skill.includes('YOUR SESSION ID'),
  'the contract explains where the session id comes from',
)
assert.ok(skill.includes('/jobcv/proposal'), 'the contract routes content changes through review')
assert.ok(skill.includes('/jobcv/letter'), 'the contract names the letter route')
assert.ok(skill.includes('"note"'), 'every save labels itself for the history timeline')
assert.ok(
  skill.includes('NOT /jobcv/doc'),
  'saving the letter through the CV route would overwrite the CV',
)
assert.ok(
  skill.includes('ITS FIRST LINE NAMES THE DOCUMENT'),
  'a marked-up request says whether it is about the CV or the letter, and the contract says to read it',
)
assert.ok(
  skill.includes('CONTENT CHANGES NEED THE USER TO SAY YES'),
  'wording is the user decision, not the agent one',
)
assert.ok(
  skill.includes('Formatting is NOT a content change'),
  'layout work still saves directly — approving a margin helps nobody',
)
assert.ok(
  skill.includes('SEVERAL PARTS'),
  'one comment usually implicates more than the part commented on',
)
assert.ok(
  skill.includes('do not guess'),
  'a guessed session id saves successfully into a document nobody watches',
)
assert.ok(
  skill.includes('SEVERAL JOBS IN ONE SESSION'),
  'the contract explains that one session can hold several applications',
)
assert.ok(skill.includes('/jobcv/switch'), 'the contract tells the agent how to switch jobs')
assert.ok(
  skill.includes('resumed'),
  'the switch answer says whether earlier work came back with the job',
)
assert.ok(
  skill.includes('BIND YOUR SAVES'),
  'the contract binds saves to the posting they were written for',
)
assert.ok(skill.includes('409'), 'the contract names the status a mid-turn switch answers with')

// the master CV: source of truth, own version line, mechanical deltas
assert.ok(skill.includes('/jobcv/master'), 'the contract names the master route')
assert.ok(skill.includes('THE MASTER CV'), 'the contract explains what the master is')
assert.ok(
  skill.includes('do NOT ask for a'),
  'with a master present, a start without a CV path starts from it instead of asking',
)
assert.ok(skill.includes('/jobcv/delta'), 'the agent reads the compact delta, never every past CV')
assert.ok(
  skill.includes('NEVER through /jobcv/doc'),
  'saving the master through the candidacy route would overwrite the tailored CV',
)

// route surface: exactly ONE exact-path registration per route (the webServer
// rejects duplicate exact paths — the boot crash this test guards against)
const groups = defineJobCvRoutes({
  store: { get: async () => ({ version: 0 }) },
  skillText: skill,
  sendText: () => {},
})
/** Look a route up by path — positional indexing renumbers whenever a group is added. */
function entryFor(all, path) {
  for (const group of all) {
    for (const entry of group.entries) if (entry.path === path) return entry
  }
  throw new Error('no route declared for ' + path)
}

const paths = groups.flatMap((g) => g.entries.map((e) => e.path))
assert.deepEqual(paths, [...new Set(paths)], 'one registration per exact path')
assert.deepEqual(paths.sort(), [
  '/jobcv/applications',
  '/jobcv/brief',
  '/jobcv/candidacies',
  '/jobcv/cvs',
  '/jobcv/delta',
  '/jobcv/doc',
  '/jobcv/file',
  '/jobcv/fit',
  '/jobcv/history',
  '/jobcv/intake',
  '/jobcv/joblist',
  '/jobcv/letter',
  '/jobcv/master',
  '/jobcv/post',
  '/jobcv/profile',
  '/jobcv/proposal',
  '/jobcv/proposal/decision',
  '/jobcv/restore',
  '/jobcv/skill',
  '/jobcv/status',
  '/jobcv/stream',
  '/jobcv/switch',
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
assert.ok(summary.includes('GET /jobcv/cvs'))
assert.ok(summary.includes('POST /jobcv/restore'))
assert.ok(summary.includes('GET /jobcv/master'))
assert.ok(summary.includes('POST /jobcv/master'))
assert.ok(summary.includes('GET /jobcv/delta'))

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
const docEntry = entryFor(groups, '/jobcv/doc')

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

// ---- the cover letter is a SECOND document, with its own version line ----
{
  let savedHtml = null
  const letterGroups = defineJobCvRoutes({
    store: {
      get: async () => ({ letter: { version: 2, html: '<p>Dear team</p>', updatedAt: 1 } }),
      saveLetter: async (sid, doc) => {
        savedHtml = doc.html
        return 3
      },
    },
    skillText: skill,
    sendText: () => {},
  })
  const letterEntry = entryFor(letterGroups, '/jobcv/letter')
  const lg = fakeRes()
  await letterEntry.handler({ method: 'GET', url: '/jobcv/letter?session=s1' }, lg)
  assert.equal(lg.code, 200)
  assert.equal(lg.body.letter.version, 2)

  const lp = fakeRes()
  await letterEntry.handler(
    fakeReq('POST', '/jobcv/letter', { sessionId: 's1', html: '<p>hi</p>' }),
    lp,
  )
  assert.equal(lp.code, 200)
  assert.equal(lp.body.version, 3, 'the letter versions independently of the CV')
  assert.equal(savedHtml, '<p>hi</p>')

  // an empty letter is not a letter
  const lbad = fakeRes()
  await letterEntry.handler(fakeReq('POST', '/jobcv/letter', { sessionId: 's1', html: '  ' }), lbad)
  assert.equal(lbad.code, 400)
}

// ---- the guards the webServer actually mounts ----
// The handler assertions above call entry.handler directly, which skips the
// wrapper the routes are really registered with. Exercise it for real.
const guardDeps = { isTrusted: isTrustedRequest, readJsonBody, sendJson }
const guarded = guardHandler(entryFor(groups, '/jobcv/doc'), guardDeps)

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
const skillEntry = entryFor(groups, '/jobcv/skill')
assert.equal(skillEntry.method, 'GET')
const wrongVerb = fakeRes()
await guardHandler(skillEntry, guardDeps)(
  { method: 'POST', url: '/jobcv/skill', headers: { host: '127.0.0.1:3080' } },
  wrongVerb,
)
assert.equal(wrongVerb.code, 405)

// ---- the candidacy + intake routes ----
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
const wsRoot = await mkdtemp(pathJoin(tmpdir(), 'jobcv-routes-'))
try {
  const wsGroups = defineJobCvRoutes({
    store: {
      get: async () => ({ version: 0 }),
      setWorkspace: async () => '/apps/acme/job-1',
    },
    resolveRoot: () => pathJoin(wsRoot, 'apps'),
    intakeRoot: pathJoin(wsRoot, 'intake'),
    skillText: skill,
    sendText: () => {},
    // real workspace/intake so the upsert really creates a folder
  })
  const wsEntry = entryFor(wsGroups, '/jobcv/workspace')
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
    resolveRoot: () => pathJoin(wsRoot, 'apps'),
    intakeRoot: pathJoin(wsRoot, 'intake'),
    skillText: skill,
    sendText: () => {},
  })
  const wsGetEntry = entryFor(wsGetGroups, '/jobcv/workspace')
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
    wg.body.files.map((f) => f.name).sort(),
    ['README.md', 'application.json'],
    'the breadcrumb and the recorded identity are listed',
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

  // ---- the file route: opens one candidacy file in its own tab ----
  function fileRes() {
    return {
      code: 0,
      headers: null,
      body: null,
      writeHead(c, h) {
        this.code = c
        this.headers = h
      },
      end(b) {
        this.body = b
      },
    }
  }
  const fileGroups = defineJobCvRoutes({
    store: wsGetStore,
    resolveRoot: () => pathJoin(wsRoot, 'apps'),
    intakeRoot: pathJoin(wsRoot, 'intake'),
    skillText: skill,
    sendText: () => {},
  })
  const fileEntry = entryFor(fileGroups, '/jobcv/file')
  assert.equal(fileEntry.path, '/jobcv/file')
  assert.equal(fileEntry.method, 'GET')

  // missing session / missing name
  const f0 = fileRes()
  await fileEntry.handler({ method: 'GET', url: '/jobcv/file' }, f0)
  assert.equal(f0.code, 400)
  const f1 = fileRes()
  await fileEntry.handler({ method: 'GET', url: '/jobcv/file?session=s1' }, f1)
  assert.equal(f1.code, 400)

  // happy path: the breadcrumb is served as text/plain
  const f2 = fileRes()
  await fileEntry.handler({ method: 'GET', url: '/jobcv/file?session=s1&name=README.md' }, f2)
  assert.equal(f2.code, 200)
  assert.ok(f2.headers['content-type'].indexOf('text/plain') === 0)
  assert.ok(String(f2.body).includes('Created by the dsh-job-cv plugin'))

  // an HTML file is served with a sandbox so agent HTML never runs in the
  // harness origin
  const cvDir = pathJoin(wsRoot, 'apps', 'acme-corp', '42', 'cv')
  await mkdir(cvDir, { recursive: true })
  await writeFile(pathJoin(cvDir, 'latest.html'), '<script>alert(1)</script>')
  const f3 = fileRes()
  await fileEntry.handler({ method: 'GET', url: '/jobcv/file?session=s1&name=cv/latest.html' }, f3)
  assert.equal(f3.code, 200)
  assert.ok(f3.headers['content-type'].indexOf('text/html') === 0)
  assert.equal(f3.headers['content-security-policy'], 'sandbox')
  assert.equal(String(f3.body), '<script>alert(1)</script>')

  // path traversal reads as not found, never as a file read
  const f4 = fileRes()
  await fileEntry.handler(
    { method: 'GET', url: '/jobcv/file?session=s1&name=../../etc/passwd' },
    f4,
  )
  assert.equal(f4.code, 404)

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
      versionHtml: async (sid, version) => (version === 2 ? '<h1>two</h1>' : null),
    },
    skillText: skill,
    sendText: () => {},
  })
  const historyEntry = entryFor(verGroups, '/jobcv/history')
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

  // ?version=N returns that one body, for looking before restoring
  const hv = fakeRes()
  await historyEntry.handler({ method: 'GET', url: '/jobcv/history?session=s1&version=2' }, hv)
  assert.equal(hv.code, 200)
  assert.equal(hv.body.html, '<h1>two</h1>')
  assert.equal(hv.body.version, 2)
  const hMissing = fakeRes()
  await historyEntry.handler(
    { method: 'GET', url: '/jobcv/history?session=s1&version=99' },
    hMissing,
  )
  assert.equal(hMissing.code, 404)
  const hBad = fakeRes()
  await historyEntry.handler({ method: 'GET', url: '/jobcv/history?session=s1&version=abc' }, hBad)
  assert.equal(hBad.code, 400)

  const restoreEntry = entryFor(verGroups, '/jobcv/restore')
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
  const intakeEntry = entryFor(wsGroups, '/jobcv/intake')
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

// ---- the job post is stored, mirrored and readable ----
import { createDocStore } from '../lib/store/doc-store.js'
// The post is what every other file in the candidacy folder is an answer to,
// and it is the one that disappears: postings get pulled and links rot.
{
  const home = await mkdtemp(pathJoin(tmpdir(), 'dsh-job-cv-post-'))
  const store = createDocStore(home)
  const workspace = pathJoin(home, 'acme', 'staff-engineer')
  await mkdir(workspace, { recursive: true })
  await store.setWorkspace('s1', workspace, 'https://jobs.example/42', 'Acme', 'Staff Engineer')

  const groups = defineJobCvRoutes({
    store,
    resolveRoot: () => home,
    intakeRoot: home,
    sendText: () => {},
    skillText: '',
  })
  const post = entryFor(groups, '/jobcv/post')
  const fit = entryFor(groups, '/jobcv/fit')

  const empty = fakeRes()
  await post.handler({ method: 'GET', url: '/jobcv/post?session=s1' }, empty)
  assert.equal(empty.body.text, '', 'no post yet reads as empty, not as an error')

  const saved = fakeRes()
  await post.handler(
    fakeReq('POST', '/jobcv/post', { sessionId: 's1', text: 'We are hiring a Staff Engineer.' }),
    saved,
  )
  assert.equal(saved.code, 200)
  assert.equal(saved.body.chars, 31)

  const read = fakeRes()
  await post.handler({ method: 'GET', url: '/jobcv/post?session=s1' }, read)
  assert.equal(read.body.text, 'We are hiring a Staff Engineer.')
  assert.equal(read.body.jobUrl, 'https://jobs.example/42', 'the post carries its own link back')
  assert.equal(
    await readFile(pathJoin(workspace, 'notes', 'job-post.txt'), 'utf8'),
    'We are hiring a Staff Engineer.',
    'and lands in the candidacy folder, where it outlives the posting',
  )

  const blank = fakeRes()
  await post.handler(fakeReq('POST', '/jobcv/post', { sessionId: 's1', text: '  ' }), blank)
  assert.equal(blank.code, 400, 'an empty post is not a post')

  // A session that ran before this route existed still has one to show: the
  // contract has always told the agent to write notes/job-post.txt.
  const store2 = createDocStore(pathJoin(home, 'other'))
  await store2.setWorkspace('s2', workspace)
  const legacy = fakeRes()
  const groups2 = defineJobCvRoutes({
    store: store2,
    resolveRoot: () => home,
    intakeRoot: home,
    sendText: () => {},
    skillText: '',
  })
  await entryFor(groups2, '/jobcv/post').handler(
    { method: 'GET', url: '/jobcv/post?session=s2' },
    legacy,
  )
  assert.equal(legacy.body.text, 'We are hiring a Staff Engineer.', 'read from the folder')
  assert.equal(legacy.body.source, 'agent')

  // ---- the posting page: the same posting, styled, with the CV's gaps marked ----
  const page = '<html><body><mark class="dsh-gap">2 leading others</mark></body></html>'
  const paged = fakeRes()
  await post.handler(
    fakeReq('POST', '/jobcv/post', { sessionId: 's1', text: 'We are hiring.', html: page }),
    paged,
  )
  assert.equal(paged.code, 200)
  const pagedGet = fakeRes()
  await post.handler({ method: 'GET', url: '/jobcv/post?session=s1' }, pagedGet)
  assert.ok(pagedGet.body.html.includes('dsh-gap'), 'the page rides with the text it renders')
  assert.ok(pagedGet.body.htmlUpdatedAt > 0)
  const pagedDoc = await store.get('s1')
  assert.ok(pagedDoc.postHtmlUpdatedAt > 0, 'the doc carries the page as a marker only')
  assert.equal(
    await readFile(pathJoin(workspace, 'notes', 'job-post.html'), 'utf8'),
    page,
    'and the candidacy folder holds the same page the preview shows',
  )

  // ---- re-storing the same words does not age the posting ----
  // updatedAt is about the TEXT: the brief and the fit score are written
  // against it, and a page-only save (the agent attaching a page it just
  // built, or a hand edit of that page) must not mark them stale for a
  // posting that has not changed a character.
  const beforeEdit = await store.getPost('s1')
  const editedPage = '<html><body><p>Edited by hand</p></body></html>'
  const edited = fakeRes()
  await post.handler(
    fakeReq('POST', '/jobcv/post', {
      sessionId: 's1',
      text: 'We are hiring.',
      html: editedPage,
    }),
    edited,
  )
  assert.equal(edited.code, 200)
  const afterEdit = await store.getPost('s1')
  assert.equal(
    afterEdit.updatedAt,
    beforeEdit.updatedAt,
    'the text did not move, so nor did its clock',
  )
  assert.equal(afterEdit.html, editedPage, 'but the page it renders did')
  assert.ok(afterEdit.htmlUpdatedAt >= beforeEdit.htmlUpdatedAt, 'the page has its own clock')

  const reworded = fakeRes()
  await post.handler(
    fakeReq('POST', '/jobcv/post', { sessionId: 's1', text: 'We are hiring, urgently.' }),
    reworded,
  )
  const afterReword = await store.getPost('s1')
  assert.ok(
    afterReword.updatedAt > beforeEdit.updatedAt,
    'different words ARE a new posting, and everything written against it is now stale',
  )
  // Put the posting back as the rest of this file found it.
  await post.handler(
    fakeReq('POST', '/jobcv/post', { sessionId: 's1', text: 'We are hiring.', html: page }),
    fakeRes(),
  )

  // ---- the fit rides in the document payload, so the poll picks it up ----
  await store.save('s1', { html: '<html>v1</html>' })
  const scored = fakeRes()
  await fit.handler(
    fakeReq('POST', '/jobcv/fit', {
      sessionId: 's1',
      score: 68,
      verdict: 'no evidence of the scope they ask for',
      gaps: [
        { requirement: 'Kubernetes at scale', severity: 'blocker', fix: 'How many clusters?' },
      ],
    }),
    scored,
  )
  assert.equal(scored.code, 200)
  assert.equal(scored.body.score, 68)
  const doc = await store.get('s1')
  assert.equal(doc.fit.score, 68, 'the fit rides in /jobcv/doc — the poll needs no second request')
  assert.equal(doc.postChars, 14, 'the post rides as a MARKER only; the body has its own route')
  assert.ok(doc.postUpdatedAt > 0)

  const bad = fakeRes()
  await fit.handler(fakeReq('POST', '/jobcv/fit', { sessionId: 's1', verdict: 'good' }), bad)
  assert.equal(bad.code, 400, 'a fit with no score is a panel with an empty heading')

  // ---- the brief: the posting broken into what a candidate reads ----
  const briefEntry = entryFor(groups, '/jobcv/brief')
  const briefed = fakeRes()
  await briefEntry.handler(
    fakeReq('POST', '/jobcv/brief', {
      sessionId: 's1',
      sections: [
        {
          title: 'About the company',
          body: 'Acme runs ledgers, since 2009.',
          source: 'company site',
        },
        { title: 'The job', body: 'You own the platform.', source: 'posting' },
      ],
      meta: [
        { label: 'Location', value: 'Berlin (hybrid)' },
        { label: 'Posted', value: '7 days ago' },
      ],
    }),
    briefed,
  )
  assert.equal(briefed.code, 200)
  assert.equal(briefed.body.sections, 2)
  const briefedDoc = await store.get('s1')
  assert.ok(briefedDoc.briefUpdatedAt > 0, 'the doc carries the marker, not the body')
  assert.equal(briefedDoc.brief, undefined, 'the poll payload stays light')

  const briefedGet = fakeRes()
  await briefEntry.handler({ method: 'GET', url: '/jobcv/brief?session=s1' }, briefedGet)
  assert.equal(briefedGet.body.brief.sections[0].source, 'company site')

  const noBrief = fakeRes()
  await briefEntry.handler(
    fakeReq('POST', '/jobcv/brief', { sessionId: 's1', sections: [] }),
    noBrief,
  )
  assert.equal(noBrief.code, 400, 'a brief with nothing in it is not a brief')

  // A save does not clear the score — it dates it. A blank panel would read
  // as "nothing happened"; a stale one says what it is stale against.
  await store.save('s1', { html: '<html>v2</html>' })
  const after = await store.get('s1')
  assert.equal(after.version, 2)
  assert.equal(after.fit.score, 68)
  assert.equal(after.fit.basedOnVersion, 1, 'and still names the version it judged')
  assert.equal(after.postChars, 14, 'the post survives a save too')

  await rm(home, { recursive: true, force: true })
}

// ---- GET /jobcv/stream: the push that replaced the poll ----
// The pane holds this open for the whole session, so what matters is that it
// frames the projection, pushes on every change, and lets go on close: a
// stream that leaks its subscription keeps a dead session's writes alive.
{
  const pushes = []
  let subscriber = null
  let unsubscribed = 0
  const streamStore = {
    get: async () => ({ version: pushes.length + 1 }),
    subscribe(sessionId, fn) {
      assert.equal(sessionId, 's1', 'the stream subscribes to the session it was asked for')
      subscriber = fn
      return function () {
        unsubscribed += 1
        subscriber = null
      }
    },
  }
  const streamEntry = entryFor(
    defineJobCvRoutes({ store: streamStore, skillText: skill, sendText: () => {} }),
    '/jobcv/stream',
  )

  const res = new EventEmitter()
  res.headers = null
  res.ended = false
  res.writeHead = function (code, headers) {
    this.code = code
    this.headers = headers
  }
  res.write = function (chunk) {
    pushes.push(chunk)
  }
  res.end = function () {
    this.ended = true
  }
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = '/jobcv/stream?session=s1'

  await streamEntry.handler(req, res)
  assert.equal(res.code, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream')
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform')
  // The first frame is unconditional: a pane that connects mid-session must
  // not wait for the next save to learn what the document is.
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(pushes.length, 1, 'connecting pushes the current document')
  assert.match(pushes[0], /^data: \{.*\}\n\n$/, 'one SSE data frame, terminated')
  assert.equal(JSON.parse(pushes[0].slice(6)).version, 1)
  assert.ok(subscriber, 'and it is now watching the session')

  // A save reaches the open stream.
  subscriber()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(pushes.length, 2, 'a change pushes a frame')
  assert.equal(JSON.parse(pushes[1].slice(6)).version, 2)

  // The pane goes away: the subscription goes with it, and a late push after
  // the close writes nothing into a socket that is gone.
  const dead = subscriber
  res.emit('close')
  assert.equal(unsubscribed, 1, 'closing unsubscribes')
  assert.ok(res.ended, 'and ends the response')
  dead()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(pushes.length, 2, 'a push after the close writes nothing')
  res.emit('close')
  assert.equal(unsubscribed, 1, 'and a second close is not a second unsubscribe')

  const noSession = fakeRes()
  await streamEntry.handler({ method: 'GET', url: '/jobcv/stream' }, noSession)
  assert.equal(noSession.code, 400, 'a stream needs a session to stream')
}

// ---- GET /jobcv/cvs: the pick list onboarding offers before asking for a file ----
{
  const home = await mkdtemp(pathJoin(tmpdir(), 'dsh-job-cv-recents-'))
  const store = createDocStore(home)
  const acme = pathJoin(home, 'apps', 'acme-corp', '42')
  await store.save('past-1', { html: '<html>acme tailored</html>' })
  await store.setWorkspace(
    'past-1',
    acme,
    'https://jobs.example.com/42',
    'Acme Corp',
    'Senior Engineer',
  )

  const groups = defineJobCvRoutes({
    store,
    resolveRoot: () => home,
    intakeRoot: home,
    sendText: () => {},
    skillText: '',
  })
  const cvs = entryFor(groups, '/jobcv/cvs')
  assert.equal(cvs.method, 'GET', 'the pick list is read-only')

  const miss = fakeRes()
  await cvs.handler({ method: 'GET', url: '/jobcv/cvs' }, miss)
  assert.equal(miss.code, 400, 'a listing needs a session like every other GET')

  const fresh = fakeRes()
  await cvs.handler({ method: 'GET', url: '/jobcv/cvs?session=fresh' }, fresh)
  assert.equal(fresh.code, 200)
  assert.equal(fresh.body.cvs.length, 1)
  assert.equal(fresh.body.cvs[0].path, pathJoin(acme, 'cv', 'latest.html'))
  assert.equal(fresh.body.cvs[0].company, 'Acme Corp')
  assert.equal(fresh.body.master, null, 'no master yet — the form simply hides its pinned row')

  // With a master saved, the listing pins it — mirrored into THIS root first,
  // so the path it hands out exists right now.
  await store.saveMaster('fresh', {
    html: '<html><body><p>the source of truth</p></body></html>',
    note: 'first master',
  })
  const pinned = fakeRes()
  await cvs.handler({ method: 'GET', url: '/jobcv/cvs?session=fresh' }, pinned)
  assert.equal(pinned.body.master.version, 1)
  assert.equal(pinned.body.master.path, pathJoin(home, 'master', 'cv', 'latest.html'))
  assert.equal(
    await readFile(pinned.body.master.path, 'utf8'),
    '<html><body><p>the source of truth</p></body></html>',
  )

  const self = fakeRes()
  await cvs.handler({ method: 'GET', url: '/jobcv/cvs?session=past-1' }, self)
  assert.deepEqual(
    self.body.cvs,
    [],
    'a session is never offered its own record — onboarding is where version 0 lives',
  )

  // the guard in front of the handler enforces the read-only verb
  const guardedCvs = guardHandler(cvs, guardDeps)
  const cvsVerb = fakeRes()
  await guardedCvs(
    { method: 'POST', url: '/jobcv/cvs?session=x', headers: { host: '127.0.0.1:3080' } },
    cvsVerb,
  )
  assert.equal(cvsVerb.code, 405)

  // ---- the master routes: read, save, delta ----
  const masterEntry = entryFor(groups, '/jobcv/master')
  assert.equal(masterEntry.method, undefined, 'the master handler dispatches GET vs POST itself')
  const masterMiss = fakeRes()
  await masterEntry.handler({ method: 'GET', url: '/jobcv/master' }, masterMiss)
  assert.equal(masterMiss.code, 400)

  const masterGet = fakeRes()
  await masterEntry.handler({ method: 'GET', url: '/jobcv/master?session=fresh' }, masterGet)
  assert.equal(masterGet.code, 200)
  assert.equal(masterGet.body.master.version, 1)
  assert.ok(masterGet.body.master.html.includes('source of truth'))
  assert.equal(masterGet.body.path, pathJoin(home, 'master', 'cv', 'latest.html'))

  const masterPost = fakeRes()
  await masterEntry.handler(
    fakeReq('POST', '/jobcv/master', {
      sessionId: 'fresh',
      html: '<html><body><p>master v2</p></body></html>',
      note: 'folded a confirmed number back in',
    }),
    masterPost,
  )
  assert.equal(masterPost.code, 200)
  assert.equal(masterPost.body.version, 2, 'the master versions independently of any candidacy')
  assert.equal(masterPost.body.path, pathJoin(home, 'master', 'cv', 'latest.html'))
  const reread = fakeRes()
  await masterEntry.handler({ method: 'GET', url: '/jobcv/master?session=fresh' }, reread)
  assert.ok(reread.body.master.html.includes('master v2'))

  const masterBad = fakeRes()
  await masterEntry.handler(fakeReq('POST', '/jobcv/master', { sessionId: 'fresh' }), masterBad)
  assert.equal(masterBad.code, 400)

  const deltaEntry = entryFor(groups, '/jobcv/delta')
  assert.equal(deltaEntry.method, 'GET', 'the diff is computed by the host and read-only')
  const deltaMiss = fakeRes()
  await deltaEntry.handler({ method: 'GET', url: '/jobcv/delta' }, deltaMiss)
  assert.equal(deltaMiss.code, 400)
  const deltaCall = fakeRes()
  await deltaEntry.handler({ method: 'GET', url: '/jobcv/delta?session=fresh' }, deltaCall)
  assert.equal(deltaCall.code, 200)
  assert.equal(deltaCall.body.masterVersion, 2)
  // the session's own tailored CV (saved above through /jobcv/cvs setup) is
  // what the delta compares against
  assert.equal(deltaCall.body.kind, 'cv')

  // restoring an earlier master rides the restore route's kind dispatch
  const restoreEntry = entryFor(groups, '/jobcv/restore')
  const restoreMaster = fakeRes()
  await restoreEntry.handler(
    fakeReq('POST', '/jobcv/restore', { sessionId: 'fresh', version: 1, kind: 'master' }),
    restoreMaster,
  )
  assert.equal(restoreMaster.code, 200)
  assert.equal(restoreMaster.body.kind, 'master')
  assert.equal(restoreMaster.body.version, 3, 'a restore saves forward, never destructively')

  await rm(home, { recursive: true, force: true })
}

console.log('ok  routes + skill contract')
