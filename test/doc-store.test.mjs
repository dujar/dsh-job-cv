import { strict as assert } from 'node:assert'
import { createDocStore, sanitizeSessionId, normalizeRecord } from '../lib/store/doc-store.js'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'jobcv-store-'))
try {
  // sanitize: path-safe ids only
  assert.equal(sanitizeSessionId('abc-123_XYZ.42'), 'abc-123_XYZ.42')
  assert.equal(sanitizeSessionId('../../etc/passwd'), '.._.._etc_passwd')
  assert.equal(sanitizeSessionId(''), null)
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
  assert.equal(await store.setWorkspace('s1', '/apps/acme/123', undefined), '/apps/acme/123')
  const withWs = await store.get('s1')
  assert.equal(withWs.workspace, '/apps/acme/123')
  assert.equal(withWs.jobUrl, 'https://j.o/1', 'jobUrl untouched when not given')
  assert.equal(
    await store.setWorkspace(
      's1',
      '/apps/acme/456',
      'https://j.o/2',
      'Acme Corp',
      'Senior Engineer',
    ),
    '/apps/acme/456',
  )
  const withWs2 = await store.get('s1')
  assert.equal(withWs2.workspace, '/apps/acme/456')
  assert.equal(withWs2.jobUrl, 'https://j.o/2', 'jobUrl replaced when given')
  assert.equal(withWs2.company, 'Acme Corp', 'company recorded for the dock label')
  assert.equal(withWs2.jobTitle, 'Senior Engineer')
  // a save after setWorkspace keeps the workspace (no lost update)
  assert.equal(await store.save('s1', { html: '<html>3</html>' }), 3)
  assert.equal((await store.get('s1')).workspace, '/apps/acme/456')
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
  assert.equal(afterRestore.workspace, '/apps/acme/456', 'workspace survives a restore')
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
  const { readdir } = await import('node:fs/promises')
  const leftovers = (await readdir(join(dir, 'sessions'))).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'temp files are renamed or cleaned up')

  console.log('ok  doc-store')
} finally {
  await rm(dir, { recursive: true, force: true })
}
