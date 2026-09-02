import { strict as assert } from 'node:assert'
import { createDocStore } from '../lib/store/doc-store.js'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'jobcv-master-'))
const root = join(dir, 'apps')

try {
  // ---- the master store, through the doc-store that owns it ----
  const store = createDocStore(dir)

  // no master yet: empty shell, markers at zero
  assert.equal((await store.getMaster()).version, 0)
  assert.equal((await store.get()).masterVersion, 0)
  assert.equal(await store.masterMirror(root), null)

  // the delta says honestly that there is nothing to compare against
  const none = await store.deltaVsMaster('s1', 'cv')
  assert.equal(none.empty, 'no-master')
  await store.save('s1', { html: '<html><body><p>tailored</p></body></html>' })
  const stillNone = await store.deltaVsMaster('fresh-session', 'cv')
  const noLetterYet = await store.deltaVsMaster('s1', 'letter')
  assert.equal(stillNone.empty, 'no-master', 'no master, no delta — whatever else exists')
  assert.equal(noLetterYet.empty, 'no-master', 'the missing-master check outranks the per-kind one')

  // save bumps the master's OWN version line, independent of any candidacy
  assert.equal(
    await store.saveMaster('s1', {
      html:
        '<html><body><div class="page"><h1>Jane Doe</h1><p>Senior engineer — Berlin</p>' +
        '<ul><li>Led a team of 10</li><li>Python</li></ul></div></body></html>',
      note: 'first master',
    }),
    1,
  )
  assert.equal(await store.saveMaster('s1', { html: '<p>v2</p>', note: 'tightened summary' }), 2)

  // a master save does NOT touch any session document
  const after = await store.get('s1')
  assert.equal(after.version, 1, 'the tailored CV kept its own version line')
  assert.equal(after.masterVersion, 2, 'the projection carries the master marker')
  assert.ok(after.masterUpdatedAt > 0)
  // ...and the notification reached the session's stream subscribers
  let pushed = 0
  const unsubscribe = store.subscribe('s1', function () {
    pushed += 1
  })
  await store.saveMaster('s1', { html: '<p>v3</p>' })
  unsubscribe()
  assert.equal(pushed, 1, 'an open preview learns about a master save through the same push')
  assert.equal((await store.get('s1')).masterVersion, 3)

  // persistence survives a fresh store over the same dir
  const again = createDocStore(dir)
  assert.equal((await again.getMaster()).version, 3)

  // history: newest first, current included, bodies only on request
  const timeline = await again.history('any-session', 'master')
  assert.deepEqual(
    timeline.map((e) => e.version),
    [3, 2, 1],
  )
  assert.equal(timeline[1].note, 'tightened summary')
  assert.equal(await again.versionHtml('any-session', 2, 'master'), '<p>v2</p>')

  // restore saves forward, like every other rollback here
  assert.equal(await again.restoreMaster(2), 4)
  assert.equal((await again.getMaster()).note, 'Restored master v2')
  assert.equal(await again.restoreMaster(99), null, 'a version nobody saved restores nothing')
  assert.deepEqual(
    (await again.history('x', 'master')).map((e) => e.version),
    [4, 3, 2, 1],
  )

  // history cap: like every line here, the last 10 PAST versions stay
  // reachable beside the current one
  for (let i = 5; i <= 14; i++) await again.saveMaster(null, { html: '<p>wave ' + i + '</p>' })
  const capped = await again.history('x', 'master')
  assert.equal(capped.length, 11)
  assert.deepEqual(
    capped.map((e) => e.version),
    [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4],
    'v1 fell off the far end first',
  )

  // an empty html is not a master
  await assert.rejects(() => again.saveMaster(null, { html: '   ' }), /non-empty/)

  // ---- the mirror: <root>/master/cv/latest.html exists on read AND save ----
  const mirrored = await again.masterMirror(root)
  assert.equal(mirrored.version, 14)
  assert.equal(mirrored.path, join(root, 'master', 'cv', 'latest.html'))
  assert.equal(await readFile(mirrored.path, 'utf8'), '<p>wave 14</p>')
  assert.ok((await readdir(join(root, 'master', 'cv'))).includes('v14.html'))

  // A root that cannot be written answers null instead of failing the caller.
  const doomed = await again.masterMirror('')
  assert.equal(doomed, null)

  // ---- the delta itself ----
  const withMaster = createDocStore(dir)
  const sessionId = 'delta-s'
  await withMaster.save(sessionId, {
    html:
      '<html><body><div class="page"><h1>Jane Doe</h1><p>Staff engineer — Berlin</p>' +
      '<ul><li>Led a team of 10 across three timezones</li></ul></div></body></html>',
  })
  await withMaster.saveMaster(null, {
    html:
      '<html><body><div class="page"><h1>Jane Doe</h1><p>Senior engineer — Berlin</p>' +
      '<ul><li>Led a team of 10</li><li>Python</li></ul></div></body></html>',
  })

  const delta = await withMaster.deltaVsMaster(sessionId, 'cv')
  assert.equal(delta.ok, true)
  assert.equal(delta.kind, 'cv')
  assert.equal(delta.masterVersion, 15)
  assert.equal(delta.targetVersion, 1)
  // styling-only churn (doctype, div, ul wrappers) never appears; only the
  // words tailoring actually moved do. Block equality is exact after
  // normalization, so a reworded bullet reads as remove-then-add.
  assert.deepEqual(
    delta.changes.map((c) => c.op),
    ['del', 'del', 'del', 'add', 'add'],
  )
  assert.equal(delta.added, 2)
  assert.equal(delta.removed, 3)
  assert.ok(delta.same >= 1, 'the untouched heading stays out of the changes')
  assert.equal(delta.truncated, false)
  const texts = delta.changes.map((c) => c.text)
  assert.ok(texts.includes('Python'), 'what tailoring left out reads as a removal')
  assert.ok(
    texts.includes('Led a team of 10 across three timezones'),
    'what this application gained reads as an addition',
  )

  // letter deltas work on their own document
  await withMaster.saveLetter(sessionId, { html: '<html><body><p>Dear team</p></body></html>' })
  const letterDelta = await withMaster.deltaVsMaster(sessionId, 'letter')
  assert.equal(letterDelta.kind, 'letter')
  assert.equal(letterDelta.targetVersion, 1)
  assert.equal(letterDelta.added, 1)
  assert.ok(
    letterDelta.changes.some((c) => c.text.includes('Dear team')),
    'the letter body shows up as what it added',
  )

  // a master exists but the session never wrote that kind: said, not guessed
  const noLetter = await withMaster.deltaVsMaster('never-started', 'letter')
  assert.equal(noLetter.empty, 'no-document')
  const noCv = await withMaster.deltaVsMaster('never-started', 'cv')
  assert.equal(noCv.empty, 'no-document')

  // ---- the incoming delta: what the master GAINED since a CV was tailored ----
  {
    const sync = createDocStore(await mkdtemp(join(tmpdir(), 'jobcv-sync-')))

    // no master yet
    const preMaster = await sync.deltaVsMaster('s', 'cv', 'incoming')
    assert.equal(preMaster.empty, 'no-master')
    assert.equal(preMaster.direction, 'incoming')

    // master v1, then a CV tailored from it — its base is stamped to v1, so
    // there is nothing incoming
    await sync.saveMaster(null, {
      html:
        '<html><body><div class="page"><h1>Jane Doe</h1><p>Senior engineer</p>' +
        '<ul><li>Led a team of 10</li></ul></div></body></html>',
      note: 'v1',
    })
    assert.equal(
      await sync.save('s', {
        html:
          '<html><body><div class="page"><h1>Jane Doe</h1>' +
          '<p>Senior engineer — fintech</p><ul><li>Led a team of 10</li></ul></div></body></html>',
      }),
      1,
    )
    assert.equal(
      (await sync.get('s')).baseMasterVersion,
      1,
      'a fresh CV is stamped with the master HEAD',
    )
    const level = await sync.deltaVsMaster('s', 'cv', 'incoming')
    assert.equal(level.empty, 'in-sync')
    assert.equal(level.baseMasterVersion, 1)
    assert.equal(level.masterVersion, 1)
    assert.equal(level.baseInferred, false)

    // master moves on: v2 adds a bullet, v3 rewrites the summary
    await sync.saveMaster(null, {
      html:
        '<html><body><div class="page"><h1>Jane Doe</h1><p>Senior engineer</p>' +
        '<ul><li>Led a team of 10</li><li>Shipped the billing rewrite</li></ul></div></body></html>',
      note: 'v2 — billing bullet',
    })
    await sync.saveMaster(null, {
      html:
        '<html><body><div class="page"><h1>Jane Doe</h1><p>Staff engineer, 12 years</p>' +
        '<ul><li>Led a team of 10</li><li>Shipped the billing rewrite</li></ul></div></body></html>',
      note: 'v3 — staff, years',
    })

    const incoming = await sync.deltaVsMaster('s', 'cv', 'incoming')
    assert.equal(incoming.empty, undefined)
    assert.equal(incoming.direction, 'incoming')
    assert.equal(
      incoming.baseMasterVersion,
      1,
      'diff runs from the version this CV was tailored from',
    )
    assert.equal(incoming.masterVersion, 3)
    assert.equal(incoming.targetVersion, 1, 'and it is about CV v1')
    assert.equal(incoming.baseInferred, false)
    const inTexts = incoming.changes.map((c) => c.text)
    assert.ok(
      inTexts.includes('Shipped the billing rewrite'),
      'a bullet the master gained reads as an addition',
    )
    assert.ok(inTexts.includes('Staff engineer, 12 years'), 'a reworded master line reads as add')
    assert.ok(inTexts.includes('Senior engineer'), 'the line it replaced reads as a removal')

    // a sync save reconciles the CV: pass the master version diffed against
    assert.equal(
      await sync.save('s', {
        html:
          '<html><body><div class="page"><h1>Jane Doe</h1><p>Staff engineer, 12 years — fintech</p>' +
          '<ul><li>Led a team of 10</li><li>Shipped the billing rewrite</li></ul></div></body></html>',
        note: 'Synced master v3',
        baseMasterVersion: 3,
      }),
      2,
    )
    assert.equal((await sync.get('s')).baseMasterVersion, 3)
    assert.equal((await sync.deltaVsMaster('s', 'cv', 'incoming')).empty, 'in-sync')

    // an ordinary tailoring save does NOT move the lineage marker
    await sync.save('s', {
      html: '<html><body><p>tweaked</p></body></html>',
      note: 'reworded a bullet',
    })
    assert.equal(
      (await sync.get('s')).baseMasterVersion,
      3,
      'a normal save leaves the marker alone',
    )

    // a restore of the CV body is not a re-reconciliation
    await sync.saveMaster(null, { html: '<p>v4</p>', note: 'v4' })
    const restored = await sync.restore('s', 2)
    assert.ok(restored > 0)
    assert.equal((await sync.get('s')).baseMasterVersion, 3, 'restore keeps the lineage marker')
  }

  // ---- a CV that predates the marker: the base is inferred, and said so ----
  {
    const legacyDir = await mkdtemp(join(tmpdir(), 'jobcv-legacy-'))
    const { writeFile: wf, mkdir: mkd } = await import('node:fs/promises')
    await mkd(join(legacyDir, 'sessions'), { recursive: true })
    // a session file with no baseMasterVersion at all — an old build's record
    await wf(
      join(legacyDir, 'sessions', 'old.json'),
      JSON.stringify({
        version: 1,
        html: '<html><body><div class="page"><p>old tailored CV</p></div></body></html>',
      }),
      'utf8',
    )
    const legacy = createDocStore(legacyDir)
    assert.equal((await legacy.get('old')).baseMasterVersion, 0)
    await legacy.saveMaster(null, {
      html: '<html><body><div class="page"><p>master one</p></div></body></html>',
      note: 'm1',
    })
    await legacy.saveMaster(null, {
      html: '<html><body><div class="page"><p>master two</p></div></body></html>',
      note: 'm2',
    })
    const inf = await legacy.deltaVsMaster('old', 'cv', 'incoming')
    assert.equal(inf.baseInferred, true, 'no stamped base — inferred from the oldest master kept')
    assert.equal(inf.baseMasterVersion, 1)
    assert.equal(inf.masterVersion, 2)
    assert.ok(inf.changes.some((c) => c.text === 'master two'))
    await rm(legacyDir, { recursive: true, force: true })
  }

  // ---- a master exists but no CV: nothing to sync into ----
  {
    const bare = createDocStore(await mkdtemp(join(tmpdir(), 'jobcv-bare-')))
    await bare.saveMaster(null, { html: '<p>a master</p>', note: 'm' })
    const none = await bare.deltaVsMaster('never', 'cv', 'incoming')
    assert.equal(none.empty, 'no-document')
    assert.equal(none.direction, 'incoming')
  }

  // ---- a corrupt master.json raises instead of inviting an overwrite ----
  const broken = await mkdtemp(join(tmpdir(), 'jobcv-master-broken-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(broken, 'master.json'), '{not json', 'utf8')
    const brokenStore = createDocStore(broken)
    await assert.rejects(() => brokenStore.getMaster(), /unreadable/)
  } finally {
    await rm(broken, { recursive: true, force: true })
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
