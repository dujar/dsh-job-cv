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
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The layout inside one candidacy folder. Fixed and scaffolded up front so
 * the agent never has to invent a place to put things, and so the folder
 * reads as an application to a human who opens it outside the harness.
 */
export const CANDIDACY_DIRS = [
  ['cv', 'Tailored CV versions written by the preview (v1.html …, latest.html).'],
  ['source', 'The CV exactly as supplied — never edited.'],
  ['notes', 'The fetched job post, research, cover letter drafts.'],
]

/** Where candidacies live: $DSH_JOB_CV_ROOT, else $DSH_HOME/dsh-job-cv/applications. */
export function applicationsRoot(dshHome) {
  const override = process.env.DSH_JOB_CV_ROOT
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const home = typeof dshHome === 'string' && dshHome !== '' ? dshHome : join(homedir(), '.dsh')
  return join(home, 'dsh-job-cv', 'applications')
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
 * Create (or adopt) the candidacy directory. `created` distinguishes the two
 * so the agent can tell the user it is resuming an application rather than
 * starting one.
 */
export async function upsertCandidacy(root, input) {
  const parts = candidacyPath(input)
  if (parts === null) return null
  const dir = join(root, parts.relative)
  let created = true
  try {
    const existing = await stat(dir)
    if (existing.isDirectory()) created = false
  } catch {
    // missing — created below
  }
  await mkdir(dir, { recursive: true })
  // Scaffolded on every upsert, not only on create: a folder made by an
  // earlier version of this plugin should gain the layout on next open.
  for (const [name] of CANDIDACY_DIRS) await mkdir(join(dir, name), { recursive: true })
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
    await writeFile(join(dir, 'README.md'), readme, { encoding: 'utf8', flag: 'wx' }).catch(
      () => {},
    )
  }
  return { path: dir, company: parts.company, job: parts.job, created }
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
export async function mirrorCvVersion(workspace, version, html) {
  if (typeof workspace !== 'string' || workspace === '') return null
  if (!Number.isInteger(version) || version < 1) return null
  if (typeof html !== 'string' || html === '') return null
  const dir = join(workspace, 'cv')
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
