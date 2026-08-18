import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { normalizeProposal } from '../lib/store/proposal.js'

const require = createRequire(import.meta.url)
let spec = null
globalThis.window = { __ModuleLoader__: { load: (s) => (spec = s) } }
globalThis.document = { body: null, getElementById: () => null }
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const mod = spec.factory((n) => (n === 'react' ? require('react') : { createPortal: () => null }))
const R = mod.__review

// ---- the host normalizes whatever the agent emits ----
const proposal = normalizeProposal(
  {
    summary: 'The post screens for measurable delivery.',
    changes: [
      {
        id: 'c1',
        section: 'Experience',
        path: 'div.page > div.item > ul > li:nth-of-type(1)',
        current: 'Shipped a thing',
        why: 'the post asks for scale',
        options: [
          { id: 'a', label: 'Quantified', text: 'Shipped X to 40k users' },
          { id: 'b', label: 'Concise', text: 'Shipped X' },
        ],
      },
      {
        id: 'c2',
        section: 'Summary',
        current: 'A summary.',
        options: [{ id: 'a', label: 'Sharper', text: 'Backend engineer, 8 years.' }],
      },
    ],
  },
  3,
)
assert.equal(proposal.changes.length, 2)
assert.equal(proposal.basedOnVersion, 3)

// a change with no option is not reviewable and must not reach the panel
assert.equal(normalizeProposal({ changes: [{ current: 'x', options: [] }] }, 1), null)
assert.equal(normalizeProposal({ changes: [{ options: [{ text: '   ' }] }] }, 1), null)

// ---- pickedOption defaults to the first, honours an explicit pick ----
assert.equal(R.pickedOption(proposal.changes[0], {}).id, 'a')
assert.equal(R.pickedOption(proposal.changes[0], { optionId: 'b' }).id, 'b')
assert.equal(
  R.pickedOption(proposal.changes[0], { optionId: 'nope' }).id,
  'a',
  'stale id falls back',
)
assert.equal(R.pickedOption({ options: [] }, {}).text, '', 'no options never throws')

// ---- the decision message ----
const msg = R.buildDecisionMessage(proposal, {
  c1: { optionId: 'b' },
  c2: { refined: '  Backend engineer who ships.  ' },
})
assert.ok(msg.includes('2 of 2 to apply'))
assert.ok(msg.includes('USE your option "Concise", verbatim: "Shipped X"'))
assert.ok(
  msg.includes('USE MY WORDING, verbatim: "Backend engineer who ships."'),
  'a hand-written refinement wins over the options and is whitespace-normalized',
)
assert.ok(msg.includes('div.page > div.item > ul > li:nth-of-type(1)'), 'carries the anchor path')
assert.ok(msg.includes('do not re-word what I chose'), 'the choice is binding, not a suggestion')

// a skip is stated explicitly — silence would read as "do whatever you like"
const skipped = R.buildDecisionMessage(proposal, { c1: { skipped: true }, c2: {} })
assert.ok(skipped.includes('1 of 2 to apply'))
assert.ok(skipped.includes('SKIP — leave this exactly as it is.'))
assert.ok(skipped.includes('USE your option "Sharper"'))

// defaults: no decisions at all means every change takes its first option
const untouched = R.buildDecisionMessage(proposal, {})
assert.ok(untouched.includes('2 of 2 to apply'))
assert.ok(untouched.includes('"Shipped X to 40k users"'))

console.log('ok  review + proposal')
