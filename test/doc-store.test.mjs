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

  // no temp files left behind
  const leftovers = (await readdir(join(dir, 'sessions'))).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'temp files are renamed or cleaned up')

  console.log('ok  doc-store')
} finally {
  await rm(dir, { recursive: true, force: true })
}
