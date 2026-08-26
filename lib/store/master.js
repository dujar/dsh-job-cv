/**
 * The master CV — the user's single source of truth.
 *
 * Every tailored application CV is a byproduct; this document is the asset.
 * It lives OUTSIDE any session or candidacy (one person, one career, many
 * applications), so unlike the per-session records it is one JSON file under
 * the plugin's own state directory:
 *
 *   $DSH_HOME/dsh-job-cv/master.json
 *
 * The file holds the current master plus the last KEEP_VERSIONS saves, on
 * exactly the version-line pattern the cover letter uses. On top of that,
 * every save mirrors into an applications root as plain HTML
 * (`<root>/master/cv/latest.html`), because a source of truth a human cannot
 * open outside the harness would betray the folder habit the whole plugin
 * runs on: the JSON here stays the source of truth, and the mirror is
 * best-effort like every other one.
 *
 * Tailored documents are NEVER stored as patches and never reconstructed
 * from them — deltas against this document are derived views computed by
 * cv-diff.js on demand. Full documents are what every consumer (preview,
 * tracker, export, hand edits) already speaks, and kilobytes of disk were
 * never the scarce resource.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mirrorCvVersion } from './workspace.js'

const KEEP_VERSIONS = 10

/** A version note is a timeline label, not an essay. Same rule as the store. */
const MAX_NOTE = 200

function emptyMaster() {
  return { version: 0, html: '', note: '', updatedAt: 0, history: [] }
}

/**
 * Coerce whatever the file held into a well-formed record — same degradation
 * rule as normalizeRecord: a file written by an older build must read as
 * sane fields rather than poison every future save.
 */
function normalizeMaster(parsed) {
  const raw = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const history = Array.isArray(raw.history) ? raw.history : []
  return {
    version: Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 0,
    html: typeof raw.html === 'string' ? raw.html : '',
    note: typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE) : '',
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    history: history
      .filter((e) => e !== null && typeof e === 'object')
      .map((e) => ({
        version: Number.isInteger(e.version) && e.version > 0 ? e.version : 0,
        html: typeof e.html === 'string' ? e.html : '',
        note: typeof e.note === 'string' ? e.note.slice(0, MAX_NOTE) : '',
        updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : 0,
      }))
      .filter((e) => e.version > 0 && e.html !== '')
      .slice(0, KEEP_VERSIONS),
  }
}

export function createMasterStore(rootDir) {
  const file = join(rootDir, 'master.json')
  // The cache mirrors doc-store's: once loaded, memory is authoritative and
  // external hand edits land after a restart — the same trade every session
  // record already makes.
  let cache = null
  let queue = Promise.resolve()

  async function load() {
    if (cache !== null) return cache
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        cache = emptyMaster()
        return cache
      }
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(
        'the master CV is unreadable (' +
          file +
          '); move that file aside to start fresh — the mirrored <root>/master/cv/latest.html still holds the last good copy',
      )
    }
    cache = normalizeMaster(parsed)
    return cache
  }

  /** Serialize writers exactly like the per-session lock does. */
  function withLock(fn) {
    const run = queue.then(fn, fn)
    const tail = run.then(
      () => {},
      () => {},
    )
    queue = tail
    return run
  }

  /**
   * Replace the master wholesale and bump its own version line. A restore of
   * an earlier master rides through history the same way the CV's restore
   * does when that surface arrives; saving forward keeps nothing destructible.
   */
  function save(doc) {
    return withLock(async function () {
      const record = await load()
      const html = String(doc && doc.html)
      if (html.trim() === '') throw new Error('html must be a non-empty string')
      const next = {
        version: record.version + 1,
        html: html,
        note: doc && typeof doc.note === 'string' ? doc.note.slice(0, MAX_NOTE) : '',
        updatedAt: Date.now(),
        history: [
          ...(record.version > 0 && record.html !== ''
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
      return next.version
    })
  }

  /** One past master body, for looking before restoring (same as versionHtml). */
  async function versionHtml(version) {
    const record = await load()
    if (record.version === version && record.html !== '') return record.html
    const found = record.history.find((e) => e.version === version)
    return found !== undefined && found.html !== '' ? found.html : null
  }

  /**
   * Mirror the master into an applications root as
   * `<root>/master/cv/vN.html` + `latest.html`, creating it when missing so
   * the onboarding pick list can always hand out a path that exists. Best-
   * effort like every mirror: a root that moved or went read-only logs and
   * answers null instead of failing the caller.
   */
  async function mirrorInto(root) {
    if (typeof root !== 'string' || root.trim() === '') return null
    const record = await load()
    if (record.version < 1 || record.html === '') return null
    try {
      await mirrorCvVersion(join(root, 'master'), record.version, record.html)
    } catch (error) {
      console.warn(
        '[dsh-job-cv] could not mirror the master CV into ' +
          root +
          ': ' +
          String(error && error.message ? error.message : error),
      )
      return null
    }
    return {
      version: record.version,
      updatedAt: record.updatedAt,
      path: join(root, 'master', 'cv', 'latest.html'),
    }
  }

  return { load, save, versionHtml, mirrorInto }
}
