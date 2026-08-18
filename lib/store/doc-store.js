/**
 * Per-session CV document store.
 *
 * One JSON file per session under $DSH_HOME/dsh-job-cv/sessions/. The file
 * holds the current document plus the last KEEP_VERSIONS saves so the user
 * can roll back later (the groundwork for a fuller job workspace).
 *
 * Every save for a session runs under a per-session lock. Read-modify-write
 * without one lets two concurrent POSTs read the same version, both write
 * version N+1, and one document disappear.
 */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const KEEP_VERSIONS = 10

/** The cache is a read cache only; the file on disk stays authoritative. */
const MAX_CACHED_SESSIONS = 64

/** Session ids are uuid-ish, but be fail-safe about path building. */
export function sanitizeSessionId(id) {
  const raw = String(id === undefined || id === null ? '' : id)
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safe.length > 0 && safe.length <= 128 ? safe : null
}

function emptyRecord() {
  return { version: 0, html: '', jobUrl: '', updatedAt: 0, history: [] }
}

/**
 * Coerce whatever the file held into a well-formed record. A file written by
 * an older build must degrade to sane fields rather than throwing a
 * TypeError out of get() on every request for that session.
 */
export function normalizeRecord(parsed) {
  const raw = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const history = Array.isArray(raw.history) ? raw.history : []
  return {
    version: Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 0,
    html: typeof raw.html === 'string' ? raw.html : '',
    jobUrl: typeof raw.jobUrl === 'string' ? raw.jobUrl : '',
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    history: history.filter((e) => e !== null && typeof e === 'object').slice(0, KEEP_VERSIONS),
  }
}

export function createDocStore(rootDir) {
  const dir = join(rootDir, 'sessions')
  const cache = new Map()
  const locks = new Map()
  let seeded = false

  async function ensureDir() {
    if (!seeded) {
      await mkdir(dir, { recursive: true })
      seeded = true
    }
  }

  function fileFor(sessionId) {
    return join(dir, sessionId + '.json')
  }

  /** Bounded LRU: re-inserting moves a key to the end, the oldest is dropped. */
  function remember(sessionId, record) {
    cache.delete(sessionId)
    cache.set(sessionId, record)
    while (cache.size > MAX_CACHED_SESSIONS) cache.delete(cache.keys().next().value)
    return record
  }

  /**
   * The session's record. ONLY a missing file means "new session": a read or
   * parse failure on a file that DOES exist must propagate, because handing
   * back an empty shell would make the next save overwrite the real document
   * and its entire history.
   */
  async function load(sessionId) {
    if (cache.has(sessionId)) return remember(sessionId, cache.get(sessionId))
    let text
    try {
      text = await readFile(fileFor(sessionId), 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return remember(sessionId, emptyRecord())
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(
        'cv document for session ' +
          sessionId +
          ' is unreadable (' +
          fileFor(sessionId) +
          '); move that file aside to start fresh',
      )
    }
    return remember(sessionId, normalizeRecord(parsed))
  }

  /** Atomic write: a UNIQUE temp file then rename. */
  async function persist(sessionId, record) {
    await ensureDir()
    const target = fileFor(sessionId)
    const tmp = target + '.tmp-' + randomUUID()
    try {
      await writeFile(tmp, JSON.stringify(record), 'utf8')
      await rename(tmp, target)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }

  /**
   * Queue fn behind any in-flight write for this session. A rejected
   * predecessor must not poison the queue, so the stored tail always settles.
   */
  function withSessionLock(sessionId, fn) {
    const prev = locks.get(sessionId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => {},
      () => {},
    )
    locks.set(sessionId, tail)
    tail.then(function () {
      if (locks.get(sessionId) === tail) locks.delete(sessionId)
    })
    return run
  }

  /**
   * Replace the document wholesale and bump the version. Returns the new
   * version. html must be a non-empty string; jobUrl is optional.
   */
  function save(sessionId, doc) {
    return withSessionLock(sessionId, async function () {
      const record = await load(sessionId)
      const next = {
        version: record.version + 1,
        html: String(doc.html),
        jobUrl:
          doc.jobUrl === undefined || doc.jobUrl === null ? record.jobUrl : String(doc.jobUrl),
        updatedAt: Date.now(),
        history: [
          ...(record.version > 0
            ? [{ version: record.version, html: record.html, updatedAt: record.updatedAt }]
            : []),
          ...record.history,
        ].slice(0, KEEP_VERSIONS),
      }
      // Cache only after the bytes land, so a failed write never leaves the
      // cache claiming a version that is not on disk.
      await persist(sessionId, next)
      remember(sessionId, next)
      return next.version
    })
  }

  /** The public projection (history stays server-side for now). */
  async function get(sessionId) {
    const record = await load(sessionId)
    return {
      version: record.version,
      html: record.html,
      jobUrl: record.jobUrl,
      updatedAt: record.updatedAt,
      historyDepth: record.history.length,
    }
  }

  return { load, save, get }
}
