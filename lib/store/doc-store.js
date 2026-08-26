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
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  normalizeUrl as normalizeJobUrl,
  urlMatchKey,
  MAX_JOBS as MAX_LIST_JOBS,
} from './joblist.js'
import {
  latestCvFile,
  mirrorCvVersion,
  mirrorPostHtml,
  mirrorPostText,
  readPostText,
} from './workspace.js'
import { createMasterStore } from './master.js'
import { diffBlocks, htmlBlocks, summarizeDiff } from './cv-diff.js'
import { readProposal } from './proposal.js'
import { readFit } from './fit.js'
import { readBrief } from './post-brief.js'
import {
  normalizeApplication,
  applyStatusChange,
  readApplicationStatus,
  writeApplicationStatus,
  newerApplication,
  isValidStatus,
  DEFAULT_STATUS,
} from './applications.js'

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

/** How many past-application CVs the onboarding pick list offers at once. */
const RECENT_CV_LIMIT = 8

/** How many applications the tracker lists at once. */
const MAX_APPLICATIONS = 200

/**
 * Several jobs can share one session (the Jobs panel switches them). The
 * session file holds whichever candidacy is ACTIVE; the others live in
 * per-job archive files beside it, and switching swaps the two. Archives
 * keep every version line, the letter, the post and the status tag, so a
 * job put down on Tuesday resumes exactly where it was left on Friday.
 */
const ARCHIVE_SUFFIX = '.jobs'

/**
 * A stable key for one posting. Its URL is the identity everywhere else in
 * the plugin (the switch route takes a jobUrl), but URLs reach this store in
 * many spellings — trailing slash, #fragment, tracking dust, a `?ref=` an
 * ATS added, copy-paste whitespace — and the pick list already dedupes
 * them. The key must agree with that dedupe, or the same posting becomes
 * two candidacies that share one workspace folder and clobber each other's
 * mirrored cv/v1.html. So every URL-derived key runs on the MATCHING form:
 * generous about anything that does not change which posting it is.
 */
function keyOf(basis) {
  const raw = String(basis === undefined || basis === null ? '' : basis)
  return raw === '' ? null : createHash('sha1').update(raw).digest('hex').slice(0, 16)
}

function urlKey(jobUrl) {
  return keyOf(urlMatchKey(jobUrl))
}

function jobKeyOf(record) {
  if (
    record !== null &&
    typeof record === 'object' &&
    typeof record.jobUrl === 'string' &&
    normalizeJobUrl(record.jobUrl) !== ''
  ) {
    return urlKey(record.jobUrl)
  }
  // No usable URL: a record is still addressable by its folder.
  return keyOf((record && record.workspace) || '')
}

/** Whether a record holds anything worth archiving before a switch. */
function hasContent(record) {
  return (
    (record.version > 0 && record.html !== '') ||
    record.letter !== null ||
    record.post !== null ||
    record.brief !== null ||
    record.workspace !== ''
  )
}

/** Atomic JSON write: a UNIQUE temp file then rename. */
async function writeJsonAtomic(target, value) {
  const tmp = target + '.tmp-' + randomUUID()
  try {
    await writeFile(tmp, JSON.stringify(value), 'utf8')
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

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
    application: null,
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
    application: normalizeApplication(raw.application),
    company: typeof raw.company === 'string' ? raw.company : '',
    jobTitle: typeof raw.jobTitle === 'string' ? raw.jobTitle : '',
    history: history.filter((e) => e !== null && typeof e === 'object').slice(0, KEEP_VERSIONS),
  }
}

export function createDocStore(rootDir) {
  const dir = join(rootDir, 'sessions')
  const cache = new Map()
  const locks = new Map()
  // The one master CV, beside every session record (see ./master.js). It is
  // not per-session — one person, one source of truth, many applications —
  // so it lives in its own file and store under the same root.
  const masters = createMasterStore(rootDir)
  // A corrupt master.json would otherwise re-warn on every poll tick: the
  // markers are read on each projection, the warning is worth exactly once.
  let masterWarned = false
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

  /** Where a session's archived candidacies live. */
  function archiveDirFor(sessionId) {
    return join(dir, sessionId + ARCHIVE_SUFFIX)
  }

  function archiveFileFor(sessionId, key) {
    return join(archiveDirFor(sessionId), key + '.json')
  }

  /** The session's stored jobs list (the markdown pick list), if any. */
  function jobListFileFor(sessionId) {
    return join(dir, 'lists', sessionId + '.json')
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
    await writeJsonAtomic(fileFor(sessionId), record)
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
        // The tag is not a document: a save neither reads nor moves it.
        application: record.application,
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
        // The tag is not a document: a restore neither reads nor moves it.
        application: record.application,
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

  /**
   * Record where this application stands — the USER's report (applied,
   * interview, rejected...), carried verbatim with its date and note.
   * Shares the write lock with every other writer and mirrors the tag into
   * the candidacy folder as status.json, so a second session on the same
   * application — and anyone opening the folder outside the harness — sees
   * the same state.
   *
   * With several applications sharing one session (the Jobs panel switches
   * them), a tag names its job: a jobUrl that is not the active candidacy's
   * is routed into that job's archived record instead — retagging a row can
   * never move the status of whichever application happens to be on screen.
   */
  function setApplication(sessionId, decision) {
    return withSessionLock(sessionId, async function () {
      const status = decision && typeof decision.status === 'string' ? decision.status : ''
      if (!isValidStatus(status)) {
        throw new Error('unknown application status: ' + JSON.stringify(status))
      }
      const wantedUrl =
        decision && typeof decision.jobUrl === 'string' ? decision.jobUrl.trim() : ''
      const wantedKey = wantedUrl !== '' ? urlKey(wantedUrl) : null
      const record = await load(sessionId)

      // A tag for a job that is not active lands in its own archived record.
      if (wantedKey !== null && wantedKey !== jobKeyOf(record)) {
        const archived = await loadArchive(sessionId, wantedKey)
        if (archived === null) {
          throw new Error('that application is not worked on in this session')
        }
        const nextApplication = applyStatusChange(archived.application, decision, Date.now())
        if (nextApplication === archived.application) return nextApplication // a no-op must not bump anything
        const stored = nextApplication.status === DEFAULT_STATUS ? null : nextApplication
        const updated = Object.assign({}, archived, { application: stored })
        await writeJsonAtomic(archiveFileFor(sessionId, wantedKey), updated)
        if (updated.workspace !== '') {
          try {
            await writeApplicationStatus(updated.workspace, nextApplication)
          } catch (error) {
            console.warn(
              '[dsh-job-cv] could not mirror the application status into ' +
                updated.workspace +
                ': ' +
                String(error && error.message ? error.message : error),
            )
          }
        }
        return nextApplication
      }

      const next = applyStatusChange(record.application, decision, Date.now())
      if (next === record.application) return record.application // a no-op must not bump anything
      // No explicit tag IS drafting: nothing is kept on the record. The
      // mirror still records the reset, though — skipping it would leave the
      // folder's older tag as the newest opinion and resurrect it on the
      // next listing.
      const stored = next.status === DEFAULT_STATUS ? null : next
      const updated = Object.assign({}, record, { application: stored })
      await persist(sessionId, updated)
      remember(sessionId, updated)
      notify(sessionId)
      if (updated.workspace !== '') {
        try {
          await writeApplicationStatus(updated.workspace, next)
        } catch (error) {
          console.warn(
            '[dsh-job-cv] could not mirror the application status into ' +
              updated.workspace +
              ': ' +
              String(error && error.message ? error.message : error),
          )
        }
      }
      return next
    })
  }

  /** The public projection (history bodies stay server-side). */
  async function get(sessionId) {
    const record = await load(sessionId)
    // Master markers, the same pattern as the post's: whether a master CV
    // exists and which version it is on, never its body. A master save
    // pushes a frame carrying these, so an open preview grows (or updates)
    // its "vs master" affordance without a reload.
    let masterVersion = 0
    let masterUpdatedAt = 0
    try {
      const masterMeta = await masters.load()
      if (masterMeta.version > 0 && masterMeta.html !== '') {
        masterVersion = masterMeta.version
        masterUpdatedAt = masterMeta.updatedAt
      }
    } catch (error) {
      if (!masterWarned) {
        masterWarned = true
        console.warn('[dsh-job-cv] ' + String(error && error.message ? error.message : error))
      }
    }
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
      // Where this application stands ('' = drafting). Markers only — the log
      // and note belong to the applications listing, not to every pushed frame.
      status: record.application === null ? '' : record.application.status,
      statusUpdatedAt: record.application === null ? 0 : record.application.statusUpdatedAt,
      appliedAt:
        record.application === null || !record.application.appliedAt
          ? 0
          : record.application.appliedAt,
      masterVersion: masterVersion,
      masterUpdatedAt: masterUpdatedAt,
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
    // The master's timeline lives outside the session records entirely.
    if (kind === 'master') return masters.versionHtml(version)
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
    // The master's own timeline: same shape, different store. The session id
    // is irrelevant to it — one user, one master — but the route keeps its
    // ?session= contract so every caller reads the same way.
    if (kind === 'master') {
      const masterMeta = await masters.load()
      if (masterMeta.version > 0) {
        entries.push({
          version: masterMeta.version,
          updatedAt: masterMeta.updatedAt,
          note: typeof masterMeta.note === 'string' ? masterMeta.note : '',
        })
      }
      for (const e of masterMeta.history) {
        entries.push({ version: e.version, updatedAt: e.updatedAt, note: e.note })
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

  // ---- the master CV: the source of truth every application tailors from ----

  /**
   * Save the master. Its own version line, exactly like the letter's — the
   * master and any tailored CV are revised on different rhythms, and folding
   * an improvement back must not bump a candidacy the fold never touched.
   * The sessionId only routes the notification: an open preview learns the
   * master moved through the same push a document save uses.
   */
  function saveMaster(sessionId, doc) {
    return masters.save(doc).then(function (version) {
      if (sessionId) notify(sessionId)
      return version
    })
  }

  /** The master record, empty shell when none exists yet. */
  async function getMaster() {
    return masters.load()
  }

  /** Roll the master back to an earlier version — saves forward, like the CV. */
  async function restoreMaster(version) {
    const html = await masters.versionHtml(version)
    if (html === null) return null
    return masters.save({ html: html, note: 'Restored master v' + String(version) })
  }

  /** Ensure `<root>/master/cv/latest.html` exists; markers for the pick list. */
  function masterMirror(root) {
    return masters.mirrorInto(root)
  }

  /**
   * What the active document changed against the master CV.
   *
   * Mechanical host-side work (see ./cv-diff.js): normalize both documents
   * to text blocks and diff them, then hand back counts plus ONLY the change
   * entries. This is the compact view that makes several applications cheap
   * to reason about at once — a delta is the tailored part alone, however
   * many candidacies pile up — and it is what the preview's "vs master"
   * panel renders.
   */
  async function deltaVsMaster(sessionId, kind) {
    const record = await load(sessionId)
    const master = await masters.load()
    const base = {
      ok: true,
      kind: kind === 'letter' ? 'letter' : 'cv',
      masterVersion: master.version,
      masterUpdatedAt: master.updatedAt,
    }
    if (master.version < 1 || master.html === '') {
      return Object.assign(base, {
        empty: 'no-master',
        targetVersion: 0,
        added: 0,
        removed: 0,
        same: 0,
        changes: [],
        truncated: false,
      })
    }
    const targetVersion =
      kind === 'letter' ? (record.letter === null ? 0 : record.letter.version) : record.version
    const html =
      kind === 'letter' ? (record.letter === null ? '' : record.letter.html) : record.html
    if (!html || targetVersion < 1) {
      return Object.assign(base, {
        empty: 'no-document',
        targetVersion: targetVersion,
        added: 0,
        removed: 0,
        same: 0,
        changes: [],
        truncated: false,
      })
    }
    // Master is BEFORE, the tailored document AFTER: additions are what this
    // application gained, removals are what tailoring left out.
    const summary = summarizeDiff(diffBlocks(htmlBlocks(master.html), htmlBlocks(html)))
    return Object.assign(base, {
      targetVersion: targetVersion,
      added: summary.added,
      removed: summary.removed,
      same: summary.same,
      changes: summary.changes,
      truncated: summary.truncated,
    })
  }

  /**
   * The latest CV of every past application, newest first — what the
   * onboarding start form offers before asking for a file.
   *
   * One entry per candidacy FOLDER, not per session: two sessions that
   * opened the same application are one CV to choose from. The entry points
   * at the mirrored <workspace>/cv/latest.html, so picking one hands the
   * agent a file that is on disk right now — which is also why entries whose
   * mirror has vanished (folder moved or deleted) drop out instead of
   * wasting the application's first message on a dead path.
   *
   * Session records arrive through everyRecord(): a session's own ACTIVE
   * document is excluded (onboarding is where version 0 lives, so it could
   * never be worth offering), while its ARCHIVED candidacies count as past
   * work exactly like another session's. Nothing touches the read cache:
   * an onboarding glance must not evict live sessions.
   */
  async function listRecentCvs(excludeSessionId) {
    const excluded = typeof excludeSessionId === 'string' ? excludeSessionId : ''
    const byWorkspace = new Map()
    for await (const item of everyRecord()) {
      if (!item.isArchive && item.sessionId === excluded) continue
      const record = item.record
      const sessionId = item.sessionId
      if (record.version < 1 || record.html === '' || record.workspace === '') continue
      const kept = byWorkspace.get(record.workspace)
      if (kept !== undefined && kept.updatedAt >= record.updatedAt) continue
      byWorkspace.set(record.workspace, {
        sessionId: sessionId,
        workspace: record.workspace,
        company: record.company,
        jobTitle: record.jobTitle,
        jobUrl: record.jobUrl,
        version: record.version,
        updatedAt: record.updatedAt,
      })
    }
    const list = []
    for (const item of byWorkspace.values()) {
      const file = latestCvFile(item.workspace)
      try {
        await stat(file)
      } catch {
        continue // the candidacy folder is gone; the store outlived it
      }
      item.path = file
      list.push(item)
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    return list.slice(0, RECENT_CV_LIMIT)
  }

  /**
   * Every application this plugin has worked on, one row per candidacy,
   * newest activity first — the tracker's data.
   *
   * Rows are APPLICATIONS, not sessions: two sessions that opened the same
   * folder are one row whose documents are the per-document maximum across
   * those records (the newest CV version, the newest letter, the newest
   * post), because that is what "the latest" means to someone scanning
   * their search. A session that never opened a folder stands alone under
   * its id, so a draft is never silently missing from the list.
   *
   * Like listRecentCvs, records arrive through everyRecord() — including a
   * session's ARCHIVED candidacies, which are applications like any other;
   * a listing degrades over unreadable records instead of raising, and a
   * scan must not evict live sessions from the read cache.
   */
  async function listApplications() {
    const byKey = new Map()
    for await (const item of everyRecord()) {
      const sessionId = item.sessionId
      const record = item.record
      const hasSomething =
        (record.version > 0 && record.html !== '') ||
        record.letter !== null ||
        record.post !== null ||
        record.brief !== null ||
        record.workspace !== ''
      if (!hasSomething) continue // a session that never got anywhere
      const key = record.workspace !== '' ? 'ws:' + record.workspace : 'session:' + sessionId
      const activity = Math.max(
        record.updatedAt || 0,
        record.letter === null ? 0 : record.letter.updatedAt || 0,
        record.post === null ? 0 : record.post.updatedAt || 0,
        record.fit === null ? 0 : record.fit.updatedAt || 0,
        record.application === null ? 0 : record.application.statusUpdatedAt || 0,
      )
      let row = byKey.get(key)
      if (row === undefined) {
        byKey.set(key, {
          sessionId: sessionId,
          workspace: record.workspace,
          company: '',
          jobTitle: '',
          jobUrl: '',
          cvVersion: 0,
          cvUpdatedAt: 0,
          cvNote: '',
          letterVersion: 0,
          letterUpdatedAt: 0,
          postChars: 0,
          postUpdatedAt: 0,
          fitScore: null,
          fitUpdatedAt: 0,
          activity: -1,
          application: null,
        })
        row = byKey.get(key)
      }
      // Per-document maxima across every session of this application.
      if (record.version > 0 && record.html !== '' && record.version > row.cvVersion) {
        row.cvVersion = record.version
        row.cvUpdatedAt = record.updatedAt
        row.cvNote = record.note
      }
      if (record.letter !== null && record.letter.version > row.letterVersion) {
        row.letterVersion = record.letter.version
        row.letterUpdatedAt = record.letter.updatedAt
      }
      if (record.post !== null && (record.post.updatedAt || 0) >= row.postUpdatedAt) {
        row.postChars = record.post.text.length
        row.postUpdatedAt = record.post.updatedAt || 0
      }
      if (record.fit !== null && (record.fit.updatedAt || 0) >= row.fitUpdatedAt) {
        row.fitScore = typeof record.fit.score === 'number' ? record.fit.score : null
        row.fitUpdatedAt = record.fit.updatedAt || 0
      }
      // The most recently touched session owns the row's identity AND its
      // metadata — readdir order must never decide what a row says. Older
      // records only fill in what the newer ones left blank.
      if (activity >= row.activity) {
        row.activity = activity
        row.sessionId = sessionId
        if ((record.company || '') !== '') row.company = record.company
        if ((record.jobTitle || '') !== '') row.jobTitle = record.jobTitle
        if ((record.jobUrl || '') !== '') row.jobUrl = record.jobUrl
      } else {
        if ((row.company || '') === '' && (record.company || '') !== '') {
          row.company = record.company
        }
        if ((row.jobTitle || '') === '' && (record.jobTitle || '') !== '') {
          row.jobTitle = record.jobTitle
        }
        if ((row.jobUrl || '') === '' && (record.jobUrl || '') !== '') {
          row.jobUrl = record.jobUrl
        }
      }
      row.application = newerApplication(row.application, record.application)
    }
    const rows = []
    for (const row of byKey.values()) {
      // The folder's mirrored copy can be newer than any session record — a
      // hand edit to status.json, or a tag set from another machine — and
      // then the folder wins.
      const fromFolder = await readApplicationStatus(row.workspace)
      row.application = newerApplication(row.application, fromFolder)
      // A tag set anywhere — another session, another machine, by hand — is
      // activity too: the row rises with it, because "what moved last" is
      // exactly what someone scanning their search wants on top.
      if (
        row.application !== null &&
        Number.isFinite(row.application.statusUpdatedAt) &&
        row.application.statusUpdatedAt > row.activity
      ) {
        row.activity = row.application.statusUpdatedAt
      }
      rows.push(row)
    }
    rows.sort((a, b) => b.activity - a.activity)
    return rows.slice(0, MAX_APPLICATIONS)
  }

  /**
   * Every stored record: each session's ACTIVE file plus every archived
   * candidacy under its <id>.jobs/ directory. The listings (past CVs,
   * applications) treat an archived job exactly like a past application of
   * any other session — archiving only means "not on screen right now".
   *
   * Records are read leniently here rather than through load(): a listing
   * degrades over an unreadable file instead of raising, and a scan must
   * not evict live sessions from the read cache.
   */
  async function* everyRecord() {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // no sessions directory yet — nothing has ever been saved
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const sessionId = entry.name.slice(0, -'.json'.length)
        const record = await readRecordLenient(fileFor(sessionId))
        if (record !== null) yield { sessionId: sessionId, isArchive: false, record: record }
        continue
      }
      if (!entry.isDirectory() || !entry.name.endsWith(ARCHIVE_SUFFIX)) continue
      const sessionId = entry.name.slice(0, -ARCHIVE_SUFFIX.length)
      let inner
      try {
        inner = await readdir(archiveDirFor(sessionId), { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of inner) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        const record = await readRecordLenient(join(archiveDirFor(sessionId), file.name))
        if (record !== null) {
          yield { sessionId: sessionId, isArchive: true, record: record }
        }
      }
    }
  }

  async function readRecordLenient(file) {
    try {
      return normalizeRecord(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      return null
    }
  }

  /** Write the active record into its per-job archive file. */
  async function archiveActive(sessionId, record) {
    const key = jobKeyOf(record)
    if (key === null) return null
    await mkdir(archiveDirFor(sessionId), { recursive: true })
    await writeJsonAtomic(archiveFileFor(sessionId, key), record)
    return key
  }

  /**
   * One archived candidacy. A MISSING file is "never worked on in this
   * session" (null); a file that exists but cannot be parsed raises —
   * switching must never look like a fresh start while the real history
   * sits unreadable on disk. The same reasoning as load(), one level down.
   */
  async function loadArchive(sessionId, key) {
    try {
      return normalizeRecord(JSON.parse(await readFile(archiveFileFor(sessionId, key), 'utf8')))
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw new Error(
        'an archived candidacy of this session is unreadable (' +
          archiveFileFor(sessionId, key) +
          '); move that file aside to recover',
      )
    }
  }

  /**
   * Make another posting this session's ACTIVE candidacy.
   *
   * The outgoing record is parked in its archive FIRST — even if loading the
   * incoming one then fails, nothing has been lost. An empty active record
   * (a session still sitting on its onboarding form) archives nothing.
   * Switching to the posting that is already active never archives anything
   * either: at most the identity fields are refreshed. The returned
   * `resumed` says whether earlier work came back with the job.
   */
  function switchCandidacy(sessionId, target) {
    return withSessionLock(sessionId, async function () {
      const t = target !== null && typeof target === 'object' ? target : {}
      const url = String(t.jobUrl === undefined || t.jobUrl === null ? '' : t.jobUrl).trim()
      if (url === '') throw new Error('switch needs a jobUrl')
      // One posting, one key — however it was spelled this time. The
      // normalized form is also what gets STORED, so a later switch spelled
      // differently still lands on this same candidacy.
      const toKey = urlKey(url)
      const storedUrl = normalizeJobUrl(url)
      const current = await load(sessionId)
      const fromKey = jobKeyOf(current)

      if (fromKey !== null && fromKey !== toKey) await archiveActive(sessionId, current)

      let base
      let resumed
      if (fromKey === toKey) {
        base = current
        resumed = hasContent(current)
      } else {
        const archived = await loadArchive(sessionId, toKey)
        resumed = archived !== null && hasContent(archived)
        base = archived !== null ? archived : emptyRecord()
        if (archived !== null) {
          // Promoted to active: drop its now-stale archive, or this session
          // would list the same candidacy twice. Best-effort — a file that
          // refuses to leave only makes a duplicate row, never data loss.
          await rm(archiveFileFor(sessionId, toKey), { force: true }).catch(function () {})
        }
      }
      const pickString = function (given, fallback) {
        const text = typeof given === 'string' ? given.trim() : ''
        return text !== '' ? text : fallback
      }
      const next = Object.assign({}, base, {
        // First canonical spelling wins: a later paste of the SAME posting
        // (dusted with ?utm or ?ref variants) must not degrade a link the
        // folder's README and the candidacies roster already point at.
        jobUrl: pickString(base.jobUrl, storedUrl),
        company: pickString(t.company, base.company),
        jobTitle: pickString(t.jobTitle, base.jobTitle),
      })
      await persist(sessionId, next)
      remember(sessionId, next)
      notify(sessionId)
      return {
        resumed: resumed,
        version: next.version,
        company: next.company,
        jobTitle: next.jobTitle,
        jobUrl: next.jobUrl,
        workspace: next.workspace,
      }
    })
  }

  /** One row of the candidacies roster — markers only, no document bodies. */
  function candidacyRow(record, isActive) {
    return {
      key: jobKeyOf(record) || '',
      active: isActive === true,
      started: hasContent(record),
      company: record.company,
      jobTitle: record.jobTitle,
      jobUrl: record.jobUrl,
      workspace: record.workspace,
      version: record.version,
      letterVersion: record.letter === null ? 0 : record.letter.version,
      fitScore: record.fit !== null && Number.isFinite(record.fit.score) ? record.fit.score : null,
      status:
        record.application === null || !record.application.status ? '' : record.application.status,
      activity: Math.max(
        record.updatedAt || 0,
        record.letter === null ? 0 : record.letter.updatedAt || 0,
        record.post === null ? 0 : record.post.updatedAt || 0,
        record.application === null || !Number.isFinite(record.application.statusUpdatedAt)
          ? 0
          : record.application.statusUpdatedAt,
      ),
    }
  }

  /**
   * This session's candidacies: whichever is ACTIVE first, then its
   * archives, most recent activity first. The Jobs panel reads this to know
   * which lines of the pick list are starts and which are resumes.
   */
  async function listCandidacies(sessionId) {
    const rows = [candidacyRow(await load(sessionId), true)]
    let entries
    try {
      entries = await readdir(archiveDirFor(sessionId), { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const record = normalizeRecord(
          JSON.parse(await readFile(join(archiveDirFor(sessionId), entry.name), 'utf8')),
        )
        rows.push(candidacyRow(record, false))
      } catch {
        /* an unreadable archive just does not list */
      }
    }
    rows.sort(function (a, b) {
      return (b.active === true) - (a.active === true) || b.activity - a.activity
    })
    return rows.slice(0, MAX_APPLICATIONS)
  }

  function emptyJobList() {
    return { path: '', cvPath: '', updatedAt: 0, jobs: [] }
  }

  /** Coerce whatever the sidecar held into a well-formed pick list. */
  function normalizeJobList(parsed) {
    const raw =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    const seen = new Set()
    const jobs = []
    const list = Array.isArray(raw.jobs) ? raw.jobs : []
    for (const item of list) {
      if (jobs.length >= MAX_LIST_JOBS) break
      const url =
        item !== null && typeof item === 'object' && typeof item.url === 'string'
          ? item.url.trim()
          : ''
      if (!/^https?:\/\//i.test(url)) continue
      const key = normalizeJobUrl(url)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      jobs.push({
        title: item && typeof item.title === 'string' ? item.title : '',
        company: item && typeof item.company === 'string' ? item.company : '',
        url: url,
      })
    }
    return {
      path: typeof raw.path === 'string' ? raw.path : '',
      cvPath: typeof raw.cvPath === 'string' ? raw.cvPath : '',
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      jobs: jobs,
    }
  }

  /**
   * The session's stored pick list. A corrupt sidecar degrades to the empty
   * shape rather than raising: unlike a session document, nothing irreplaceable
   * lives here — reading the markdown again rebuilds it.
   */
  async function getJobList(sessionId) {
    try {
      return normalizeJobList(JSON.parse(await readFile(jobListFileFor(sessionId), 'utf8')))
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) {
        console.warn('[dsh-job-cv] the stored jobs list is unreadable; starting it fresh')
      }
      return emptyJobList()
    }
  }

  /** Store the pick list wholesale (path, default CV, parsed jobs). */
  async function setJobList(sessionId, data) {
    const normalized = normalizeJobList(Object.assign({ updatedAt: Date.now() }, data))
    await mkdir(join(dir, 'lists'), { recursive: true })
    await writeJsonAtomic(jobListFileFor(sessionId), normalized)
    return normalized
  }

  return {
    load,
    save,
    saveLetter,
    saveMaster,
    getMaster,
    restoreMaster,
    masterMirror,
    deltaVsMaster,
    get,
    getPost,
    getBrief,
    setWorkspace,
    setProposal,
    setFit,
    setPost,
    setBrief,
    setApplication,
    restore,
    restoreLetter,
    history,
    versionHtml,
    listRecentCvs,
    listApplications,
    switchCandidacy,
    listCandidacies,
    getJobList,
    setJobList,
    subscribe,
  }
}
