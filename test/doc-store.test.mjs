import { strict as assert } from 'node:assert'
import { createDocStore, sanitizeSessionId, normalizeRecord } from '../lib/store/doc-store.js'
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'jobcv-store-'))
// Real writable candidacy folders: saves mirror into them, so pointing these
// at a path the test user cannot write would only assert the warning path.
const wsA = join(dir, 'ws-a')
const wsB = join(dir, 'ws-b')
try {
  // sanitize: path-safe ids only
  assert.equal(sanitizeSessionId('abc-123_XYZ.42'), 'abc-123_XYZ.42')
  assert.equal(sanitizeSessionId('../../etc/passwd'), '.._.._etc_passwd')
  assert.equal(sanitizeSessionId(''), null)
  // The browser and the agent spell the same session differently; both have
  // to land on one document, or the preview watches a key nobody writes.
  assert.equal(
    sanitizeSessionId('session-343d8da6-3066-4cd7-b5b7-e12f2dabdd9a'),
    sanitizeSessionId('343d8da6-3066-4cd7-b5b7-e12f2dabdd9a'),
    'prefixed and bare ids address the same document',
  )
  assert.equal(sanitizeSessionId('session-abc'), 'abc')
  assert.equal(sanitizeSessionId('session-'), null, 'a bare prefix is not an id')
  assert.equal(sanitizeSessionId(undefined), null)

  const store = createDocStore(dir)
  // empty session -> empty shell, version 0
  assert.equal((await store.get('s1')).version, 0)

  // save bumps version and keeps history
  assert.equal(await store.save('s1', { html: '<html>1</html>', jobUrl: 'https://j.o/1' }), 1)
  assert.equal(await store.save('s1', { html: '<html>2</html>' }), 2)
  const doc = await store.get('s1')
  assert.equal(doc.version, 2)
  assert.equal(doc.html, '<html>2</html>')
  assert.equal(doc.jobUrl, 'https://j.o/1') // jobUrl sticky when omitted
  assert.equal(doc.historyDepth, 1)

  // persistence survives a fresh store over the same dir
  const again = createDocStore(dir)
  assert.equal((await again.get('s1')).version, 2)

  // setWorkspace records the candidacy dir and makes the jobUrl sticky
  assert.equal(await store.setWorkspace('s1', wsA, undefined), wsA)
  const withWs = await store.get('s1')
  assert.equal(withWs.workspace, wsA)
  assert.equal(withWs.jobUrl, 'https://j.o/1', 'jobUrl untouched when not given')
  assert.equal(
    await store.setWorkspace('s1', wsB, 'https://j.o/2', 'Acme Corp', 'Senior Engineer'),
    wsB,
  )
  const withWs2 = await store.get('s1')
  assert.equal(withWs2.workspace, wsB)
  assert.equal(withWs2.jobUrl, 'https://j.o/2', 'jobUrl replaced when given')
  assert.equal(withWs2.company, 'Acme Corp', 'company recorded for the dock label')
  assert.equal(withWs2.jobTitle, 'Senior Engineer')
  // a save after setWorkspace keeps the workspace (no lost update)
  assert.equal(await store.save('s1', { html: '<html>3</html>' }), 3)
  assert.equal((await store.get('s1')).workspace, wsB)
  assert.equal((await store.get('s1')).company, 'Acme Corp', 'company survives a save')

  // history(): pickable versions, newest first, no bodies
  await store.save('s1', { html: '<html>4</html>' })
  const pickable = await store.history('s1')
  assert.equal(pickable[0].version, 4, 'current version first')
  assert.deepEqual(
    pickable.map((v) => v.version),
    [4, 3, 2, 1],
    'history walks back through every save',
  )
  assert.ok(pickable[1].updatedAt > 0)
  assert.equal('html' in pickable[0], false, 'bodies stay server-side')

  // restore(): rolls back to an earlier version, bumping the version
  const restored = await store.restore('s1', 2)
  assert.equal(restored, 5, 'restore is itself a save (version bumps)')
  const afterRestore = await store.get('s1')
  assert.equal(afterRestore.version, 5)
  assert.equal(afterRestore.html, '<html>2</html>', 'the old document is back')
  assert.equal(afterRestore.workspace, wsB, 'workspace survives a restore')

  // Every save reaches the candidacy folder, restores included, so the folder
  // holds the CV rather than just a README.
  const mirrored = await readdir(join(wsB, 'cv'))
  assert.ok(mirrored.includes('latest.html'), 'latest.html exists: ' + mirrored.join(', '))
  assert.ok(
    mirrored.includes('v' + afterRestore.version + '.html'),
    'the restored version is mirrored too',
  )
  assert.equal(
    await readFile(join(wsB, 'cv', 'latest.html'), 'utf8'),
    afterRestore.html,
    'latest.html matches the live document',
  )

  // A workspace opened after some saves is populated immediately, not left
  // empty until the next save.
  const late = createDocStore(join(dir, 'late'))
  await late.save('l1', { html: '<html>already saved</html>' })
  const wsLate = join(dir, 'ws-late')
  await late.setWorkspace('l1', wsLate)
  assert.equal(
    await readFile(join(wsLate, 'cv', 'latest.html'), 'utf8'),
    '<html>already saved</html>',
  )

  // An unwritable workspace warns but never fails the save: the session file
  // is the source of truth and a folder that moved or went read-only must not
  // start rejecting the user's work.
  const locked = join(dir, 'locked')
  await mkdir(locked, { recursive: true })
  await chmod(locked, 0o500)
  let enforced = true
  try {
    await mkdir(join(locked, 'probe'))
    enforced = false // running as root: permissions prove nothing here
  } catch {
    // good — the directory really is unwritable
  }
  if (enforced) {
    const unwritable = createDocStore(join(dir, 'unwritable'))
    await unwritable.setWorkspace('b1', join(locked, 'acme', '1'))
    const warn = console.warn
    console.warn = () => {} // the warning is the point; the noise is not
    try {
      assert.equal(await unwritable.save('b1', { html: '<html>still saved</html>' }), 1)
    } finally {
      console.warn = warn
    }
    assert.equal((await unwritable.get('b1')).html, '<html>still saved</html>')
  }
  await chmod(locked, 0o700) // so the temp tree can be removed again
  // ...and the restore is never destructive: v4 lands in history
  const afterVersions = await store.history('s1')
  assert.deepEqual(
    afterVersions.map((v) => v.version),
    [5, 4, 3, 2, 1],
    'the restored-to version stays in history too',
  )
  // restoring the current version or a missing one is refused
  assert.equal(await store.restore('s1', 5), null, 'current version is not restorable')
  assert.equal(await store.restore('s1', 99), null, 'unknown version is not restorable')
  assert.equal(await store.restore('s1', 0), null)

  // CONCURRENT saves: the per-session lock must serialize them. Without it
  // both reads see the same version, both write N+1, and one document is
  // lost -- and the shared Date.now() temp name made rename() throw ENOENT.
  const racy = createDocStore(dir)
  const versions = await Promise.all([
    racy.save('race', { html: '<html>A</html>' }),
    racy.save('race', { html: '<html>B</html>' }),
    racy.save('race', { html: '<html>C</html>' }),
  ])
  assert.deepEqual(versions.slice().sort(), [1, 2, 3], 'every save gets its own version')
  assert.equal((await racy.get('race')).version, 3)
  assert.equal((await racy.get('race')).historyDepth, 2, 'no save silently dropped')

  // history is capped and ordered newest-first
  const capped = createDocStore(dir)
  for (let i = 1; i <= 14; i++) await capped.save('cap', { html: '<html>' + i + '</html>' })
  const capRecord = JSON.parse(await readFile(join(dir, 'sessions', 'cap.json'), 'utf8'))
  assert.equal(capRecord.version, 14)
  assert.equal(capRecord.history.length, 10)
  assert.equal(capRecord.history[0].version, 13)

  // A corrupt/unreadable file must NOT read as a fresh session: returning an
  // empty shell would make the next save overwrite the real CV and its
  // history. It raises instead, naming the file to move aside.
  await writeFile(join(dir, 'sessions', 's1.json'), '{ truncated', 'utf8')
  const broken = createDocStore(dir)
  await assert.rejects(broken.get('s1'), /unreadable/)
  await assert.rejects(broken.save('s1', { html: '<html>x</html>' }), /unreadable/)
  const stillThere = await readFile(join(dir, 'sessions', 's1.json'), 'utf8')
  assert.equal(stillThere, '{ truncated', 'the bytes on disk are left untouched')

  // ...but a well-formed-JSON record of the wrong SHAPE degrades gracefully
  // rather than throwing a TypeError out of get() forever.
  assert.deepEqual(normalizeRecord(null), {
    version: 0,
    html: '',
    jobUrl: '',
    updatedAt: 0,
    workspace: '',
    proposal: null,
    fit: null,
    post: null,
    brief: null,
    letter: null,
    letterHistory: [],
    application: null,
    requests: [],
    note: '',
    company: '',
    jobTitle: '',
    history: [],
  })
  assert.deepEqual(normalizeRecord({ version: 3, html: 'x' }).history, [])
  assert.equal(normalizeRecord({ version: -2 }).version, 0)
  assert.equal(normalizeRecord({ version: 3, html: 'x' }).version, 3)
  const shapeDir = join(dir, 'shape')
  await mkdir(join(shapeDir, 'sessions'), { recursive: true })
  await writeFile(join(shapeDir, 'sessions', 'sx.json'), '{"version":3,"html":"x"}', 'utf8')
  assert.equal((await createDocStore(shapeDir).get('sx')).historyDepth, 0)
  assert.equal((await createDocStore(shapeDir).get('sx')).version, 3)

  // ---- version notes: a timeline of timestamps says nothing ----
  {
    const noted = createDocStore(join(dir, 'noted'))
    await noted.save('n1', { html: '<h1>1</h1>', note: 'First tailored draft' })
    await noted.save('n1', { html: '<h1>2</h1>', note: 'Quantified the bullets' })
    await noted.save('n1', { html: '<h1>3</h1>' }) // a save may omit its note
    const timeline = await noted.history('n1')
    assert.deepEqual(
      timeline.map((v) => v.version),
      [3, 2, 1],
      'newest first',
    )
    assert.deepEqual(
      timeline.map((v) => v.note),
      ['', 'Quantified the bullets', 'First tailored draft'],
      'each version keeps the note it was saved with',
    )
    // a restore labels itself, so the timeline explains its own jumps
    assert.equal(await noted.restore('n1', 1), 4)
    assert.equal((await noted.history('n1'))[0].note, 'Restored v1')
    // notes are bounded — this is a label, not an essay
    await noted.save('n1', { html: '<h1>x</h1>', note: 'z'.repeat(500) })
    assert.equal((await noted.history('n1'))[0].note.length, 200)

    // ---- bodies are fetched one at a time, not shipped with the list ----
    assert.equal(timeline[0].html, undefined, 'the list carries no bodies')
    assert.equal(await noted.versionHtml('n1', 2), '<h1>2</h1>')
    assert.equal(await noted.versionHtml('n1', 1), '<h1>1</h1>')
    assert.equal(await noted.versionHtml('n1', 999), null, 'an unknown version is not an error')
  }

  // no temp files left behind
  const leftovers = (await readdir(join(dir, 'sessions'))).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'temp files are renamed or cleaned up')

  // ---- the push behind /jobcv/stream ----
  // Every write fans out to whoever is watching that session, and only that
  // session: a preview must not repaint because a different candidacy saved.
  {
    const seen = []
    const other = []
    const stop = store.subscribe('s1', () => seen.push('s1'))
    store.subscribe('s2', () => other.push('s2'))
    const before = seen.length
    await store.save('s1', { html: '<html>watched</html>' })
    assert.equal(seen.length, before + 1, 'a save pushes to the session it saved')
    assert.equal(other.length, 0, 'and to no one else')
    // Everything that changes what the projection says has to push, or the
    // preview shows a document the store has already moved past.
    await store.saveLetter('s1', { html: '<p>watched letter</p>' })
    await store.setFit('s1', { score: 50, gaps: [] })
    assert.equal(seen.length, before + 3, 'a letter and a score push too')
    // A thrown subscriber is a broken stream, not a broken save.
    store.subscribe('s1', () => {
      throw new Error('this stream is gone')
    })
    const version = await store.save('s1', { html: '<html>survives</html>' })
    assert.ok(version > 0, 'a subscriber that throws does not fail the save')
    // Unsubscribing is what a closed stream does; it must actually stop.
    stop()
    const quiet = seen.length
    await store.save('s1', { html: '<html>unwatched</html>' })
    assert.equal(seen.length, quiet, 'an unsubscribed watcher hears nothing')
  }

  console.log('ok  doc-store')
} finally {
  await rm(dir, { recursive: true, force: true })
}

// ---- the cover letter keeps its own timeline ----
// It is a second document with its own version line, so "go back to the
// paragraph I had before" has to mean the letter's v2, not the CV's.
{
  const dir = await mkdtemp(join(tmpdir(), 'jobcv-letter-history-'))
  const store = createDocStore(dir)
  assert.deepEqual(await store.history('s1', 'letter'), [], 'no letter, no timeline')

  await store.saveLetter('s1', { html: '<html>letter one</html>', note: 'First draft' })
  await store.saveLetter('s1', { html: '<html>letter two</html>', note: 'Tightened the opening' })
  await store.save('s1', { html: '<html>cv one</html>', note: 'Tailored' })

  const letterLine = await store.history('s1', 'letter')
  assert.deepEqual(
    letterLine.map((e) => [e.version, e.note]),
    [
      [2, 'Tightened the opening'],
      [1, 'First draft'],
    ],
    'newest first, each labelled with what its author wrote',
  )
  const cvLine = await store.history('s1')
  assert.deepEqual(
    cvLine.map((e) => e.version),
    [1],
    'and the CV timeline is untouched by letter saves',
  )

  assert.equal(await store.versionHtml('s1', 1, 'letter'), '<html>letter one</html>')
  assert.equal(await store.versionHtml('s1', 2, 'letter'), '<html>letter two</html>')
  assert.equal(
    await store.versionHtml('s1', 1, 'cv'),
    '<html>cv one</html>',
    'the two version lines both start at 1 and must not be confused',
  )

  // A rollback saves FORWARD, exactly like the CV's: going back is never how
  // a draft gets lost.
  const restored = await store.restoreLetter('s1', 1)
  assert.equal(restored, 3)
  const after = await store.get('s1')
  assert.equal(after.letter.version, 3)
  assert.equal(after.letter.html, '<html>letter one</html>')
  assert.equal(after.letter.note, 'Restored letter v1')
  assert.equal(after.version, 1, 'and the CV did not move')
  assert.equal(
    (await store.history('s1', 'letter')).length,
    3,
    'the version rolled away from is still in the timeline',
  )
  assert.equal(await store.restoreLetter('s1', 99), null, 'a version that never existed is null')

  await rm(dir, { recursive: true, force: true })
}

// ---- listRecentCvs: what onboarding offers from past applications ----
{
  const dir = await mkdtemp(join(tmpdir(), 'jobcv-recents-'))
  const wsA = join(dir, 'apps', 'acme-corp', '42')
  const wsB = join(dir, 'apps', 'globex', '9')
  const store = createDocStore(join(dir, 'store'))

  // Two sessions open the SAME candidacy folder: one CV to choose, not two.
  await store.save('old-acme', { html: '<html>acme v1</html>' })
  await store.setWorkspace(
    'old-acme',
    wsA,
    'https://jobs.example.com/42',
    'Acme Corp',
    'Senior Engineer',
  )
  await store.save('new-acme', { html: '<html>acme latest</html>', note: 'tailored again' })
  await store.setWorkspace(
    'new-acme',
    wsA,
    'https://jobs.example.com/42',
    'Acme Corp',
    'Senior Engineer',
  )
  // A second application, touched later.
  await new Promise((r) => setTimeout(r, 5))
  await store.save('s-globex', { html: '<html>globex</html>' })
  await store.setWorkspace('s-globex', wsB, undefined, 'Globex', '')

  // Records that must never be offered: a broken file, a never-saved session
  // (version 0), and a save that never got a candidacy folder.
  await writeFile(join(dir, 'store', 'sessions', 'broken.json'), '{ truncated', 'utf8')
  await writeFile(
    join(dir, 'store', 'sessions', 'fresh.json'),
    JSON.stringify({ version: 0, html: '' }),
    'utf8',
  )
  await writeFile(
    join(dir, 'store', 'sessions', 'nows.json'),
    JSON.stringify({ version: 2, html: '<html>x</html>', workspace: '' }),
    'utf8',
  )
  // A persist temp left mid-write is skipped by the suffix filter alone.
  await writeFile(join(dir, 'store', 'sessions', 'x.json.tmp-abc'), 'garbage', 'utf8')

  const recents = await store.listRecentCvs('brand-new')
  assert.equal(recents.length, 2, 'one entry per candidacy folder, deduped across sessions')
  assert.equal(recents[0].workspace, wsB, 'most recently updated first')
  assert.equal(recents[1].path, join(wsA, 'cv', 'latest.html'), 'the mirrored file is the offer')
  assert.equal(recents[1].company, 'Acme Corp')
  assert.equal(recents[1].version, 1)
  assert.equal(
    recents[1].sessionId,
    'new-acme',
    'when two sessions share a folder, their latest wins',
  )
  assert.ok(!recents.some((e) => e.sessionId === 'old-acme'))

  const self = await store.listRecentCvs('new-acme')
  assert.ok(!self.some((e) => e.sessionId === 'new-acme'), 'a session never offers itself')

  // A candidacy folder whose mirror has vanished drops out rather than
  // handing onboarding a dead path.
  await rm(wsB, { recursive: true, force: true })
  const afterDelete = await store.listRecentCvs('')
  assert.deepEqual(
    afterDelete.map((e) => e.workspace),
    [wsA],
  )

  await rm(dir, { recursive: true, force: true })
}
