import { strict as assert } from 'node:assert'
import { createDocStore } from '../lib/store/doc-store.js'
import {
  normalizeApplication,
  applyStatusChange,
  isValidStatus,
  readApplicationStatus,
  writeApplicationStatus,
  newerApplication,
  APPLICATION_STATUSES,
} from '../lib/store/applications.js'
import { defineJobCvRoutes } from '../lib/routes/routes.js'
import { guardHandler } from '../lib/routes/mount.js'
import { isTrustedRequest, readJsonBody, sendJson } from '../lib/http/http-utils.js'
import { skillInstructions } from '../lib/preset/preset-seed.js'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

// ---- the status model itself ----
{
  // Five tags, and nothing else: an agent POSTing "hired" must fail closed.
  assert.deepEqual(APPLICATION_STATUSES, ['drafting', 'applied', 'interview', 'offer', 'rejected'])
  assert.equal(isValidStatus('applied'), true)
  assert.equal(isValidStatus('hired'), false)
  assert.equal(isValidStatus(''), false)
  assert.equal(isValidStatus(undefined), false)

  // A hand-written or half-written status file degrades to null instead of
  // throwing out of every listing that touches its folder.
  assert.equal(normalizeApplication(null), null)
  assert.equal(normalizeApplication('applied'), null)
  assert.equal(normalizeApplication({}), null, 'no status, nothing to keep')
  assert.equal(normalizeApplication({ status: 'hired' }), null, 'unknown tags carry nothing')
  assert.equal(normalizeApplication({ status: 'drafting' }), null, 'no tag IS drafting')
  const clean = normalizeApplication({
    status: 'rejected',
    statusUpdatedAt: 50,
    note: 'x'.repeat(500),
    log: [{ status: 'nonsense', at: 1 }, { status: 'applied', at: 2 }, 'junk', null],
  })
  assert.equal(clean.status, 'rejected')
  assert.equal(clean.note.length, 200, 'a note is a label, not an essay')
  assert.deepEqual(
    clean.log.map((e) => e.status),
    ['applied'],
    'log entries with unknown tags do not survive',
  )

  // Landing straight on interview stamps the applied date anyway — referrals
  // skip the form, but the day they applied still happened.
  const jumped = applyStatusChange(null, { status: 'interview' }, 500)
  assert.equal(jumped.appliedAt, 500)

  // Moving forward never moves the day they applied.
  const first = applyStatusChange(null, { status: 'applied', note: 'on the site' }, 1000)
  const moved = applyStatusChange(first, { status: 'interview', note: 'Fri 14:00' }, 2000)
  assert.equal(moved.appliedAt, 1000, 'the applied stamp survives the move')
  assert.equal(moved.log.length, 2)
  assert.equal(moved.log[0].status, 'interview', 'the log is newest first')

  // An identical decision is a no-op: same object out, nothing bumped.
  const again = applyStatusChange(moved, { status: 'interview', note: 'Fri 14:00' }, 3000)
  assert.equal(again, moved, 'a no-op must not grow the log or move timestamps')

  // Rejected after an offer keeps the applied stamp too.
  const end = applyStatusChange(moved, { status: 'rejected' }, 4000)
  assert.equal(end.appliedAt, 1000)
  assert.equal(end.log.length, 3)

  // Invalid decisions are refused, never half-applied.
  assert.equal(applyStatusChange(first, { status: 'hired' }, 5000), null)

  // newerApplication: the tiny merge rule the listing leans on, pinned
  // directly — the newer write wins; two undated states fall back to a.
  assert.equal(newerApplication(null, null), null)
  const stampA = { statusUpdatedAt: 10 }
  const stampB = { statusUpdatedAt: 20 }
  assert.equal(newerApplication(stampA, stampB), stampB)
  assert.equal(newerApplication(stampB, stampA), stampB)
  assert.equal(newerApplication(stampA, null), stampA)
  console.log('ok  applications: status model')
}

// ---- the store: writing tags, mirroring them, listing applications ----
{
  const dir = await mkdtemp(join(tmpdir(), 'jobcv-tracker-'))
  const wsAcme = join(dir, 'apps', 'acme-corp', '42')
  const wsGlobex = join(dir, 'apps', 'globex', '9')
  const store = createDocStore(join(dir, 'store'))

  // Two sessions open the acme candidacy: the older one wrote the letter,
  // the newer one the CV. One row, both documents.
  await store.save('acme-old', { html: '<html>acme cv</html>' })
  await store.setWorkspace(
    'acme-old',
    wsAcme,
    'https://jobs.example.com/42',
    'Acme Corp',
    'Engineer',
  )
  await store.saveLetter('acme-old', { html: '<html>letter</html>', note: 'first letter' })
  await new Promise((r) => setTimeout(r, 8))
  await store.save('acme-new', { html: '<html>acme cv v2</html>', note: 'tailored' })
  await store.save('acme-new', { html: '<html>acme cv v3</html>', note: 'tightened' })
  await store.setWorkspace('acme-new', wsAcme, undefined, undefined, 'Senior Engineer')

  // A second application, and a draft that never opened a folder.
  await store.save('globex-s', { html: '<html>globex</html>' })
  await store.setWorkspace('globex-s', wsGlobex, undefined, 'Globex', '')
  await store.save('draft-s', { html: '<html>a draft with no folder</html>' })

  let rows = await store.listApplications()
  assert.equal(rows.length, 3, 'one row per candidacy plus the folder-less draft')
  assert.equal(rows[0].sessionId, 'draft-s', 'newest activity first')
  const acmeRow = rows.find((r) => r.workspace === wsAcme)
  assert.ok(acmeRow, 'the acme candidacy is listed')
  assert.equal(
    acmeRow.cvVersion,
    2,
    'the newest CV version across sessions (v2 there, v1 in the older session)',
  )
  assert.equal(acmeRow.cvNote, 'tightened', 'with the note that version was saved under')
  assert.equal(acmeRow.sessionId, 'acme-new', 'the row belongs to the latest session')
  assert.equal(acmeRow.jobTitle, 'Senior Engineer', 'the newer metadata wins')
  assert.equal(acmeRow.letterVersion, 1, 'the letter the older session wrote is not lost')
  assert.equal(acmeRow.company, 'Acme Corp')
  assert.equal(acmeRow.application, null, 'nothing tagged yet reads as untagged')

  // Records that must never be listed: broken files and never-used sessions.
  await writeFile(join(dir, 'store', 'sessions', 'broken.json'), '{ truncated', 'utf8')
  await writeFile(
    join(dir, 'store', 'sessions', 'empty.json'),
    JSON.stringify({ version: 0, html: '', workspace: '' }),
    'utf8',
  )
  rows = await store.listApplications()
  assert.ok(!rows.some((r) => r.sessionId === 'broken'))
  assert.ok(!rows.some((r) => r.sessionId === 'empty'))

  // Tagging writes the record AND mirrors status.json into the folder.
  const tagged = await store.setApplication('acme-new', {
    status: 'applied',
    note: 'via careers portal',
  })
  assert.equal(tagged.status, 'applied')
  assert.ok(tagged.appliedAt > 0, 'moving to applied stamps the date')
  const mirrored = JSON.parse(await readFile(join(wsAcme, 'status.json'), 'utf8'))
  assert.equal(mirrored.status, 'applied', 'the folder carries the same tag')
  assert.equal(mirrored.appliedAt, tagged.appliedAt)

  // The projection carries the markers the dock paints ('' = drafting).
  const proj = await store.get('acme-new')
  assert.equal(proj.status, 'applied')
  assert.equal(proj.appliedAt, tagged.appliedAt)
  assert.equal((await store.get('globex-s')).status, '')

  // A no-op (same status, same note) bumps nothing.
  const before = (await store.get('acme-new')).statusUpdatedAt
  await new Promise((r) => setTimeout(r, 12))
  const noop = await store.setApplication('acme-new', {
    status: 'applied',
    note: 'via careers portal',
  })
  assert.equal(noop.statusUpdatedAt, before, 'an unchanged tag does not move its timestamp')

  // Interview keeps the applied stamp; the log remembers the path.
  await new Promise((r) => setTimeout(r, 12))
  await store.setApplication('acme-new', { status: 'interview', note: 'panel Thu' })
  const advanced = await store.get('acme-new')
  assert.equal(advanced.appliedAt, tagged.appliedAt, 'applied date survives the move')
  const logMirror = JSON.parse(await readFile(join(wsAcme, 'status.json'), 'utf8'))
  assert.deepEqual(
    logMirror.log.map((e) => e.status),
    ['interview', 'applied'],
    'the mirrored log is newest first',
  )

  // Back to drafting clears the tag entirely — no tag IS drafting.
  await store.setApplication('acme-new', { status: 'drafting' })
  assert.equal((await store.get('acme-new')).status, '')
  assert.equal(await readApplicationStatus(wsAcme), null, 'the mirror agrees')
  await store.setApplication('acme-new', { status: 'interview' }) // leave it somewhere real

  // ...but an OLDER folder copy must not overwrite a newer record.
  await new Promise((r) => setTimeout(r, 12))
  await store.setApplication('globex-s', { status: 'rejected', note: 'form email' })
  await new Promise((r) => setTimeout(r, 12))
  await writeApplicationStatus(wsGlobex, {
    status: 'applied',
    statusUpdatedAt: 1,
    appliedAt: 0,
    note: '',
    log: [],
  })
  rows = await store.listApplications()
  assert.equal(
    rows.find((r) => r.workspace === wsGlobex).application.status,
    'rejected',
    'a stale folder copy loses to the record',
  )
  assert.equal(
    rows.findIndex((r) => r.workspace === wsGlobex),
    0,
    'a status change is activity: the row rises',
  )

  // Unreadable status files degrade to "no folder opinion".
  await writeFile(join(wsGlobex, 'status.json'), '{ oops', 'utf8')
  rows = await store.listApplications()
  assert.equal(
    rows.find((r) => r.workspace === wsGlobex).application.status,
    'rejected',
    'a broken mirror loses to the record',
  )

  // The FOLDER can also be NEWER than any record (a hand edit, another
  // machine): then the folder wins — and because a tag set anywhere is
  // activity, that row rises to the top with it.
  const future = {
    status: 'offer',
    statusUpdatedAt: Date.now() + 60 * 60 * 1000,
    appliedAt: tagged.appliedAt,
    note: 'signed?',
    log: [],
  }
  await writeApplicationStatus(wsAcme, future)
  rows = await store.listApplications()
  const acmeAgain = rows.find((r) => r.workspace === wsAcme)
  assert.equal(acmeAgain.application.status, 'offer', 'a newer folder tag beats the record')
  assert.equal(acmeAgain.application.note, 'signed?')
  assert.equal(
    rows.findIndex((r) => r.workspace === wsAcme),
    0,
    'the row rises with the tag that moved last',
  )

  await rm(dir, { recursive: true, force: true })
  console.log('ok  applications: store')
}

// ---- the HTTP surface: GET /jobcv/applications, POST /jobcv/status ----
{
  const dir = await mkdtemp(join(tmpdir(), 'jobcv-tracker-routes-'))
  const ws = join(dir, 'apps', 'acme', '1')
  const store = createDocStore(join(dir, 'store'))
  await store.save('s1', { html: '<html>x</html>' })
  await store.setWorkspace('s1', ws, 'https://jobs.example.com/1', 'Acme', '')

  function fakeRes() {
    return {
      code: 0,
      body: null,
      writeHead(c) {
        this.code = c
      },
      end(b) {
        this.body = b === undefined ? null : JSON.parse(b)
      },
    }
  }
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

  const groups = defineJobCvRoutes({
    store: store,
    resolveRoot: () => join(dir, 'apps'),
    intakeRoot: join(dir, 'intake'),
    skillText: skillInstructions(),
    sendText: () => {},
  })
  function entryFor(path) {
    for (const group of groups) {
      for (const entry of group.entries) if (entry.path === path) return entry
    }
    throw new Error('no route declared for ' + path)
  }

  // GET: the listing plus the counts header the panel shows.
  const g1 = fakeRes()
  await entryFor('/jobcv/applications').handler(
    { method: 'GET', url: '/jobcv/applications?session=s1' },
    g1,
  )
  assert.equal(g1.code, 200)
  assert.equal(g1.body.applications.length, 1)
  assert.equal(g1.body.counts.drafting, 1, 'untagged rows count as drafting')
  assert.equal(g1.body.counts.applied, 0)

  const g2 = fakeRes()
  await entryFor('/jobcv/applications').handler({ method: 'GET', url: '/jobcv/applications' }, g2)
  assert.equal(g2.code, 400, '?session= stays required, like every other route')

  // POST: happy path, then the refusals.
  const p1 = fakeRes()
  await entryFor('/jobcv/status').handler(
    fakeReq('POST', '/jobcv/status', { sessionId: 's1', status: 'applied', note: 'portal' }),
    p1,
  )
  assert.equal(p1.code, 200)
  assert.equal(p1.body.application.status, 'applied')

  const p2 = fakeRes()
  await entryFor('/jobcv/status').handler(
    fakeReq('POST', '/jobcv/status', { sessionId: 's1', status: 'hired' }),
    p2,
  )
  assert.equal(p2.code, 400, 'only the five tags exist')

  const p3 = fakeRes()
  await entryFor('/jobcv/status').handler(fakeReq('POST', '/jobcv/status', { status: 'offer' }), p3)
  assert.equal(p3.code, 400)

  const p4 = fakeRes()
  await entryFor('/jobcv/status').handler(fakeReq('POST', '/jobcv/status', { sessionId: 's1' }), p4)
  assert.equal(p4.code, 400)

  const countsAfter = fakeRes()
  await entryFor('/jobcv/applications').handler(
    { method: 'GET', url: '/jobcv/applications?session=s1' },
    countsAfter,
  )
  assert.equal(countsAfter.body.counts.applied, 1)
  assert.equal(countsAfter.body.counts.drafting, 0)

  // Through the REAL guard wrapper, the way the webServer mounts it.
  const guarded = guardHandler(entryFor('/jobcv/status'), {
    isTrusted: isTrustedRequest,
    readJsonBody,
    sendJson,
  })
  const untrusted = fakeRes()
  await guarded(
    {
      method: 'POST',
      url: '/jobcv/status',
      headers: { host: 'evil.example' },
    },
    untrusted,
  )
  assert.equal(untrusted.code, 403, 'the trust gate covers the new routes too')

  await rm(dir, { recursive: true, force: true })
  console.log('ok  applications: routes')
}

// ---- the agent contract knows about the tracker ----
{
  const skill = skillInstructions()
  assert.ok(skill.includes('THE APPLICATION TRACKER'), 'the contract names the tracker')
  assert.ok(skill.includes('/jobcv/status'), 'and its write route')
  assert.ok(skill.includes('/jobcv/applications'), 'and its read route')
  assert.ok(
    skill.includes('drafting | applied | interview | offer | rejected'),
    'the five tags are spelled out',
  )
  assert.ok(
    skill.includes('never your inference') || skill.includes('not your inference'),
    'a status is the USER report — the agent must not guess it',
  )
  console.log('ok  applications: contract')
}
