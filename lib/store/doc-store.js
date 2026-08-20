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
import { mirrorCvVersion, mirrorPostHtml, mirrorPostText, readPostText } from './workspace.js'
import { readProposal } from './proposal.js'
import { readFit } from './fit.js'
import { readBrief } from './post-brief.js'

const KEEP_VERSIONS = 10

/**
 * The job post, as text. Long enough for the wordiest posting and short
 * enough that a browser renders it without thinking about it; the agent's own
 * fetch pipeline caps its extraction well below this.
 */
const MAX_POST = 60000

/** A version note is a timeline label, not an essay. */
const MAX_NOTE = 200

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
    note: typeof value.note === 'string' ? value.note.slice(0, MAX_NOTE) : '',
  }
}

/** The job post text the preview shows, and where it came from. */
function readPost(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.text !== 'string' || value.text.trim() === '') return null
  const html =
    typeof value.html === 'string' && value.html.trim() !== '' ? value.html.slice(0, MAX_POST) : ''
  return {
    text: value.text.slice(0, MAX_POST),
    // 'you' when pasted in the preview, 'agent' when fetched for you: the
    // panel says which, because a post nobody checked is worth checking.
    source: value.source === 'you' ? 'you' : 'agent',
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    // The styled posting page, when the agent has built one.
    html: html,
    htmlUpdatedAt: html !== '' && Number.isFinite(value.htmlUpdatedAt) ? value.htmlUpdatedAt : 0,
  }
}

function emptyRecord() {
  return {
    proposal: null,
    fit: null,
    post: null,
    brief: null,
    letter: null,
    letterHistory: [],
    note: '',
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
    note: typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE) : '',
    proposal: readProposal(raw.proposal),
    fit: readFit(raw.fit),
    post: readPost(raw.post),
    brief: readBrief(raw.brief),
    letter: readLetter(raw.letter),
    letterHistory: (Array.isArray(raw.letterHistory) ? raw.letterHistory : [])
      .filter((e) => e !== null && typeof e === 'object')
      .slice(0, KEEP_VERSIONS),
    company: typeof raw.company === 'string' ? raw.company : '',
    jobTitle: typeof raw.jobTitle === 'string' ? raw.jobTitle : '',
    history: history.filter((e) => e !== null && typeof e === 'object').slice(0, KEEP_VERSIONS),
  }
}

export function createDocStore(rootDir) {
  const dir = join(rootDir, 'sessions')
  const cache = new Map()
  const locks = new Map()
  // Open SSE streams per session; a save pushes to each.
  const listeners = new Map()
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
   * Push a change to every open stream for this session. A subscriber's own
   * error must not break the save that triggered it.
   */
  function notify(sessionId) {
    const set = listeners.get(sessionId)
    if (!set) return
    for (const fn of set) {
      try {
        fn()
      } catch (e) {
        /* a dead stream cleans itself up on its own close event */
      }
    }
  }

  /** Watch a session for changes; returns the unsubscribe. */
  function subscribe(sessionId, fn) {
    let set = listeners.get(sessionId)
    if (!set) {
      set = new Set()
      listeners.set(sessionId, set)
    }
    set.add(fn)
    return function unsubscribe() {
      set.delete(fn)
      if (set.size === 0) listeners.delete(sessionId)
    }
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
        // What changed, in the author's words. Without it a timeline is a
        // column of timestamps and the user has to open each one to remember.
        note: typeof doc.note === 'string' ? doc.note.slice(0, MAX_NOTE) : '',
        workspace: record.workspace,
        company: record.company,
        jobTitle: record.jobTitle,
        // A save answers whatever was pending: leaving the proposal up would
        // ask the user to decide again about text that no longer exists.
        proposal: null,
        // The fit is NOT cleared. It is now a score of the previous version,
        // which is worth saying — the panel marks it stale against the new
        // one — where a blank panel would just look like nothing happened.
        fit: record.fit,
        post: record.post,
        brief: record.brief,
        letter: record.letter,
        letterHistory: record.letterHistory,
        history: [
          ...(record.version > 0
            ? [
                {
                  version: record.version,
                  html: record.html,
                  updatedAt: record.updatedAt,
                  note: record.note,
                },
              ]
            : []),
          ...record.history,
        ].slice(0, KEEP_VERSIONS),
      }
      // Cache only after the bytes land, so a failed write never leaves the
      // cache claiming a version that is not on disk.
      await persist(sessionId, next)
      remember(sessionId, next)
      notify(sessionId)
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
      notify(sessionId)
      // A workspace opened AFTER some saves would otherwise start empty
      // and only fill from the next save onward.
      await mirror(next)
      if (next.post !== null) {
        try {
          await mirrorPostText(next.workspace, next.post.text)
        } catch {
          // the folder is a convenience; the record is the source of truth
        }
      }
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
        note: 'Restored v' + String(version),
        workspace: record.workspace,
        company: record.company,
        jobTitle: record.jobTitle,
        // A save answers whatever was pending: leaving the proposal up would
        // ask the user to decide again about text that no longer exists.
        proposal: null,
        fit: record.fit,
        post: record.post,
        brief: record.brief,
        letter: record.letter,
        letterHistory: record.letterHistory,
        history: [
          ...(record.version > 0
            ? [
                {
                  version: record.version,
                  html: record.html,
                  updatedAt: record.updatedAt,
                  note: record.note,
                },
              ]
            : []),
          ...record.history,
        ].slice(0, KEEP_VERSIONS),
      }
      await persist(sessionId, next)
      remember(sessionId, next)
      notify(sessionId)
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
        // Same label as a CV save: a timeline of timestamps tells you nothing
        // about which paragraph you are trying to get back to.
        note: typeof doc.note === 'string' ? doc.note.slice(0, MAX_NOTE) : '',
      }
      const next = Object.assign({}, record, {
        letter: letter,
        letterHistory: [
          ...(record.letter === null ? [] : [record.letter]),
          ...record.letterHistory,
        ].slice(0, KEEP_VERSIONS),
      })
      await persist(sessionId, next)
      remember(sessionId, next)
      notify(sessionId)
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

  /**
   * Store the fit assessment (null clears it). Shares the write lock so a
   * score cannot race a save into a lost update.
   */
  function setFit(sessionId, fit) {
    return withSessionLock(sessionId, async function () {
      const record = await load(sessionId)
      const next = Object.assign({}, record, { fit: fit })
      await persist(sessionId, next)
      remember(sessionId, next)
      notify(sessionId)
      return next.fit
    })
  }

  /**
   * Store the job post text, and mirror it into the candidacy folder so the
   * application still reads as one when the posting is taken down.
   */
  function setPost(sessionId, text, source, html) {
    return withSessionLock(sessionId, async function () {
      const record = await load(sessionId)
      const body = String(text).slice(0, MAX_POST)
      // The stored text is what the brief was built from and what everything
      // else is written against, so updatedAt is about the TEXT. Re-storing
      // the same words — the agent attaching a page it has just built, or the
      // user editing that page by hand — must not mark the brief stale for a
      // posting that has not changed a character.
      const unchanged = record.post !== null && record.post.text === body
      const post =
        body.trim() === ''
          ? null
          : {
              text: body,
              source: source === 'you' ? 'you' : 'agent',
              updatedAt: unchanged ? record.post.updatedAt : Date.now(),
              // The styled page rides with the text it renders: a page of a
              // post that is no longer stored would be showing a ghost.
              html: typeof html === 'string' && html.trim() !== '' ? html.slice(0, MAX_POST) : '',
              htmlUpdatedAt: typeof html === 'string' && html.trim() !== '' ? Date.now() : 0,
            }
      const next = Object.assign({}, record, { post: post })
      await persist(sessionId, next)
      remember(sessionId, next)
      notify(sessionId)
      if (post !== null && next.workspace !== '') {
        try {
          await mirrorPostText(next.workspace, post.text)
          if (post.html !== '') await mirrorPostHtml(next.workspace, post.html)
        } catch (error) {
          console.warn(
            '[dsh-job-cv] could not mirror the job post into ' +
              next.workspace +
              ': ' +
              String(error && error.message ? error.message : error),
          )
        }
      }
      return post
    })
  }

  /**
   * The job post text. Falls back to the candidacy folder: the contract has
   * always told the agent to save the fetched post there, so a session that
   * ran before this route existed still has one to show.
   */
  async function getPost(sessionId) {
    const record = await load(sessionId)
    if (record.post !== null) return record.post
    const text = await readPostText(record.workspace)
    return text.trim() === ''
      ? null
      : { text: text.slice(0, MAX_POST), source: 'agent', updatedAt: 0 }
  }

  /** The post brief body; it has its own route, off the poll's payload. */
  async function getBrief(sessionId) {
    const record = await load(sessionId)
    return record.brief
  }

  /** Store the post brief (null clears it). Shares the write lock. */
  function setBrief(sessionId, brief) {
    return withSessionLock(sessionId, async function () {
      const record = await load(sessionId)
      const next = Object.assign({}, record, { brief: brief })
      await persist(sessionId, next)
      remember(sessionId, next)
      notify(sessionId)
      return next.brief
    })
  }

  /** Store a pending proposal (null clears it). Shares the write lock. */
  function setProposal(sessionId, proposal) {
    return withSessionLock(sessionId, async function () {
      const record = await load(sessionId)
      const next = Object.assign({}, record, { proposal: proposal })
      await persist(sessionId, next)
      remember(sessionId, next)
      notify(sessionId)
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
      fit: record.fit,
      letter: record.letter,
      note: record.note,
      // A marker, not the text: this projection goes out on every save, to
      // every open stream, and a job post is thousands of characters. The preview fetches the body
      // from /jobcv/post when it needs it, and refetches when this moves.
      postChars: record.post === null ? 0 : record.post.text.length,
      postUpdatedAt: record.post === null ? 0 : record.post.updatedAt,
      postSource: record.post === null ? '' : record.post.source,
      postHtmlUpdatedAt: record.post === null ? 0 : record.post.htmlUpdatedAt,
      // Same marker idea as the post: the brief body lives on its own route.
      briefUpdatedAt: record.brief === null ? 0 : record.brief.updatedAt,
      historyDepth: record.history.length,
    }
  }

  /**
   * The pickable versions, newest first (current, then its history). Bodies
   * are left out — the browser only needs the list to offer a rollback.
   */
  /**
   * One version's body, for looking at it before deciding to restore.
   * The list deliberately omits bodies — ten CVs is a lot of payload to send
   * every poll — so a reader asks for exactly the one it wants to show.
   */
  async function versionHtml(sessionId, version, kind) {
    const record = await load(sessionId)
    if (kind === 'letter') {
      if (record.letter !== null && record.letter.version === version) return record.letter.html
      const past = record.letterHistory.find((e) => e.version === version)
      return past !== undefined && typeof past.html === 'string' && past.html !== ''
        ? past.html
        : null
    }
    if (record.version === version && record.html !== '') return record.html
    const found = record.history.find((e) => e.version === version)
    return found !== undefined && typeof found.html === 'string' && found.html !== ''
      ? found.html
      : null
  }

  async function history(sessionId, kind) {
    const record = await load(sessionId)
    const entries = []
    if (kind === 'letter') {
      if (record.letter !== null) {
        entries.push({
          version: record.letter.version,
          updatedAt: record.letter.updatedAt,
          note: typeof record.letter.note === 'string' ? record.letter.note : '',
        })
      }
      for (const e of record.letterHistory) {
        entries.push({
          version: e.version,
          updatedAt: e.updatedAt,
          note: typeof e.note === 'string' ? e.note : '',
        })
      }
      return entries
    }
    if (record.version > 0) {
      entries.push({ version: record.version, updatedAt: record.updatedAt, note: record.note })
    }
    for (const e of record.history) {
      entries.push({
        version: e.version,
        updatedAt: e.updatedAt,
        note: typeof e.note === 'string' ? e.note : '',
      })
    }
    return entries
  }

  /**
   * Roll the cover letter back. Like the CV's restore this saves FORWARD —
   * the rollback becomes the newest letter version — so going back is never
   * how a draft gets lost. Returns the new version, or null when that version
   * is not in the letter's history.
   */
  function restoreLetter(sessionId, version) {
    return withSessionLock(sessionId, async function () {
      const record = await load(sessionId)
      const target = record.letterHistory.find((e) => e.version === version)
      if (target === undefined || typeof target.html !== 'string' || target.html === '') return null
      const letter = {
        version: (record.letter === null ? 0 : record.letter.version) + 1,
        html: target.html,
        updatedAt: Date.now(),
        note: 'Restored letter v' + String(version),
      }
      const next = Object.assign({}, record, {
        letter: letter,
        letterHistory: [
          ...(record.letter === null ? [] : [record.letter]),
          ...record.letterHistory,
        ].slice(0, KEEP_VERSIONS),
      })
      await persist(sessionId, next)
      remember(sessionId, next)
      notify(sessionId)
      if (next.workspace !== '') {
        try {
          await mirrorCvVersion(next.workspace, letter.version, letter.html, 'letter')
        } catch {
          // the folder is a convenience; the record is the source of truth
        }
      }
      return letter.version
    })
  }

  return {
    load,
    save,
    saveLetter,
    get,
    getPost,
    getBrief,
    setWorkspace,
    setProposal,
    setFit,
    setPost,
    setBrief,
    restore,
    restoreLetter,
    history,
    versionHtml,
    subscribe,
  }
}
