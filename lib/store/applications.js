/**
 * Application tracking: where a candidacy stands in the hiring process.
 *
 * A status is the USER'S report about their own life — "I applied on
 * Tuesday", "they rejected me", "first interview Friday" — so it is stored
 * verbatim with its date and never inferred by the host. Five tags cover
 * the pipeline; anything richer belongs in the note.
 *
 * The record is written in two places. The session file holds it like every
 * other field, and the candidacy folder mirrors it as status.json so the
 * tag survives outside the harness, is visible to two sessions working the
 * same application, and reads as a plain file to anyone opening the folder.
 * On read the NEWER of the two wins.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { withFolderLock } from './workspace.js'

/** The pipeline tags, in process order. Anything else fails normalization. */
export const APPLICATION_STATUSES = ['drafting', 'applied', 'interview', 'offer', 'rejected']

export const DEFAULT_STATUS = 'drafting'

/** The status file's name inside a candidacy folder. */
export const STATUS_FILE = 'status.json'

/** A status note is one line of context ("phone screen Fri 14:00"), not an essay. */
const MAX_NOTE = 200

/** How many past transitions the log keeps. */
const KEEP_LOG = 20

/** Is this one of the five tags? */
export function isValidStatus(value) {
  return APPLICATION_STATUSES.indexOf(value) !== -1
}

/**
 * Coerce whatever was stored into a well-formed application, or null when
 * there is nothing real to keep. Files written by older builds (and folders
 * edited by hand) must degrade rather than throw out of every read.
 */
export function normalizeApplication(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const status = typeof raw.status === 'string' ? raw.status : ''
  if (!isValidStatus(status) || status === DEFAULT_STATUS) {
    // An unset or unknown status carries nothing the projection cannot say
    // more cheaply ('' means drafting everywhere it is shown).
    return null
  }
  const log = []
  const rawLog = Array.isArray(raw.log) ? raw.log : []
  for (const entry of rawLog) {
    if (log.length >= KEEP_LOG) break
    if (entry === null || typeof entry !== 'object') continue
    const entryStatus = typeof entry.status === 'string' ? entry.status : ''
    if (!isValidStatus(entryStatus)) continue
    log.push({
      status: entryStatus,
      at: Number.isFinite(entry.at) ? entry.at : 0,
      note: typeof entry.note === 'string' ? entry.note.slice(0, MAX_NOTE) : '',
    })
  }
  return {
    status: status,
    statusUpdatedAt: Number.isFinite(raw.statusUpdatedAt) ? raw.statusUpdatedAt : 0,
    appliedAt:
      status === 'applied' || status === 'interview' || status === 'offer'
        ? Number.isFinite(raw.appliedAt)
          ? raw.appliedAt
          : 0
        : 0,
    note: typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE) : '',
    log: log,
  }
}

/**
 * Fold a user decision into the stored state. Returns the next value, or
 * the SAME object when nothing changed — a no-op must not bump timestamps
 * or grow the log.
 *
 * Moving forward keeps `appliedAt` (the day they applied does not move
 * because the process moved on); landing directly on interview/offer from
 * nothing stamps it too, because that happens — referrals skip the form.
 */
export function applyStatusChange(current, decision, now) {
  const status = decision && typeof decision.status === 'string' ? decision.status : ''
  if (!isValidStatus(status)) return null
  const note = typeof decision.note === 'string' ? decision.note.trim().slice(0, MAX_NOTE) : ''
  if (current !== null && current.status === status && current.note === note) return current
  const priorApplied =
    current !== null && Number.isFinite(current.appliedAt) && current.appliedAt > 0
      ? current.appliedAt
      : 0
  const stamped =
    priorApplied > 0
      ? priorApplied
      : status === 'applied' || status === 'interview' || status === 'offer'
        ? now
        : 0
  return {
    status: status,
    statusUpdatedAt: now,
    appliedAt: stamped,
    note: note,
    log: [{ status: status, at: now, note: note }]
      .concat(current !== null && Array.isArray(current.log) ? current.log : [])
      .slice(0, KEEP_LOG),
  }
}

/**
 * Write the mirrored copy into the candidacy folder. Same temp-then-rename
 * discipline as every other mirror: status.json is the file a human opens,
 * and a torn read of it is worse than a stale one. Under the folder lock,
 * so two sessions holding the same application serialize their tags instead
 * of racing (the newer write still wins on read).
 */
export async function writeApplicationStatus(workspace, application) {
  if (typeof workspace !== 'string' || workspace === '') return null
  if (application === null || typeof application !== 'object') return null
  return withFolderLock(workspace, async function () {
    await mkdir(workspace, { recursive: true })
    const file = join(workspace, STATUS_FILE)
    const body = JSON.stringify(application)
    const tmp =
      file +
      '.tmp-' +
      createHash('sha1').update(String(application.statusUpdatedAt)).digest('hex').slice(0, 8)
    try {
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, file)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    return file
  })
}

/**
 * Read the mirrored copy, or null. A folder that has been moved, or a file
 * a hand edit broke, just means "no folder opinion" — the session record
 * still speaks.
 */
export async function readApplicationStatus(workspace) {
  if (typeof workspace !== 'string' || workspace === '') return null
  try {
    const text = await readFile(join(workspace, STATUS_FILE), 'utf8')
    return normalizeApplication(JSON.parse(text))
  } catch {
    return null
  }
}

/**
 * Which of two stored states is authoritative: the newer write. Zero dates
 * (a hand-written file without timestamps) lose against anything dated, and
 * two undated states fall back to the record's own.
 */
export function newerApplication(a, b) {
  if (a === null) return b
  if (b === null) return a
  return (b.statusUpdatedAt || 0) > (a.statusUpdatedAt || 0) ? b : a
}
