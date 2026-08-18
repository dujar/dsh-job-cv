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
import { mirrorCvVersion } from './workspace.js'
import { readProposal } from './proposal.js'

const KEEP_VERSIONS = 10

/** The cache is a read cache only; the file on disk stays authoritative. */
const MAX_CACHED_SESSIONS = 64

/**
 * Session ids are uuid-ish, but be fail-safe about path building.
 *
 * The two callers spell the same session differently. The web client's
 * standard-kit id carries a "session-" prefix — that is the harness's
 * canonical spelling, and dsh-trader persists chart state under it — while an
 * agent working from a uuid uses the bare form. Both MUST resolve to one
 * document: when they did not, the browser polled `session-<uuid>`, got an
 * empty shell and sat on the onboarding start form forever, while the agent's
 * saves landed correctly under `<uuid>` where nothing was watching.
 */
export function sanitizeSessionId(id) {
  const raw = String(id === undefined || id === null ? '' : id).replace(/^session-/, '')
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safe.length > 0 && safe.length <= 128 ? safe : null
}

/** A cover letter is a second document, versioned like the CV. */
function readLetter(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.html !== 'string' || value.html === '') return null
  return {
    version: Number.isInteger(value.version) && value.version > 0 ? value.version : 1,
    html: value.html,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  }
}

function emptyRecord() {
  return {
    proposal: null,
    letter: null,
    version: 0,
    html: '',
    jobUrl: '',
    updatedAt: 0,
    workspace: '',
    company: '',
    jobTitle: '',
    history: [],
  }
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
    workspace: typeof raw.workspace === 'string' ? raw.workspace : '',
    proposal: readProposal(raw.proposal),
    letter: readLetter(raw.letter),
    company: typeof raw.company === 'string' ? raw.company : '',
    jobTitle: typeof raw.jobTitle === 'string' ? raw.jobTitle : '',
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
   * Copy a saved version into the candidacy folder. Runs inside the write
   * lock so two saves cannot race on latest.html, and never throws: the
   * session file is the source of truth, and a folder that has been moved or
   * made read-only must not start failing the user's saves.
   */
  async function mirror(record) {
    if (record.workspace === '') return
    try {
      await mirrorCvVersion(record.workspace, record.version, record.html)
    } catch (error) {
      console.warn(
        '[dsh-job-cv] could not mirror v' +
          record.version +
          ' into ' +
          record.workspace +
          ': ' +
          String(error && error.message ? error.message : error),
      )
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
        workspace: record.workspace,
        company: record.company,
        jobTitle: record.jobTitle,
        // A save answers whatever was pending: leaving the proposal up would
        // ask the user to decide again about text that no longer exists.
        proposal: null,
        letter: record.letter,
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
      await mirror(next)
      return next.version
    })
  }

  /**
   * Remember the candidacy directory for this session. Shares the write lock
   * with save() so it cannot race a document save into a lost update.
   */
  function setWorkspace(sessionId, workspace, jobUrl, company, jobTitle) {
    return withSessionLock(sessionId, async function () {
      const record = await load(sessionId)
      const next = Object.assign({}, record, {
        workspace: String(workspace),
        jobUrl: jobUrl === undefined || jobUrl === null ? record.jobUrl : String(jobUrl),
        company: company === undefined || company === null ? record.company : String(company),
        jobTitle: jobTitle === undefined || jobTitle === null ? record.jobTitle : String(jobTitle),
      })
      await persist(sessionId, next)
      remember(sessionId, next)
      // A workspace opened AFTER some saves would otherwise start empty
      // and only fill from the next save onward.
      await mirror(next)
      return next.workspace
    })
  }

  /**
   * Roll back to an earlier save. Finds the version in history, replaces the
   * current document with it, and bumps the version — the restore itself is
   * a save, so the old current lands in history and the rollback is never
   * destructive. Returns the new version, or null when the version is not in
   * history (or is the current document itself).
   */
  function restore(sessionId, version) {
    return withSessionLock(sessionId, async function () {
      const record = await load(sessionId)
      const target = record.history.find((e) => e.version === version)
      if (target === undefined || typeof target.html !== 'string' || target.html === '') {
        return null
      }
      const next = {
        version: record.version + 1,
        html: target.html,
        jobUrl: record.jobUrl,
        updatedAt: Date.now(),
        workspace: record.workspace,
        company: record.company,
        jobTitle: record.jobTitle,
        // A save answers whatever was pending: leaving the proposal up would
        // ask the user to decide again about text that no longer exists.
        proposal: null,
        letter: record.letter,
        history: [
          ...(record.version > 0
            ? [{ version: record.version, html: record.html, updatedAt: record.updatedAt }]
            : []),
          ...record.history,
        ].slice(0, KEEP_VERSIONS),
      }
      await persist(sessionId, next)
      remember(sessionId, next)
      await mirror(next)
      return next.version
    })
  }

  /**
   * Save the cover letter. Its own version line: the letter and the CV are
   * revised on different rhythms, and bumping the CV because a paragraph of
   * the letter changed would make the CV's history unreadable.
   */
  function saveLetter(sessionId, doc) {
    return withSessionLock(sessionId, async function () {
      const record = await load(sessionId)
      const letter = {
        version: (record.letter === null ? 0 : record.letter.version) + 1,
        html: String(doc.html),
        updatedAt: Date.now(),
      }
      const next = Object.assign({}, record, { letter: letter })
      await persist(sessionId, next)
      remember(sessionId, next)
      if (next.workspace !== '') {
        try {
          await mirrorCvVersion(next.workspace, letter.version, letter.html, 'letter')
        } catch (error) {
          console.warn(
            '[dsh-job-cv] could not mirror letter v' + letter.version + ': ' + String(error),
          )
        }
      }
      return letter.version
    })
  }

  /** Store a pending proposal (null clears it). Shares the write lock. */
  function setProposal(sessionId, proposal) {
    return withSessionLock(sessionId, async function () {
      const record = await load(sessionId)
      const next = Object.assign({}, record, { proposal: proposal })
      await persist(sessionId, next)
      remember(sessionId, next)
      return next.proposal
    })
  }

  /** The public projection (history bodies stay server-side). */
  async function get(sessionId) {
    const record = await load(sessionId)
    return {
      version: record.version,
      html: record.html,
      jobUrl: record.jobUrl,
      updatedAt: record.updatedAt,
      workspace: record.workspace,
      company: record.company,
      jobTitle: record.jobTitle,
      proposal: record.proposal,
      letter: record.letter,
      historyDepth: record.history.length,
    }
  }

  /**
   * The pickable versions, newest first (current, then its history). Bodies
   * are left out — the browser only needs the list to offer a rollback.
   */
  async function history(sessionId) {
    const record = await load(sessionId)
    const entries =
      record.version > 0 ? [{ version: record.version, updatedAt: record.updatedAt }] : []
    for (const e of record.history) entries.push({ version: e.version, updatedAt: e.updatedAt })
    return entries
  }

  return { load, save, saveLetter, get, setWorkspace, setProposal, restore, history }
}
