import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import {
  parseJobList,
  readJobListFile,
  normalizeUrl,
  urlMatchKey,
  titleFromUrl,
  MAX_JOBS,
} from '../lib/store/joblist.js'
import { createDocStore, sanitizeSessionId } from '../lib/store/doc-store.js'
import { defineJobCvRoutes } from '../lib/routes/routes.js'

// ---- the markdown parser: forgiving about shape, strict about links ----

{
  const md = [
    '# Job hunt — autumn',
    '',
    '## Acme Corp',
    '- [Senior Engineer, Trading](https://jobs.acme.com/3812345678)',
    '* Platform Engineer',
    '  https://jobs.acme.com/roles/999-platform-engineer',
    '',
    '## Globex',
    '- **Globex Labs** — [Quant Dev](https://boards.greenhouse.io/globex/jobs/777)',
    '',
    'Some prose paragraph that mentions https://example.com/in-passing inside a sentence.',
    '<https://infernus.jobs/888>',
    '- [Duplicate](https://jobs.acme.com/3812345678)',
    '- mailto:not-a-job@example.com is skipped, so is [relative](/jobs/1)',
    '- [Untitled](https://hooli.com/careers/senior-backend-engineer-nyc/)',
    '- [](https://infernus.io/roles/data-platform-lead)',
  ].join('\n')
  const { jobs, count } = parseJobList(md)

  assert.equal(count, jobs.length)
  assert.equal(jobs.length, 6, 'dedupe by URL; non-http links and prose are not jobs')

  const acme = jobs[0]
  assert.equal(acme.company, 'Acme Corp', 'a heading names the company below it')
  assert.equal(acme.title, 'Senior Engineer, Trading')
  assert.equal(
    jobs[1].title,
    'Platform Engineer',
    'the URL on its own line pairs with the line above',
  )
  assert.equal(normalizeUrl(jobs[1].url), 'https://jobs.acme.com/roles/999-platform-engineer')
  const globex = jobs[2]
  assert.equal(globex.company, 'Globex Labs', 'a prefix before the link beats the heading')
  // The prose line carries a URL and sentence punctuation, so it must NOT
  // become the title of the autolink on the next line.
  assert.equal(jobs[3].title, '888', 'prose never becomes a job title; the URL derives one')
  assert.equal(
    jobs[4].title,
    'Untitled',
    'a non-empty link text is kept as written, even when unhelpful',
  )
  assert.equal(
    jobs[5].title,
    'data platform lead',
    'an empty link text falls back to a title read out of the URL',
  )
}

{
  // A title on its own line followed by a bare URL on the next.
  const md = ['- Senior Backend Engineer', '  <https://jobs.example.com/roles/backend-lead>'].join(
    '\n',
  )
  const { jobs } = parseJobList(md)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].title, 'Senior Backend Engineer')
  assert.equal(jobs[0].company, '')
}

{
  // The cap holds, and a file of nothing yields nothing (the route turns
  // that into a readable error).
  const many = Array.from({ length: MAX_JOBS + 30 }, (_, i) => `- [J${i}](https://x.io/${i})`).join(
    '\n',
  )
  assert.equal(parseJobList(many).count, MAX_JOBS)
  assert.deepEqual(parseJobList('no links here at all').jobs, [])
}

assert.equal(
  titleFromUrl('https://boards.io/g/role/senior-platform-engineer'),
  'senior platform engineer',
)
assert.equal(
  normalizeUrl('https://x.io/1/#section/'),
  'https://x.io/1',
  'hash and trailing slash are noise',
)
assert.equal(
  normalizeUrl(
    'https://www.linkedin.com/jobs/view/3876543210/?trk=job_search_share&li_fat_id=xyz&origin=JOBS',
  ),
  'https://www.linkedin.com/jobs/view/3876543210',
  'LinkedIn tracking dust never forks a posting',
)
assert.equal(
  normalizeUrl('http://Jobs.Acme.com:80/roles/9?utm_source=rss&gh_jid=42'),
  'https://jobs.acme.com/roles/9?gh_jid=42',
  'scheme/host fold away; functional params like gh_jid survive',
)
assert.equal(
  normalizeUrl('https://x.io/a?b=1&utm_campaign=x'),
  'https://x.io/a?b=1',
  'only tracking params drop',
)
assert.equal(normalizeUrl('not a url'), 'not a url', 'unparseable input degrades to the regex path')
assert.equal(
  normalizeUrl('HTTPS://X.IO/1'),
  'https://x.io/1',
  'path case is kept, host case is not',
)

// Two grades of strictness: storage stays faithful (a link must still
// fetch), matching stays generous (?ref= never decides identity).
const ashy = 'https://jobs.ashbyhq.com/acme/b1c2d3e4?ref=partner-network'
assert.equal(normalizeUrl(ashy), ashy, '?ref= survives in the stored link — Ashby routes on it')
assert.equal(
  urlMatchKey(ashy),
  'https://jobs.ashbyhq.com/acme/b1c2d3e4',
  'but it never forks identity',
)
assert.notEqual(
  urlMatchKey('https://x.io/a?z=1'),
  urlMatchKey('https://x.io/b'),
  'real path differences stay distinct',
)

await assert.rejects(readJobListFile('', '/tmp'), /no markdown path given/)
await assert.rejects(readJobListFile('/definitely/not/here.md', '/tmp'), /file not found/)

// ---- the store: switching archives the outgoing candidacy whole ----
const tmp = await mkdtemp(join(tmpdir(), 'jobcv-jobs-'))
try {
  const wsA = join(tmp, 'apps', 'acme', '123')
  const wsB = join(tmp, 'apps', 'globex', '777')
  await mkdir(wsA, { recursive: true })
  await mkdir(wsB, { recursive: true })
  const store = createDocStore(join(tmp, 'home', 'dsh-job-cv'))
  const SID = 'sess-multi'
  assert.equal(sanitizeSessionId(SID), SID)

  // Job A: workspace open, one tailored version saved.
  await store.setWorkspace(SID, wsA, 'https://jobs.acme.com/123', 'Acme Corp', 'Senior Engineer')
  await store.save(SID, { html: '<p>A v1</p>', note: 'first tailor' })

  // Switch to job B: A is parked with its history; B starts fresh but named.
  let result = await store.switchCandidacy(SID, {
    jobUrl: 'https://globex.com/777',
    company: 'Globex',
    jobTitle: 'Quant Dev',
  })
  assert.equal(result.resumed, false, 'B was never worked on in this session')
  assert.equal(result.version, 0)
  let active = await store.get(SID)
  assert.equal(active.jobUrl, 'https://globex.com/777')
  assert.equal(active.company, 'Globex')
  assert.equal(active.workspace, '', 'the fresh candidacy has no folder yet')

  // Work on B for a while.
  await store.setWorkspace(SID, wsB, 'https://globex.com/777', 'Globex Labs', 'Quant Dev')
  await store.save(SID, { html: '<p>B v1</p>', note: 'b first' })
  await store.save(SID, { html: '<p>B v2</p>', note: 'quantified the bullets' })

  // The roster: B active at v2, A archived at v1.
  let rows = await store.listCandidacies(SID)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].active, true)
  assert.equal(rows[0].version, 2)
  assert.equal(rows[0].jobUrl, 'https://globex.com/777')
  assert.equal(rows[1].active, false)
  assert.equal(rows[1].version, 1, 'A kept its version line through the switch')
  assert.equal(rows[1].workspace, wsA)

  // Switching back resumes exactly where A left off.
  result = await store.switchCandidacy(SID, { jobUrl: 'https://jobs.acme.com/123' })
  assert.equal(result.resumed, true, 'A came back with its work')
  assert.equal(result.version, 1)
  active = await store.get(SID)
  assert.equal(active.html, '<p>A v1</p>')
  assert.equal(active.version, 1)
  assert.equal(active.historyDepth, 0, 'A only ever had one save, so no PRIOR versions exist')

  // Switching to the ACTIVE posting is a no-op that archives nothing new.
  rows = await store.listCandidacies(SID)
  assert.equal(rows.length, 2, 'promoting the archive removed it: one row per candidacy')
  result = await store.switchCandidacy(SID, { jobUrl: 'https://jobs.acme.com/123' })
  assert.equal(result.resumed, true)
  assert.equal((await store.listCandidacies(SID)).length, rows.length)

  // The SAME posting spelled differently is the SAME candidacy: trailing
  // slash and #fragment are noise, the stored link normalizes, and nothing
  // forks into a second archive that would share (and clobber) wsA's folder.
  result = await store.switchCandidacy(SID, { jobUrl: 'https://jobs.acme.com/123/' })
  assert.equal(result.resumed, true, 'trailing slash does not fork a fresh candidacy')
  result = await store.switchCandidacy(SID, { jobUrl: 'https://jobs.acme.com/123#apply' })
  assert.equal(result.resumed, true, 'a fragment does not either')
  active = await store.get(SID)
  assert.equal(active.jobUrl, 'https://jobs.acme.com/123', 'the stored link is normalized')
  assert.equal((await store.listCandidacies(SID)).length, rows.length)

  // Tracking dust is noise too: the same LinkedIn posting pasted from
  // search, then from a share, stays ONE candidacy.
  result = await store.switchCandidacy(SID, {
    jobUrl: 'https://jobs.acme.com/123?trk=public_search&li_fat_id=abc',
  })
  assert.equal(result.resumed, true, 'tracking params do not fork a fresh candidacy')

  // ?ref= is sometimes functional (Ashby routes on it), so it must never
  // decide identity either — but the STORED link stays the clean spelling.
  result = await store.switchCandidacy(SID, { jobUrl: 'https://jobs.acme.com/123?ref=rss' })
  assert.equal(result.resumed, true)
  active = await store.get(SID)
  assert.equal(
    active.jobUrl,
    'https://jobs.acme.com/123',
    'the stored link keeps its fetchable form',
  )

  // An empty active record (still sitting on the start form) archives nothing.
  const fresh = createDocStore(join(tmp, 'home2', 'dsh-job-cv'))
  await fresh.switchCandidacy('sess-empty', { jobUrl: 'https://one.io/1' })
  const emptyRows = await fresh.listCandidacies('sess-empty')
  assert.equal(emptyRows.length, 1, 'nothing was parked, because nothing was there')
  assert.equal(emptyRows[0].started, false)

  // A missing jobUrl is rejected rather than silently switching nowhere.
  await assert.rejects(store.switchCandidacy(SID, {}), /jobUrl/)

  // ---- the listings see archived candidacies as applications like any other
  const apps = await store.listApplications()
  const appWorkspaces = apps.map((r) => r.workspace).sort()
  assert.ok(appWorkspaces.includes(wsA), 'archived A lists in the tracker')
  assert.ok(appWorkspaces.includes(wsB), 'active B lists in the tracker')

  // Onboarding pick list: the asking session's ACTIVE record stays hidden,
  // its archives do not.
  const ownCvs = await store.listRecentCvs(SID)
  assert.ok(!ownCvs.some((c) => c.workspace === wsA), 'the active application is not offered back')
  assert.ok(
    ownCvs.some((c) => c.workspace === wsB),
    'its archived sibling is',
  )
  const otherCvs = await store.listRecentCvs('someone-else')
  assert.ok(otherCvs.some((c) => c.workspace === wsA))
  assert.ok(otherCvs.some((c) => c.workspace === wsB))

  // ---- a status tag names its job: retagging an inactive row cannot move
  // the active one.
  await store.setApplication(SID, {
    status: 'applied',
    note: 'sent Tuesday',
    jobUrl: 'https://globex.com/777',
  })
  rows = await store.listCandidacies(SID)
  assert.equal(rows[0].status, '', 'A (active) was not touched')
  assert.equal(rows[1].status, 'applied', 'B (archived) took the tag')
  await assert.rejects(
    store.setApplication(SID, { status: 'applied', jobUrl: 'https://never-opened.io/1' }),
    /not worked on in this session/,
  )
  await assert.rejects(
    store.setApplication(SID, { status: 'invented' }),
    /unknown application status/,
  )

  // ---- the pick-list sidecar round-trips, filters, and degrades ----
  await store.setJobList(SID, {
    path: '/notes/jobs.md',
    cvPath: '/cv.pdf',
    jobs: [
      { title: 'T1', company: 'C1', url: 'https://a.io/1#frag/' },
      { url: 'ftp://not-a-web-link' },
      { title: 'Dup', url: 'https://a.io/1' },
      { title: 'T2', url: 'https://b.io/2' },
    ],
  })
  const list = await store.getJobList(SID)
  assert.equal(list.path, '/notes/jobs.md')
  assert.equal(list.cvPath, '/cv.pdf')
  assert.equal(list.jobs.length, 2, 'non-http entries drop and duplicates collapse')
  assert.equal(list.jobs[0].url, 'https://a.io/1#frag/', 'the FIRST spelling of a URL wins')
  assert.equal(list.jobs[1].title, 'T2')

  await mkdir(join(tmp, 'home', 'dsh-job-cv', 'sessions', 'lists'), { recursive: true })
  await writeFile(
    join(tmp, 'home', 'dsh-job-cv', 'sessions', 'lists', 'sess-broken.json'),
    '{oops',
    'utf8',
  )
  const broken = await store.getJobList('sess-broken')
  assert.deepEqual(broken.jobs, [], 'a corrupt sidecar degrades instead of raising')
} finally {
  await rm(tmp, { recursive: true, force: true })
}

// ---- the routes, end to end over a real store ----
{
  const fakeRes = () => ({
    code: 0,
    body: null,
    writeHead(c) {
      this.code = c
    },
    end(b) {
      if (b) this.body = JSON.parse(b)
    },
  })
  const { EventEmitter } = await import('node:events')
  const fakeReq = (method, url, body) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = { 'content-type': 'application/json' }
    process.nextTick(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
    return req
  }

  const tmp2 = await mkdtemp(join(tmpdir(), 'jobcv-jobs-routes-'))
  try {
    const store = createDocStore(join(tmp2, 'store'))
    const groups = defineJobCvRoutes({
      store,
      resolveRoot: () => tmp2,
      intakeRoot: join(tmp2, 'intake'),
      skillText: 'skill',
      sendText: (res, code, text) => {
        res.code = code
        res.body = text
      },
    })
    function entryFor(path) {
      for (const group of groups) {
        for (const entry of group.entries) if (entry.path === path) return entry
      }
      throw new Error('no route declared for ' + path)
    }

    // POST parses text, stashes the pick list; GET hands it back.
    const post1 = fakeRes()
    await entryFor('/jobcv/joblist').handler(
      fakeReq('POST', '/jobcv/joblist', {
        sessionId: 's9',
        text: '## Acme\n- [Eng](https://a.io/1)\n- [Ops](https://a.io/2)',
        cvPath: '/cv.pdf',
      }),
      post1,
    )
    assert.equal(post1.code, 200)
    assert.equal(post1.body.count, 2)
    const got = fakeRes()
    await entryFor('/jobcv/joblist').handler(
      { method: 'GET', url: '/jobcv/joblist?session=s9' },
      got,
    )
    assert.equal(got.code, 200)
    assert.equal(got.body.count, 2)
    assert.equal(got.body.cvPath, '/cv.pdf')

    // No usable links is a readable error, not a silent empty list.
    const post2 = fakeRes()
    await entryFor('/jobcv/joblist').handler(
      fakeReq('POST', '/jobcv/joblist', { sessionId: 's9', text: 'just words' }),
      post2,
    )
    assert.equal(post2.code, 400)
    assert.match(post2.body.error, /no job links found/)
    const post3 = fakeRes()
    await entryFor('/jobcv/joblist').handler(
      fakeReq('POST', '/jobcv/joblist', { sessionId: 's9', path: '/definitely/not/here.md' }),
      post3,
    )
    assert.equal(post3.code, 400)
    assert.match(post3.body.error, /file not found/)

    // Switch makes the picked posting active; the roster says so.
    const sw = fakeRes()
    await entryFor('/jobcv/switch').handler(
      fakeReq('POST', '/jobcv/switch', {
        sessionId: 's9',
        jobUrl: 'https://a.io/2',
        company: 'Acme',
      }),
      sw,
    )
    assert.equal(sw.code, 200)
    assert.equal(sw.body.resumed, false)
    assert.equal(sw.body.jobUrl, 'https://a.io/2')
    const rost = fakeRes()
    await entryFor('/jobcv/candidacies').handler(
      { method: 'GET', url: '/jobcv/candidacies?session=s9' },
      rost,
    )
    assert.equal(rost.code, 200)
    assert.equal(rost.body.active.jobUrl, 'https://a.io/2')
    assert.equal(rost.body.candidacies.length, 1)

    // A save that NAMES its posting is refused when that is no longer the
    // active one — the mid-turn-switch guard. The user clicked Resume while
    // the agent was working; without this the CV lands on the wrong job.
    const save1 = fakeRes()
    await entryFor('/jobcv/doc').handler(
      fakeReq('POST', '/jobcv/doc', {
        sessionId: 's9',
        html: '<p>v1</p>',
        jobUrl: 'https://a.io/2',
      }),
      save1,
    )
    assert.equal(save1.code, 200)
    const stale = fakeRes()
    await entryFor('/jobcv/doc').handler(
      fakeReq('POST', '/jobcv/doc', {
        sessionId: 's9',
        html: '<p>written for a different job</p>',
        jobUrl: 'https://a.io/9',
      }),
      stale,
    )
    assert.equal(stale.code, 409, 'a save for another posting is refused, not misfiled')
    assert.match(stale.body.error, /stale save/)
    // The same posting spelled differently is still the active one.
    const variant = fakeRes()
    await entryFor('/jobcv/doc').handler(
      fakeReq('POST', '/jobcv/doc', {
        sessionId: 's9',
        html: '<p>v2</p>',
        jobUrl: 'https://a.io/2/',
      }),
      variant,
    )
    assert.equal(variant.code, 200)
    assert.equal(variant.body.version, 2)
    // Dust the agent cannot control — a ?ref= an ATS tacked on, utm from a
    // share button — never makes a save look like it belongs elsewhere.
    const dusty = fakeRes()
    await entryFor('/jobcv/doc').handler(
      fakeReq('POST', '/jobcv/doc', {
        sessionId: 's9',
        html: '<p>v3</p>',
        jobUrl: 'https://a.io/2?ref=newsletter&utm_source=rss',
      }),
      dusty,
    )
    assert.equal(dusty.code, 200, 'match-form comparison tolerates paste dust')
    // The letter carries the same guard.
    const staleLetter = fakeRes()
    await entryFor('/jobcv/letter').handler(
      fakeReq('POST', '/jobcv/letter', {
        sessionId: 's9',
        html: '<p>L</p>',
        jobUrl: 'https://x.io/0',
      }),
      staleLetter,
    )
    assert.equal(staleLetter.code, 409)

    // Missing pieces fail loudly.
    const sw2 = fakeRes()
    await entryFor('/jobcv/switch').handler(
      fakeReq('POST', '/jobcv/switch', { sessionId: 's9' }),
      sw2,
    )
    assert.equal(sw2.code, 400)
    const bad = fakeRes()
    await entryFor('/jobcv/joblist').handler({ method: 'GET', url: '/jobcv/joblist' }, bad)
    assert.equal(bad.code, 400)
  } finally {
    await rm(tmp2, { recursive: true, force: true })
  }
}

// ---- the browser helpers behind the panel (loaded like the shell loads them) ----
{
  const require = createRequire(import.meta.url)
  let spec = null
  globalThis.window = globalThis.window || { __ModuleLoader__: { load: (s) => (spec = s) } }
  if (!globalThis.document) globalThis.document = { body: null }
  new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
  const mod = spec.factory((n) => (n === 'react' ? require('react') : { createPortal: () => null }))
  const J = mod.__jobs

  assert.equal(J.normJobUrl(' https://x.io/1/#sec '), 'https://x.io/1')
  assert.equal(
    J.normJobUrl('https://X.io/1/'),
    'https://x.io/1',
    'host case is meaningless on the wire and folds away',
  )

  const candidacies = [
    { key: 'k1', started: true, active: true, jobUrl: 'https://a.io/1' },
    { key: 'k2', started: true, active: false, jobUrl: 'https://b.io/2' },
  ]
  assert.equal(J.jobsRowState({ url: 'https://a.io/1/#x' }, candidacies), 'active')
  assert.equal(J.jobsRowState({ url: 'https://b.io/2/' }, candidacies), 'resume')
  assert.equal(J.jobsRowState({ url: 'https://c.io/3' }, candidacies), 'start')
  assert.equal(J.findCandidacyFor(candidacies, 'https://missing.io/9'), null)

  assert.equal(J.jobRowLabel({ title: 'Engineer' }), 'Engineer')
  assert.ok(
    J.jobRowLabel({ url: 'https://hooli.com/careers/senior-backend-engineer-nyc/' }).length > 0,
  )
  assert.equal(J.shortUrl('https://x.io/' + 'a'.repeat(100), 20).endsWith('…'), true)

  const msg = J.buildJobsStartMessage(
    { url: 'https://a.io/1', company: 'Acme', title: 'Eng' },
    '/cv.pdf',
    '/notes/jobs.md',
    'session-abc',
  )
  assert.ok(msg.includes('Job post link: https://a.io/1'))
  assert.ok(msg.includes('My CV: /cv.pdf'))
  assert.ok(msg.includes('Company: Acme'))
  assert.ok(msg.includes('Session id: session-abc'))
  assert.ok(msg.includes('already switched'), 'the message stops the agent switching again')
  assert.ok(msg.includes('/jobcv/doc'), 'and points at the usual save route')
  assert.ok(
    msg.includes('created:false'),
    'a posting already tailored in ANOTHER session is resumed, not rewritten',
  )

  const cleaned = J.usableJobList({
    path: '/j.md',
    cvPath: '/c',
    updatedAt: 5,
    jobs: [null, { url: '' }, { url: 'https://ok.io/1', title: 'T' }],
  })
  assert.equal(cleaned.jobs.length, 1)
  assert.equal(cleaned.path, '/j.md')

  // The client's URL comparison must agree with the host's MATCHING form on
  // every spelling a paste can produce — the panel matches list lines
  // against stored candidacies, and a disagreement would show Start where
  // Resume belongs. (Storage keeps ?ref=; matching drops it — urlMatchKey.)
  const fixtures = [
    'https://x.io/1/#section/',
    'https://www.linkedin.com/jobs/view/3876543210/?trk=job_search_share&li_fat_id=xyz&origin=JOBS',
    'http://Jobs.Acme.com:80/roles/9?utm_source=rss&gh_jid=42',
    'HTTPS://X.IO/1',
    'not a url',
    '',
    'https://x.io/a?b=1&utm_campaign=x',
    'https://jobs.ashbyhq.com/acme/b1c2d3e4?ref=partner-network',
    'https://jobs.ashbyhq.com/acme/b1c2d3e4',
  ]
  for (const fixture of fixtures) {
    assert.equal(
      J.normJobUrl(fixture),
      urlMatchKey(fixture),
      'client/host agree on: ' + JSON.stringify(fixture),
    )
  }
}

console.log('ok  jobs list: markdown parsing, per-job switching, archives, routes')
