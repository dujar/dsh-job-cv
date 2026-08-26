/**
 * Normalized block diff between two CV documents.
 *
 * Tailored CVs differ from the master mostly in emphasis, ordering and
 * phrasing of whole lines, so the unit of comparison is the TEXT BLOCK — a
 * heading, a bullet, a paragraph — not markup. Styling churn (class names,
 * spacing, inline CSS) never reaches the diff; only words can.
 *
 * The diff is deliberately MECHANICAL and lives in host code: an LLM asked to
 * "diff these two CVs" burns tokens producing what this module computes for
 * free, deterministically, and the same way every time. The result feeds
 * three consumers — the "vs master" panel in the preview, compact delta
 * summaries for choosing a base, and folding improvements back into the
 * master — and none of them needs anything cleverer than an LCS over blocks.
 */

/**
 * Upper bounds that keep the DP table small no matter what an agent wrote.
 * A two-page CV normalizes to well under 200 blocks; 500 blocks of 320
 * characters is already far past document-shaped, and past either bound the
 * diff degrades honestly (blocks beyond the cap are dropped; a huge block
 * list marks everything changed) rather than grinding.
 */
export const MAX_BLOCKS = 500
export const MAX_BLOCK_CHARS = 320

const ENTITIES = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bull: '•',
  middot: '·',
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
      try {
        const code = parseInt(hex, 16)
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      } catch {
        return ''
      }
    })
    .replace(/&#([0-9]+);/g, function (_, dec) {
      try {
        const code = parseInt(dec, 10)
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      } catch {
        return ''
      }
    })
    .replace(/&([a-z]+);/gi, function (whole, name) {
      const found = ENTITIES[name.toLowerCase()]
      return found === undefined ? whole : found
    })
    .replace(/&amp;/g, '&') // last, so &amp;lt; lands as "&lt;" and not "<"
}

/** The tags whose boundaries start a new block. Both open and close count. */
const BLOCK_BOUNDARY =
  /<\/?(?:p|div|li|ul|ol|dl|dd|dt|h[1-6]|table|thead|tbody|tr|td|th|section|article|header|footer|main|aside|nav|figure|figcaption|blockquote|pre|br|hr)\b[^>]*>/gi

/**
 * The readable text of an HTML document as ordered normalized blocks.
 *
 * Head material is dropped outright: <style> rules and the <title> are not
 * CV content, and letting them through would make two renders of the same
 * words differ. What survives is body text only, whitespace-collapsed per
 * block, capped so one pathological document cannot blow up the comparison.
 */
export function htmlBlocks(html) {
  const raw = String(html === undefined || null === html ? '' : html)
  if (raw.trim() === '') return []
  let text = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // Source whitespace collapses FIRST (indentation and element-internal
    // line-wrapping are formatting, not content), so the ONLY newlines left
    // in the string afterwards are the ones the next step stamps in.
    .replace(/\s+/g, ' ')
    // Block boundaries become real newlines; every remaining tag is noise.
    .replace(BLOCK_BOUNDARY, '\n')
    .replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)
  const blocks = []
  for (const line of text.split('\n')) {
    const block = line.trim()
    if (block === '') continue
    blocks.push(block.length > MAX_BLOCK_CHARS ? block.slice(0, MAX_BLOCK_CHARS) : block)
    if (blocks.length >= MAX_BLOCKS) break
  }
  return blocks
}

/**
 * The LCS edit script between two block lists: runs of same/add/del in
 * document order, consecutive identical ops merged into one entry.
 *
 * The table is bounded by MAX_BLOCKS on both sides (~1MB of Int32), which is
 * also why the inputs are capped before getting here. Same-block equality is
 * exact string equality after normalization — near-miss wording shows as a
 * del+add pair, which is exactly how the panel wants to display it anyway.
 */
export function diffBlocks(before, after) {
  const a = Array.isArray(before) ? before : []
  const b = Array.isArray(after) ? after : []
  if (a.length === 0 && b.length === 0) return []
  if (a.length === 0) return [{ op: 'add', text: b.join('\n') }]
  if (b.length === 0) return [{ op: 'del', text: a.join('\n') }]

  const n = a.length
  const m = b.length
  const width = m + 1
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)])
    }
  }

  const ops = []
  function push(op, text) {
    const last = ops[ops.length - 1]
    if (last !== undefined && last.op === op) last.text += '\n' + text
    else ops.push({ op: op, text: text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i])
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      push('del', a[i])
      i += 1
    } else {
      push('add', b[j])
      j += 1
    }
  }
  for (; i < n; i++) push('del', a[i])
  for (; j < m; j++) push('add', b[j])
  return ops
}

/** How many changes the response carries before it says "and more". */
export const MAX_CHANGES = 80

/** One change entry shipped to the browser or the agent. */
const MAX_CHANGE_CHARS = 400

/**
 * Counts plus the change-only view of an edit script. Unchanged blocks are
 * counted (`same`) but not shipped: the reader wants what tailoring CHANGED,
 * and the counts say how much of the document did not move.
 */
export function summarizeDiff(ops) {
  let added = 0
  let removed = 0
  let same = 0
  const changes = []
  let truncated = false
  for (const entry of Array.isArray(ops) ? ops : []) {
    const lines = String(entry.text).split('\n')
    if (entry.op === 'same') {
      same += lines.length
      continue
    }
    if (entry.op === 'add') added += lines.length
    else removed += lines.length
    for (const line of lines) {
      if (changes.length >= MAX_CHANGES) {
        truncated = true
        break
      }
      changes.push({
        op: entry.op,
        text: line.length > MAX_CHANGE_CHARS ? line.slice(0, MAX_CHANGE_CHARS) : line,
      })
    }
  }
  return { added: added, removed: removed, same: same, changes: changes, truncated: truncated }
}
