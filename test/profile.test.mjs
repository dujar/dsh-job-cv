import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProfileStore } from '../lib/store/profile.js'

// The candidate profile: standing facts about the person, on the same
// last-N-versions pattern the master CV uses, degrading rather than throwing
// on a file an older build wrote.

const dir = await mkdtemp(join(tmpdir(), 'jobcv-profile-'))
try {
  const store = createProfileStore(dir)

  assert.deepEqual(await store.load(), { text: '', updatedAt: 0, history: [] }, 'empty until saved')

  const stored = await store.save(
    '# Fabricio\n\n- 7 years, counted from 2018\n- client names are confidential',
  )
  assert.ok(stored.includes('7 years'), 'save returns the stored text')
  const one = await store.load()
  assert.ok(one.text.includes('confidential'))
  assert.ok(one.updatedAt > 0)
  assert.equal(one.history.length, 0, 'the first save has nothing to push to history')

  await store.save(
    '# Fabricio\n\n- 7 years\n- confidential\n- left Terrascope in a reorg, not for performance',
  )
  const two = await store.load()
  assert.ok(two.text.includes('reorg'))
  assert.equal(two.history.length, 1, 'the previous version is kept')
  assert.ok(two.history[0].text.includes('7 years, counted from 2018'))

  // A fresh store instance reads what is on disk.
  const reopened = createProfileStore(dir)
  assert.ok((await reopened.load()).text.includes('reorg'))

  // "" clears the text but keeps the history.
  await reopened.save('')
  const cleared = await reopened.load()
  assert.equal(cleared.text, '')
  assert.ok(cleared.history.length >= 2, 'clearing does not lose the record')

  // A file an older build wrote (missing fields) degrades to sane values.
  await writeFile(join(dir, 'profile.json'), JSON.stringify({ text: 42, history: 'nope' }), 'utf8')
  const degraded = createProfileStore(dir)
  assert.deepEqual(await degraded.load(), { text: '', updatedAt: 0, history: [] })

  // An unreadable file raises rather than silently starting fresh.
  await writeFile(join(dir, 'profile.json'), 'not json', 'utf8')
  await assert.rejects(() => createProfileStore(dir).load(), /unreadable/)

  console.log('ok  profile: standing candidate facts, versioned, degrades on read')
} finally {
  await rm(dir, { recursive: true, force: true })
}
