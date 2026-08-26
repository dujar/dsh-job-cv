/**
 * Per-candidacy workspace paths.
 *
 * One directory per job application, upserted at
 * <root>/<company>/<job-id>/ so a second session about the same job lands in
 * the same folder instead of forking a new one.
 *
 * The slug rules live here rather than in the agent contract on purpose: an
 * agent asked in prose to "lowercase the company name" produces `acme-corp`
 * one day and `acme_corp` the next, and the upsert stops being an upsert.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve, sep } from 'node:path'
import { normalizeUrl, urlMatchKey } from './joblist.js'

/**
 * The layout inside one candidacy folder. Fixed and scaffolded up front so
 * the agent never has to invent a place to put things, and so the folder
 * reads as an application to a human who opens it outside the harness.
 */
export const CANDIDACY_DIRS = [
  ['cv', 'Tailored CV versions written by the preview (v1.html …, latest.html).'],
  ['letter', 'Cover letter versions, same naming as cv/.'],
  ['source', 'The CV exactly as supplied — never edited.'],
  ['notes', 'The fetched job post, research, cover letter drafts.'],
]

/** Last-resort root when a session has no working directory of its own. */
export function applicationsRoot(dshHome) {
  const override = process.env.DSH_JOB_CV_ROOT
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const home = typeof dshHome === 'string' && dshHome !== '' ? dshHome : join(homedir(), '.dsh')
  return join(home, 'dsh-job-cv', 'applications')
}

/**
 * Where this session's candidacies live.
 *
 * The session's own working directory wins. An application is the user's
 * work — a folder they open, diff, back up and keep after the harness is
 * gone — so it belongs in the project they started the session in, not
 * buried in $DSH_HOME beside the plugin's internal state.
 *
 *   1. $DSH_JOB_CV_ROOT — an explicit choice always wins;
 *   2. the session's cwd;
 *   3. $DSH_HOME/dsh-job-cv/applications — only when the session has no cwd.
 */
export function candidacyRoot(options) {
  const opts = options || {}
  const override = process.env.DSH_JOB_CV_ROOT
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const cwd = opts.sessionCwd
  if (typeof cwd === 'string' && cwd.trim() !== '' && isAbsolute(cwd)) return cwd
  return applicationsRoot(opts.dshHome)
}

/**
 * A path-safe, stable slug: accents folded, everything outside [a-z0-9]
 * collapsed to a single dash, ends trimmed, length capped. Returns the
 * fallback when nothing survives — never an empty path segment.
 */
export function slugify(value, fallback) {
  const raw = String(value === undefined || value === null ? '' : value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug === '' ? fallback : slug
}

/**
 * The job's own identifier out of its URL: an id-looking path segment when
 * the board exposes one (LinkedIn's numeric id, Lever's uuid), else the last
 * segment slugified. '' when the URL yields nothing usable.
 */
export function jobSlugFromUrl(jobUrl) {
  let parsed
  try {
    parsed = new URL(String(jobUrl))
  } catch {
    return ''
  }
  const segments = parsed.pathname.split('/').filter((s) => s !== '')
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]
    if (/^[0-9]{4,}$/.test(segment)) return segment
    if (/^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(segment)) return segment.toLowerCase()
  }
  const last = segments[segments.length - 1]
  return last === undefined ? '' : slugify(last, '')
}

/**
 * The job directory name. An explicit id wins; then the URL; then a short
 * digest of the URL, so two different posts never collide even when neither
 * carries a readable id.
 */
export function jobSlug(jobId, jobUrl) {
  const explicit = slugify(jobId, '')
  if (explicit !== '') return explicit
  const fromUrl = jobSlugFromUrl(jobUrl)
  if (fromUrl !== '') return fromUrl
  const url = String(jobUrl === undefined || jobUrl === null ? '' : jobUrl)
  if (url === '') return ''
  return 'job-' + createHash('sha1').update(url).digest('hex').slice(0, 10)
}

/** The relative <company>/<job> pair, or null when the company is unusable. */
export function candidacyPath(input) {
  const company = slugify(input.company, '')
  if (company === '') return null
  const job = jobSlug(input.jobId, input.jobUrl)
  if (job === '') return null
  return { company, job, relative: join(company, job) }
}

/**
 * Whether a folder name is an id the BOARD minted — four-plus digits or a
 * uuid-shaped segment. Such ids are effectively namespace-unique, so a
 * folder named one of them under ANY company is almost certainly the same
 * posting; a text slug ("senior-engineer") is not, and two companies may
 * legitimately share one.
 */
export function isStrongJobSlug(slug) {
  const s = String(slug === undefined || slug === null ? '' : slug)
  return /^[0-9]{4,}$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(s)
}

/**
 * A best-effort lock around everything that writes into one candidacy
 * folder. Two sessions can hold the SAME application active at once (the
 * Jobs panel switches per session), and their mirrors then race per file
 * name; the atomic temp-rename already prevents torn files, this serializes
 * whole writes so last-writer-wins happens per operation instead of mid-
 * file. Best-effort by design: after a short wait — or when the lock looks
 * abandoned (older than LOCK_STALE_MS, e.g. a killed process) — the write
 * proceeds unlocked, because mirroring must never fail a save.
 */
const LOCK_DIR = '.lock'
export const LOCK_WAIT_MS = 4000
const LOCK_STALE_MS = 60 * 1000

function sleep(ms) {
  return new Promise(function (resolveFn) {
    setTimeout(resolveFn, ms)
  })
}

export async function withFolderLock(workspace, fn) {
  if (typeof workspace !== 'string' || workspace === '') return fn()
  const lockPath = join(workspace, LOCK_DIR)
  let held = false
  try {
    await mkdir(workspace, { recursive: true })
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        await mkdir(lockPath)
        held = true
        break
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
        // Held. Take it over when abandoned, else wait a tick.
        try {
          const info = await stat(lockPath)
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            await rm(lockPath, { recursive: true, force: true })
            continue
          }
        } catch {
          /* vanished between EEXIST and stat — just retry */
        }
        if (Date.now() >= deadline) break // proceed unlocked rather than fail
        await sleep(40)
      }
    }
    return await fn()
  } finally {
    if (held) await rm(lockPath, { recursive: true, force: true }).catch(function () {})
  }
}

/**
 * The folder's recorded identity: which posting it belongs to, as the
 * canonical URL. This is what lets `Acme` and `Acme Corp` spellings — and
 * re-pastes with different tracking dust — land in ONE folder: the upsert
 * matches on this, not on how the company string happened to be spelled
 * this time. Written beside status.json so both stay plain files.
 */
export const IDENTITY_FILE = 'application.json'

async function writeCandidacyIdentity(workspace, identity) {
  if (typeof workspace !== 'string' || workspace === '') return
  if (!identity || typeof identity !== 'object') return
  const record = {
    jobUrl: typeof identity.jobUrl === 'string' ? identity.jobUrl : '',
    company: typeof identity.company === 'string' ? identity.company : '',
    jobTitle: typeof identity.jobTitle === 'string' ? identity.jobTitle : '',
    recordedAt: Date.now(),
  }
  if (normalizeUrl(record.jobUrl) === '') return
  await withFolderLock(workspace, function () {
    return writeFile(join(workspace, IDENTITY_FILE), JSON.stringify(record, null, 2) + '\n', 'utf8')
  })
}

/** The stored identity, or null — legacy folders predate the file. */
export async function readCandidacyIdentity(workspace) {
  if (typeof workspace !== 'string' || workspace === '') return null
  try {
    const parsed = JSON.parse(await readFile(join(workspace, IDENTITY_FILE), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return {
      jobUrl: typeof parsed.jobUrl === 'string' ? parsed.jobUrl : '',
      company: typeof parsed.company === 'string' ? parsed.company : '',
      jobTitle: typeof parsed.jobTitle === 'string' ? parsed.jobTitle : '',
      recordedAt: Number(parsed.recordedAt) || 0,
    }
  } catch {
    return null
  }
}

/**
 * Whatever the folder can SAY about which posting it belongs to. The
 * identity file speaks first; a folder from before that file existed still
 * has a voice, because its creation breadcrumb has carried a
 * "Job post: <url>" line since the first release. Only the first 2KB are
 * read — the header block, not the notes below it.
 */
const README_EVIDENCE_LIMIT = 2048

export async function readCandidacyEvidence(workspace) {
  if (typeof workspace !== 'string' || workspace === '') return null
  const fromFile = await readCandidacyIdentity(workspace)
  if (fromFile !== null && normalizeUrl(fromFile.jobUrl) !== '') {
    return { jobUrl: fromFile.jobUrl, source: 'file' }
  }
  try {
    const handle = await readFile(join(workspace, 'README.md'), 'utf8')
    const head = handle.slice(0, README_EVIDENCE_LIMIT)
    const line = head.match(/^\s*(?:[-*]\s*)?Job post:\s*(\S+)\s*$/im)
    if (line !== null && /^https?:\/\//i.test(line[1])) {
      return { jobUrl: line[1], source: 'readme' }
    }
  } catch {
    /* no readable README — the folder stays silent */
  }
  return null
}

/**
 * Every folder under <root> whose EVIDENCE claims the wanted posting,
 * whatever its name or which company segment it sits under. This is what
 * lets "Acme" vs "Acme Corp" spellings — and weak text slugs whose twin was
 * made before identities were recorded — resolve to ONE folder. Bounded:
 * hundreds of applications stay cheap, and the walk stops reading once the
 * bound is hit rather than grinding through a huge tree.
 */
const MAX_FOLDERS_SCANNED = 400

async function findFolderByUrl(root, wantedKey) {
  let companies
  try {
    companies = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const matches = []
  let visited = 0
  for (const company of companies) {
    if (!company.isDirectory() || company.name === LOCK_DIR) continue
    let jobs
    try {
      jobs = await readdir(join(root, company.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const job of jobs) {
      if (!job.isDirectory() || job.name === LOCK_DIR) continue
      if (visited >= MAX_FOLDERS_SCANNED) return matches
      visited += 1
      const candidate = join(root, company.name, job.name)
      try {
        const evidence = await readCandidacyEvidence(candidate)
        if (evidence !== null && urlMatchKey(evidence.jobUrl) === wantedKey) {
          matches.push(candidate)
        }
      } catch {
        /* an unreadable folder simply cannot claim the posting */
      }
    }
  }
  return matches
}

/**
 * Every <root>/<company>/<jobSlug> folder whose JOB segment equals `job`,
 * regardless of how its company segment was spelled.
 */
async function findFoldersByJob(root, job) {
  let companies
  try {
    companies = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of companies) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, job)
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) found.push(candidate)
    } catch {
      /* no such folder under this company */
    }
  }
  return found
}

/**
 * Create (or adopt) the candidacy directory. `created` distinguishes the two
 * so the agent can tell the user it is resuming an application rather than
 * starting one.
 *
 * Resolution is by POSTING, not by folder name or company spelling:
 *
 * 1. The preferred <slug(company)>/<job> path is used when it does not exist,
 *    or when it exists and its recorded identity agrees (or is silent).
 * 2. Otherwise — before anything else — every folder under root whose
 *    EVIDENCE claims this posting wins outright (`adoptedBy:'url'`), whatever
 *    its name or company segment. Evidence is application.json, or for legacy
 *    folders the "Job post:" line their creation breadcrumb always carried.
 * 3. With no evidence anywhere, a single folder named after a board-minted id
 *    (digits/uuid — ids no two postings share) is still adopted
 *    (`adoptedBy:'id'`), healing forks older than both mechanisms.
 * 4. A name taken by a DIFFERENT posting never mixes them: this posting gets
 *    a stable sibling `<job>-<hash8>` instead.
 */
export async function upsertCandidacy(root, input) {
  const parts = candidacyPath(input)
  if (parts === null) return null
  const preferred = join(root, parts.relative)
  const wantedRaw = String(
    input.jobUrl === undefined || input.jobUrl === null ? '' : input.jobUrl,
  ).trim()
  const wantedKey = wantedRaw === '' ? '' : urlMatchKey(wantedRaw)

  let target = preferred
  let created = true
  let adoptedBy = null

  try {
    const existing = await stat(preferred)
    if (existing.isDirectory()) {
      // The name matches — but does the POSTING? Two distinct jobs can land
      // on one folder name (a reused explicit id, a hand-made folder, a
      // digest collision). When this folder records a different posting and
      // ours carries a link, fall through to identity-based resolution
      // rather than mixing two applications into one cv/ directory.
      if (wantedKey !== '') {
        const here = await readCandidacyEvidence(preferred)
        if (here !== null && urlMatchKey(here.jobUrl) !== wantedKey) {
          /* taken by another posting — resolved below */
        } else {
          created = false
          adoptedBy = 'exact'
        }
      } else {
        created = false
        adoptedBy = 'exact'
      }
    }
  } catch {
    // missing — resolution continues below
  }

  if (created && wantedKey !== '') {
    const byUrl = await findFolderByUrl(root, wantedKey)
    if (byUrl.length > 0) {
      // Newest wins if legacy forks left more than one match.
      let best = byUrl[0]
      let bestTime = -1
      for (const candidate of byUrl) {
        const t = (await stat(candidate)).mtimeMs
        if (t > bestTime) {
          bestTime = t
          best = candidate
        }
      }
      target = best
      created = false
      adoptedBy = 'url'
    } else {
      const candidates = await findFoldersByJob(root, parts.job)
      if (candidates.length === 1 && isStrongJobSlug(parts.job)) {
        // One existing folder under this board's unique id: adopt even
        // though nobody recorded the URL anywhere in it.
        target = candidates[0]
        created = false
        adoptedBy = 'id'
      }
    }
    // Still unresolved AND the preferred name belongs to another posting:
    // derive a stable sibling so repeated calls land in the same place.
    if (created && adoptedBy === null && target === preferred) {
      let taken = false
      try {
        taken = (await stat(preferred)).isDirectory()
      } catch {
        /* free after all — create it plainly */
      }
      if (taken) {
        const suffix = createHash('sha1').update(wantedKey).digest('hex').slice(0, 8)
        target = join(root, parts.company, parts.job + '-' + suffix)
      }
    }
  }

  await mkdir(target, { recursive: true })
  // Scaffolded on every open, not only on create: a folder made by an
  // earlier version of this plugin should gain the layout on next open.
  for (const [name] of CANDIDACY_DIRS) await mkdir(join(target, name), { recursive: true })
  if (created) {
    // A breadcrumb so the folder explains itself outside the harness.
    const readme =
      '# ' +
      String(input.company) +
      ' — ' +
      String(input.jobTitle || parts.job) +
      '\n\n' +
      (input.jobUrl ? 'Job post: ' + String(input.jobUrl) + '\n' : '') +
      'Created by the dsh-job-cv plugin.\n\n' +
      CANDIDACY_DIRS.map(([name, what]) => '- `' + name + '/` — ' + what).join('\n') +
      '\n'
    await writeFile(join(target, 'README.md'), readme, { encoding: 'utf8', flag: 'wx' }).catch(
      () => {},
    )
  }
  await writeCandidacyIdentity(target, input)
  return { path: target, company: parts.company, job: parts.job, created, adoptedBy }
}

/**
 * Write a saved CV into the candidacy folder as well as the session store.
 *
 * The store's JSON is the source of truth, but it is opaque: without this the
 * folder never contains the thing the whole application is about. Each
 * version is kept under its own name and `latest.html` is rewritten, so the
 * folder is directly openable and printable outside the harness.
 *
 * A copy, not a symlink — the folder has to survive being zipped and moved
 * to a machine that does not do symlinks.
 */
export async function mirrorCvVersion(workspace, version, html, kind) {
  if (typeof workspace !== 'string' || workspace === '') return null
  if (!Number.isInteger(version) || version < 1) return null
  if (typeof html !== 'string' || html === '') return null
  return withFolderLock(workspace, async function () {
    const dir = join(workspace, typeof kind === 'string' && kind !== '' ? kind : 'cv')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'v' + version + '.html')
    await writeFile(file, html, 'utf8')
    // Temp-then-rename: latest.html is the one a human double-clicks, and a
    // torn read of it is worse than a stale one.
    const latest = join(dir, 'latest.html')
    const tmp =
      latest + '.tmp-' + createHash('sha1').update(String(version)).digest('hex').slice(0, 8)
    try {
      await writeFile(tmp, html, 'utf8')
      await rename(tmp, latest)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    return file
  })
}

/**
 * Where the newest mirrored CV sits inside a candidacy folder — the file
 * mirrorCvVersion keeps rewritten on every save. The onboarding pick list
 * hands this exact path out, so its naming is defined here and nowhere else.
 */
export function latestCvFile(workspace) {
  if (typeof workspace !== 'string' || workspace === '') return ''
  return join(workspace, 'cv', 'latest.html')
}

/** The job post as text, where the folder keeps it. */
export const POST_FILE = 'notes/job-post.txt'

/**
 * Write the job post text into the candidacy folder.
 *
 * The post is the thing every other file in the folder is an answer to, and
 * it is the one thing that can disappear from under the user — postings are
 * pulled, links rot, boards expire them after a month. Keeping the readable
 * text beside the CV is what makes the folder still make sense in November.
 */
export async function mirrorPostText(workspace, text) {
  if (typeof workspace !== 'string' || workspace === '') return null
  if (typeof text !== 'string' || text.trim() === '') return null
  return withFolderLock(workspace, async function () {
    const dir = join(workspace, 'notes')
    await mkdir(dir, { recursive: true })
    const file = join(workspace, POST_FILE)
    const tmp =
      file + '.tmp-' + createHash('sha1').update(String(text.length)).digest('hex').slice(0, 8)
    try {
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, file)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    return file
  })
}

/**
 * The post text the folder already holds, or ''.
 *
 * The fallback for every session that ran before the post had a route of its
 * own: the contract has always told the agent to save the fetched text here,
 * so the preview can show those without anyone re-fetching anything.
 */
export async function readPostText(workspace) {
  if (typeof workspace !== 'string' || workspace === '') return ''
  try {
    return await readFile(join(workspace, POST_FILE), 'utf8')
  } catch {
    return ''
  }
}

/** Files worth showing, at most one directory deep. */
const LIST_LIMIT = 200

/**
 * The files currently inside a candidacy folder, for the browser to show
 * what the agent has saved. Name + size + modified time, sorted newest
 * first; [] when the folder is missing or empty. Recurses ONE level so the
 * scaffolded subfolders are not dead ends in the listing — names come back
 * relative ('cv/v3.html'), which is also how the user should refer to them.
 */
export async function listCandidacyFiles(dir) {
  const files = []
  async function walk(base, prefix, depth) {
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= LIST_LIMIT) return
      if (entry.name.startsWith('.')) continue
      const full = join(base, entry.name)
      const label = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) {
        if (depth > 0) await walk(full, label, depth - 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const st = await stat(full)
        files.push({ name: label, size: st.size, mtime: st.mtimeMs })
      } catch {
        // vanished between readdir and stat — skip it
      }
    }
  }
  await walk(dir, '', 1)
  files.sort((a, b) => b.mtime - a.mtime)
  return files
}

/**
 * Read one file out of a candidacy folder for the browser's "open this
 * file" click. `name` is the relative label the listing returned, so it
 * must not be trusted: anything that escapes the folder reads as "not
 * found" (null) rather than throwing — the listing is the only name source
 * the UI trusts, and a traversal attempt deserves no detail.
 */
export async function readCandidacyFile(workspace, name) {
  if (typeof workspace !== 'string' || workspace === '') return null
  if (typeof name !== 'string' || name === '' || name.indexOf('\0') !== -1) return null
  try {
    const root = resolve(workspace)
    const target = resolve(root, name)
    if (target !== root && !target.startsWith(root + sep)) return null
    const st = await stat(target)
    if (!st.isFile()) return null
    return await readFile(target)
  } catch {
    return null
  }
}

/**
 * Write the styled posting page into the candidacy folder, beside the text.
 *
 * The page is what a candidate studies — the requirements with the CV's gaps
 * marked — so the folder should hold the same page the preview shows, not
 * just the text it was built from.
 */
export async function mirrorPostHtml(workspace, html) {
  if (typeof workspace !== 'string' || workspace === '') return null
  if (typeof html !== 'string' || html.trim() === '') return null
  return withFolderLock(workspace, async function () {
    const dir = join(workspace, 'notes')
    await mkdir(dir, { recursive: true })
    const file = join(workspace, 'notes', 'job-post.html')
    const tmp =
      file + '.tmp-' + createHash('sha1').update(String(html.length)).digest('hex').slice(0, 8)
    try {
      await writeFile(tmp, html, 'utf8')
      await rename(tmp, file)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    return file
  })
}
