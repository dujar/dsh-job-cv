/**
 * The markdown jobs list — the second onboarding path.
 *
 * A user hunting several postings at once keeps them in a notes file: one
 * bullet per job, a title and a link. The host parses that file so the
 * preview can offer the list as a pick surface, and the same file stays the
 * switcher for the rest of the session — pick another line, and this session
 * works on that posting instead. The parser is deliberately forgiving about
 * markdown shape (bullets, headings, bold, autolinks) and strict about what
 * counts as a job: an http(s) link or nothing.
 */
import { readFile, stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

/** A list file larger than this is not a list of jobs. */
export const MAX_LIST_BYTES = 512 * 1024

/** A session's pick list is capped; nobody tailors two hundred CVs at once. */
export const MAX_JOBS = 200

const MAX_TITLE = 160
const MAX_COMPANY = 120
const MAX_URL = 2000

/** Strip markdown emphasis, quotes, bullets and list numbers from a fragment. */
function cleanFragment(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/[*_`]+/g, '')
    .replace(/^[\s>#]*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^</, '')
    .replace(/>$/, '')
    .trim()
}

/**
 * A company name out of the words before the link on its line:
 * `- Acme Corp: [Engineer](https://…)` → "Acme Corp". Trailing punctuation
 * that only joined the company to the link is stripped; anything left that
 * cannot be a name yields ''.
 */
export function companyFromPrefix(prefix) {
  let text = cleanFragment(prefix)
  // Separators that introduce the link rather than end the company.
  text = text.replace(/[-–—:·|,;]+\s*$/, '').trim()
  if (text.length < 2 || text.length > MAX_COMPANY) return ''
  // A prefix that is itself prose (a sentence before the link) is not a
  // company: a name carries no sentence punctuation inside it.
  if (/[.!?]/.test(text)) return ''
  if (/https?:\/\//i.test(text)) return ''
  return text
}

/** The company context a heading sets for the entries under it. */
function companyFromHeading(text) {
  const cleaned = companyFromPrefix(text)
  return cleaned
}

/** A readable title from the URL itself, for links whose text is empty. */
export function titleFromUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return ''
  }
  const segments = parsed.pathname.split('/').filter((s) => s !== '')
  let last = segments[segments.length - 1] || ''
  try {
    last = decodeURIComponent(last)
  } catch {
    /* a malformed escape stays as written */
  }
  let title = last.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (title === '') title = parsed.hostname.replace(/^www\./, '')
  return title.slice(0, MAX_TITLE)
}

/**
 * Query parameters that only ever carry tracking — ad click ids and the
 * like. Anything here is stripped from EVERY comparison AND from the stored
 * link, because pasting a LinkedIn link twice (once from search, once from
 * "save") yields different ?trk=… dust, and the stored link must stay one
 * canonical thing.
 *
 * Deliberately NOT in either list: `gh_jid` carries Greenhouse's real job
 * id, and `vjk`/`jk` carry Indeed's — stripping those would break fetching.
 */
const TRACKING_PARAMS = new Set([
  'gclid',
  'fbclid',
  'dclid',
  'msclkid',
  'twclid',
  'ttclid',
  'yclid',
  'li_fat_id',
  'trk',
  'trkinfo',
  'trk_info',
  'lid',
  'origin',
  'mc_cid',
  'mc_eid',
  'igshid',
  'spm',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
])

/**
 * Parameters that are tracking on most boards but FUNCTIONAL on a few —
 * `?ref=` is Ashby's source token and some ATSs route on it. They survive
 * in stored links (which get fetched) but are ignored when two URLs are
 * MATCHED as the same posting: identity may be generous where storage must
 * be faithful. Extend this list only for params whose absence can break a
 * fetch, never for cosmetic ones (those belong in TRACKING_PARAMS).
 */
const MATCH_ONLY_PARAMS = new Set(['ref'])

/** One canonicalizer, two grades of strictness. */
function canonicalizeUrl(url, alsoDrop) {
  const raw = String(url === undefined || url === null ? '' : url).trim()
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    // Not a parseable absolute URL: strip what a regex can see and stop.
    return raw.replace(/#.*$/, '').replace(/\/+$/, '')
  }
  // http and https serve the same posting everywhere this plugin works, and
  // host case is meaningless on the wire; folding both keeps one identity
  // where a paste could have given either spelling.
  if (parsed.protocol === 'http:') parsed.protocol = 'https:'
  parsed.hostname = parsed.hostname.toLowerCase()
  parsed.hash = ''
  const drop = []
  parsed.searchParams.forEach(function (value, key) {
    const lower = key.toLowerCase()
    if (
      TRACKING_PARAMS.has(lower) ||
      lower.startsWith('utm_') ||
      (alsoDrop !== null && alsoDrop.has(lower))
    ) {
      drop.push(key)
    }
  })
  for (const key of drop) parsed.searchParams.delete(key)
  let out = parsed.toString()
  if (out.endsWith('?')) out = out.slice(0, -1)
  return out.replace(/\/+$/, '')
}

/**
 * The STORAGE form: safe to hand to curl later. Tracking dust is stripped,
 * everything possibly functional survives.
 */
export function normalizeUrl(url) {
  return canonicalizeUrl(url, null)
}

/**
 * The MATCHING form: answers "is this the same posting". Everything the
 * storage form drops, plus the sometimes-functional tokens that must not
 * decide identity. Archive keys, save guards and panel comparisons run on
 * THIS; stored links and pick-list entries stay on normalizeUrl.
 */
export function urlMatchKey(url) {
  return canonicalizeUrl(url, MATCH_ONLY_PARAMS)
}

function entry(title, company, url) {
  return {
    title: String(title === undefined || title === null ? '' : title).slice(0, MAX_TITLE),
    company: String(company === undefined || company === null ? '' : company).slice(0, MAX_COMPANY),
    url: String(url).slice(0, MAX_URL),
  }
}

/**
 * Parse the markdown into job entries, in file order, deduplicated by URL.
 *
 *   ## Acme Corp                        ← heading sets the company below it
 *   - [Senior Engineer](https://…)      ← the canonical line
 *   - Senior Engineer                   ← title on its own line…
 *     https://jobs.acme.com/123         ← …with the URL on the next one
 *   - Acme: [Engineer](https://…)       ← a company named before the link
 *
 * Anything else on the page is ignored, so notes around the list are safe.
 * Returns { jobs, count }; jobs never exceeds MAX_JOBS.
 */
export function parseJobList(text) {
  const raw = String(text === undefined || text === null ? '' : text)
  const lines = raw.split(/\r?\n/)
  const jobs = []
  const seen = new Set()
  let headingCompany = ''
  let pendingTitle = ''

  for (let i = 0; i < lines.length && jobs.length < MAX_JOBS; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '') continue

    // A heading names the employer of everything under it until the next one,
    // and ends any dangling title line above it.
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/)
    if (heading) {
      headingCompany = companyFromHeading(heading[1])
      pendingTitle = ''
      continue
    }

    // Markdown links anywhere in the line — the shape every note-taker uses.
    const linkRe = /\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)\s]+))[^)]*\)/g
    let match
    let found = false
    while ((match = linkRe.exec(trimmed)) !== null && jobs.length < MAX_JOBS) {
      const url = match[2] !== undefined ? match[2] : match[3]
      if (!/^https?:\/\//i.test(url || '')) continue
      const key = normalizeUrl(url)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      const title = match[1].trim() || pendingTitle || titleFromUrl(url)
      const company =
        companyFromPrefix(trimmed.slice(0, match.index)) || companyFromPrefix(headingCompany)
      jobs.push(entry(title, company, url))
      found = true
      pendingTitle = ''
    }
    if (found) continue

    // A bare URL on its own line (plain or <autolinked>): the title comes
    // from the line above when there was one, else from the URL itself.
    // The WHOLE line must be the URL, so prose paragraphs never become
    // phantom entries.
    const bare = trimmed.match(/^<?(https?:\/\/[^\s>]+)>?$/)
    if (bare) {
      const url = bare[1]
      const key = normalizeUrl(url)
      if (key !== '' && !seen.has(key)) {
        seen.add(key)
        jobs.push(entry(pendingTitle || titleFromUrl(url), companyFromPrefix(headingCompany), url))
        pendingTitle = ''
      }
      continue
    }

    // No link here. A short plain line is remembered as the title for the
    // URL that may follow; anything long, sentence-shaped or link-ish
    // breaks the pair — notes around the list must not become job titles.
    if (
      trimmed.length <= MAX_TITLE &&
      !/https?:\/\//i.test(trimmed) &&
      !trimmed.includes('](http') &&
      !/[.!?]/.test(trimmed)
    ) {
      pendingTitle = cleanFragment(trimmed)
    } else {
      pendingTitle = ''
    }
  }
  return { jobs: jobs, count: jobs.length }
}

/**
 * Read a job-list file from disk. `baseDir` resolves a relative path against
 * the session's working directory (the user typed the path in their own GUI,
 * so it is read as typed). Returns the text; throws a readable Error when
 * the path is missing or oversized.
 */
export async function readJobListFile(path, baseDir) {
  const raw = String(path === undefined || path === null ? '' : path).trim()
  if (raw === '') throw new Error('no markdown path given')
  const full = isAbsolute(raw) ? raw : join(baseDir || process.cwd(), raw)
  let info
  try {
    info = await stat(full)
  } catch {
    throw new Error('file not found: ' + raw)
  }
  if (!info.isFile()) throw new Error('not a file: ' + raw)
  if (info.size > MAX_LIST_BYTES) {
    throw new Error('file too large for a jobs list (' + Math.round(info.size / 1024) + 'KB)')
  }
  return readFile(full, 'utf8')
}
