/**
 * The request inbox — what the user asked for from the preview.
 *
 * The DSH plugin delivers a UI action to the agent by composing a chat
 * message. The MCP shell has no composer, so instead the preview POSTs a
 * structured request here; it rides the /jobcv/doc projection, `jobcv_context`
 * surfaces it, and the agent resolves it when done. (The preview also shows
 * the plain-text instruction for copy-paste, as a fallback for an agent that
 * is not checking context.)
 */
import { randomUUID } from 'node:crypto'

const MAX_REQUESTS = 20
const MAX_TEXT = 2000

/** The kinds the preview can raise. Anything else is coerced to 'note'. */
export const REQUEST_KINDS = [
  'cover-letter',
  'rescore',
  'fetch-post',
  'brief',
  'close-gap',
  'revise',
  'note',
]

function text(value, max) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw.length > (max || MAX_TEXT) ? raw.slice(0, max || MAX_TEXT) : raw
}

/** Build a well-formed request from whatever the preview sent. */
export function newRequest(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const kind = REQUEST_KINDS.indexOf(raw.kind) === -1 ? 'note' : raw.kind
  const detail = raw.detail !== null && typeof raw.detail === 'object' ? raw.detail : {}
  return {
    id: 'req-' + randomUUID().slice(0, 8),
    kind,
    // A one-line human summary the panel and jobcv_context show.
    summary: text(raw.summary, 300),
    // Free-form structured detail (a gap id, a marked line, a motivation note).
    detail: {
      note: text(detail.note, MAX_TEXT),
      gapId: text(detail.gapId, 40),
      section: text(detail.section, 200),
      current: text(detail.current, MAX_TEXT),
      need: text(detail.need, MAX_TEXT),
    },
    at: Date.now(),
  }
}

/** Defend the stored shape on read, like every other record field. */
export function readRequests(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : null
    if (id === null) continue
    out.push({
      id,
      kind: REQUEST_KINDS.indexOf(entry.kind) === -1 ? 'note' : entry.kind,
      summary: text(entry.summary, 300),
      detail:
        entry.detail !== null && typeof entry.detail === 'object'
          ? {
              note: text(entry.detail.note, MAX_TEXT),
              gapId: text(entry.detail.gapId, 40),
              section: text(entry.detail.section, 200),
              current: text(entry.detail.current, MAX_TEXT),
              need: text(entry.detail.need, MAX_TEXT),
            }
          : {},
      at: Number.isFinite(entry.at) ? entry.at : 0,
    })
    if (out.length >= MAX_REQUESTS) break
  }
  return out
}
