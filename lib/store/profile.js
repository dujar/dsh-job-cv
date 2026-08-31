/**
 * The candidate profile — the standing facts about the person, not any one
 * application.
 *
 * Every session otherwise re-derives the same things: years of experience,
 * what the candidate will and will not claim, confidentiality constraints,
 * the "why I left" stories that belong in an interview and not on the page.
 * This is one plain-text (markdown) document under the plugin's own state,
 * beside master.json, on the same last-N-versions pattern.
 *
 *   $DSH_HOME/dsh-job-cv/profile.json
 *
 * It is the user's word, held to the same rule as everything else they have
 * written: the agent PROPOSES additions when a session establishes a durable
 * fact, and saves only what the user confirms, verbatim.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const KEEP_VERSIONS = 8
const MAX_TEXT = 20000

function empty() {
  return { text: '', updatedAt: 0, history: [] }
}

function normalize(parsed) {
  const raw = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const history = Array.isArray(raw.history) ? raw.history : []
  return {
    text: typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT) : '',
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    history: history
      .filter((e) => e !== null && typeof e === 'object' && typeof e.text === 'string')
      .map((e) => ({
        text: e.text.slice(0, MAX_TEXT),
        updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : 0,
      }))
      .slice(0, KEEP_VERSIONS),
  }
}

export function createProfileStore(rootDir) {
  const file = join(rootDir, 'profile.json')
  let cache = null
  let queue = Promise.resolve()

  async function load() {
    if (cache !== null) return cache
    try {
      cache = normalize(JSON.parse(await readFile(file, 'utf8')))
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        cache = empty()
        return cache
      }
      throw new Error(
        'the candidate profile is unreadable (' + file + '); move that file aside to start fresh',
      )
    }
    return cache
  }

  function withLock(fn) {
    const run = queue.then(fn, fn)
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** Replace the profile wholesale. '' clears it. Returns the stored text. */
  function save(text) {
    return withLock(async function () {
      const record = await load()
      const body = typeof text === 'string' ? text.slice(0, MAX_TEXT) : ''
      const next = {
        text: body,
        updatedAt: Date.now(),
        history: [
          ...(record.text !== '' ? [{ text: record.text, updatedAt: record.updatedAt }] : []),
          ...record.history,
        ].slice(0, KEEP_VERSIONS),
      }
      await mkdir(rootDir, { recursive: true })
      const tmp = file + '.tmp-' + randomUUID()
      try {
        await writeFile(tmp, JSON.stringify(next), 'utf8')
        await rename(tmp, file)
      } catch (error) {
        await rm(tmp, { force: true })
        throw error
      }
      cache = next
      return next.text
    })
  }

  return { load, save }
}
