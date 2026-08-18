/**
 * The candidate-facing breakdown of a job posting.
 *
 * The raw post text is what the agent fetched or the user pasted; the brief
 * is what a candidate actually wants to read: the company, the team, what the
 * job is, what it asks for, what success would look like, and the practical
 * facts a posting often buries (salary, location, how long it has been up,
 * how many have applied). Some of that is in the post, some of it takes
 * research — the company's history usually is not in a posting — so the
 * agent builds this the way it builds the fit score: reads and verifies,
 * then POSTs. The browser renders exactly what it got.
 *
 * Every section names where its content came from. A claim about the company
 * that came from the posting is different from one researched off the
 * company's own site, and a bare fact with no source is how a candidate gets
 * surprised in an interview.
 */

/** Bounds — an agent can emit anything, and this ends up in a browser. */
const MAX_SECTIONS = 10
const MAX_META = 12
const MAX_TITLE = 60
const MAX_BODY = 4000
const MAX_LABEL = 40
const MAX_VALUE = 200
const MAX_SOURCE = 40

function text(value, max) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw.length > max ? raw.slice(0, max) : raw
}

/**
 * Coerce an agent-authored brief into a shape the browser can render.
 * Returns null when nothing usable survives — a brief with no sections is an
 * empty panel.
 */
export function normalizeBrief(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}

  const sections = []
  for (const entry of Array.isArray(raw.sections) ? raw.sections.slice(0, MAX_SECTIONS) : []) {
    if (entry === null || typeof entry !== 'object') continue
    const title = text(entry.title, MAX_TITLE)
    const body = text(entry.body, MAX_BODY)
    if (title === '' || body === '') continue
    sections.push({
      title: title,
      body: body,
      source: text(entry.source, MAX_SOURCE),
    })
  }

  const meta = []
  for (const entry of Array.isArray(raw.meta) ? raw.meta.slice(0, MAX_META) : []) {
    if (entry === null || typeof entry !== 'object') continue
    const label = text(entry.label, MAX_LABEL)
    const value = text(entry.value, MAX_VALUE)
    if (label === '' || value === '') continue
    meta.push({ label: label, value: value })
  }

  if (sections.length === 0 && meta.length === 0) return null
  return {
    sections: sections,
    meta: meta,
    updatedAt: Date.now(),
  }
}

/** The stored shape, defended on read the way records are. */
export function readBrief(value) {
  if (value === null || typeof value !== 'object') return null
  const sections = Array.isArray(value.sections)
    ? value.sections.filter((s) => s && typeof s === 'object')
    : []
  const meta = Array.isArray(value.meta) ? value.meta.filter((m) => m && typeof m === 'object') : []
  if (sections.length === 0 && meta.length === 0) return null
  return {
    sections: sections,
    meta: meta,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  }
}
