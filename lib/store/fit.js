/**
 * The candidacy fit assessment: how well this CV answers this job post, and
 * what is missing.
 *
 * The agent judges it, not the browser. A keyword-overlap percentage computed
 * in the client would be cheap, always available and quietly wrong — it
 * cannot tell a requirement that is genuinely met from one that merely shares
 * a word, and a confident wrong number is worse than no number. So the score
 * arrives the way a proposal does: the agent reads the post and the document,
 * POSTs its judgement, and the preview renders exactly that.
 *
 * A gap is only worth showing if the user can act on it, so every gap carries
 * what would close it. "Missing Kubernetes" is a verdict; "no bullet names
 * the scale you ran it at — how many clusters, how many services?" is a next
 * move.
 */

import { SEVERITIES, GAP_KINDS, STRENGTH_GRADES, DECIDED_BY, oneOf } from '../shared/severity.js'

/** Bounds — an agent can emit anything, and this ends up in a browser. */
const MAX_ITEMS = 12
const MAX_TEXT = 600
const MAX_VERDICT = 400

function text(value, max) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw.length > max ? raw.slice(0, max) : raw
}

function severity(value) {
  return oneOf(value, SEVERITIES, 'major')
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * The level the CV's evidence supports vs the level it targets — the persona
 * computes this every time (LEVEL CALIBRATION) but the score used to absorb
 * it silently. null when the agent did not send one or it is unusable.
 */
function levelRead(value) {
  if (value === null || typeof value !== 'object') return null
  const supports = text(value.supports, 80)
  const targets = text(value.targets, 80)
  if (supports === '' && targets === '') return null
  return { supports, targets, gap: text(value.gap, MAX_TEXT) }
}

/**
 * Coerce an agent-authored assessment into a shape the browser can render.
 * Returns null when there is no usable score: a fit panel with no percentage
 * is a heading with nothing under it.
 */
export function normalizeFit(input, basedOnVersion, basedOnLetter) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const rawScore = typeof raw.score === 'string' ? Number(raw.score) : raw.score
  if (!Number.isFinite(rawScore)) return null
  const score = Math.max(0, Math.min(100, Math.round(rawScore)))

  const gaps = []
  for (const entry of Array.isArray(raw.gaps) ? raw.gaps.slice(0, MAX_ITEMS) : []) {
    if (entry === null || typeof entry !== 'object') continue
    const requirement = text(entry.requirement, MAX_TEXT)
    if (requirement === '') continue
    gaps.push({
      // A stable id, filled after the sort below; the post-page marks carry
      // the same value in data-dsh-gap-id.
      id: '',
      requirement: requirement,
      severity: severity(entry.severity),
      // What closing it actually IS: a rewrite, a fact only the user has, a
      // story to prepare, or a structural change. '' when the agent did not say.
      kind: oneOf(entry.kind, GAP_KINDS),
      why: text(entry.why, MAX_TEXT),
      fix: text(entry.fix, MAX_TEXT),
    })
  }
  // Blockers first: the panel is read top-down and stops being read early.
  gaps.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
  // The id is assigned AFTER the sort so g1 is always the first one shown.
  gaps.forEach((gap, i) => {
    gap.id = 'g' + (i + 1)
  })

  const strengths = []
  for (const entry of Array.isArray(raw.strengths) ? raw.strengths.slice(0, MAX_ITEMS) : []) {
    if (entry === null || typeof entry !== 'object') continue
    const requirement = text(entry.requirement, MAX_TEXT)
    if (requirement === '') continue
    strengths.push({
      requirement: requirement,
      evidence: text(entry.evidence, MAX_TEXT),
      // proven / claimed / adjacent — a rock-solid strength and a line of
      // prose used to render identically. '' when the agent did not grade it.
      strength: oneOf(entry.strength, STRENGTH_GRADES),
    })
  }

  return {
    score: score,
    verdict: text(raw.verdict, MAX_VERDICT),
    // What the score is chiefly deciding on: a 55 for a stack mismatch and a
    // 55 for a level gap are different problems. '' when unstated.
    decidedBy: oneOf(raw.decidedBy, DECIDED_BY),
    levelRead: levelRead(raw.levelRead),
    updatedAt: Date.now(),
    // Which documents were judged. A score is about a version, and the CV
    // moves underneath it — without this the panel cannot say it is stale.
    basedOnVersion: count(basedOnVersion),
    basedOnLetter: count(basedOnLetter),
    gaps: gaps,
    strengths: strengths,
  }
}

/** The stored shape, defended on read the way records are. */
export function readFit(value) {
  if (value === null || typeof value !== 'object') return null
  if (!Number.isInteger(value.score)) return null
  return {
    score: Math.max(0, Math.min(100, value.score)),
    verdict: typeof value.verdict === 'string' ? value.verdict : '',
    decidedBy: oneOf(value.decidedBy, DECIDED_BY),
    levelRead: levelRead(value.levelRead),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    basedOnVersion: count(value.basedOnVersion),
    basedOnLetter: count(value.basedOnLetter),
    gaps: Array.isArray(value.gaps) ? value.gaps.filter((g) => g && typeof g === 'object') : [],
    strengths: Array.isArray(value.strengths)
      ? value.strengths.filter((s) => s && typeof s === 'object')
      : [],
  }
}
