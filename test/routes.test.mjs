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
  '/jobcv/brief',
  '/jobcv/doc',
  '/jobcv/fit',
  '/jobcv/history',
  '/jobcv/intake',
  '/jobcv/letter',
  '/jobcv/post',
  '/jobcv/proposal',
  '/jobcv/proposal/decision',
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
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
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

console.log('ok  routes + skill contract')

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
