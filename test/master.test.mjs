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
