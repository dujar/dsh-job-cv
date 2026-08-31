/**
 * The severity and grading vocabularies the fit assessment uses.
 *
 * Shared between the store (lib/store/fit.js coerces an agent's assessment)
 * and the browser bundle (lib/client/027-cv-fit.js renders it and paints the
 * post-page marks). Kept here so a fourth severity, or a renamed grade, is a
 * one-file change — the fit panel, the CSS convention and the contract text
 * cannot then drift apart.
 */

/** Gap severity, worst first — the panel is read top-down and stops early. */
export const SEVERITIES = ['blocker', 'major', 'minor']

/**
 * What a gap's fix actually is, so the panel can render a question
 * differently from a rewrite instead of showing flat text for both.
 */
export const GAP_KINDS = ['rewrite', 'supply-fact', 'prepare-story', 'structural']

/**
 * How solid a strength is — mirrors the "Tier 1 safe / Tier 2 audit
 * required" split the persona already reasons in.
 */
export const STRENGTH_GRADES = ['proven', 'claimed', 'adjacent']

/** What the score is chiefly deciding on — a low number means different things. */
export const DECIDED_BY = ['stack-fit', 'level', 'domain', 'evidence-depth', 'logistics']

/** Coerce to a member of `list`, or `fallback` (default '') when it is not one. */
export function oneOf(value, list, fallback) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return list.indexOf(raw) === -1 ? (fallback === undefined ? '' : fallback) : raw
}
