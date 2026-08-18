/**
 * Proposed content changes, awaiting the user's decision.
 *
 * A wording change is the user's call, not the agent's: it is their CV and
 * their claims about themselves. So the agent does not save content edits
 * directly — it proposes them, offers alternatives, and the document changes
 * only after the user picks or refines. Formatting and layout stay a direct
 * save; nothing is gained by asking permission to fix a margin.
 *
 * One comment often implicates several parts (tighten a summary and the
 * bullet it repeats), so a proposal carries a LIST of changes reviewed and
 * decided together rather than one edit at a time.
 */
import { randomUUID } from 'node:crypto'

/** Bounds — an agent can emit anything, and this ends up in a browser. */
const MAX_CHANGES = 20
const MAX_OPTIONS = 5
const MAX_TEXT = 4000
const MAX_LABEL = 80

function text(value, max) {
  const raw = typeof value === 'string' ? value : ''
  return raw.length > max ? raw.slice(0, max) : raw
}

/**
 * Coerce an agent-authored proposal into a shape the browser can render.
 * Returns null when nothing usable survives — a proposal with no change to
 * decide is not a proposal, and silently storing one would leave the user
 * staring at an empty review panel.
 */
export function normalizeProposal(input, basedOnVersion) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const rawChanges = Array.isArray(raw.changes) ? raw.changes.slice(0, MAX_CHANGES) : []
  const changes = []
  for (const entry of rawChanges) {
    if (entry === null || typeof entry !== 'object') continue
    const rawOptions = Array.isArray(entry.options) ? entry.options.slice(0, MAX_OPTIONS) : []
    const options = []
    for (const option of rawOptions) {
      if (option === null || typeof option !== 'object') continue
      const body = text(option.text, MAX_TEXT)
      if (body.trim() === '') continue
      options.push({
        id: text(option.id, 40) || 'o' + String(options.length + 1),
        label: text(option.label, MAX_LABEL) || 'Option ' + String(options.length + 1),
        text: body,
      })
    }
    // A change the user cannot choose between is not reviewable.
    if (options.length === 0) continue
    changes.push({
      id: text(entry.id, 40) || 'c' + String(changes.length + 1),
      section: text(entry.section, MAX_LABEL),
      path: text(entry.path, 400),
      current: text(entry.current, MAX_TEXT),
      why: text(entry.why, MAX_TEXT),
      options: options,
    })
  }
  if (changes.length === 0) return null
  return {
    id: 'p-' + randomUUID(),
    createdAt: Date.now(),
    basedOnVersion: Number.isInteger(basedOnVersion) && basedOnVersion >= 0 ? basedOnVersion : 0,
    summary: text(raw.summary, MAX_TEXT),
    changes: changes,
  }
}

/** The stored shape, defended on read the way records are. */
export function readProposal(value) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.changes)) return null
  if (value.changes.length === 0) return null
  return value
}
