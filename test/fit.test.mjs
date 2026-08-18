import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { normalizeFit, readFit } from '../lib/store/fit.js'
import { normalizeBrief, readBrief } from '../lib/store/post-brief.js'

// The fit assessment: a percentage is only worth showing if it is about a
// document that still exists, and a gap is only worth showing if the user can
// do something about it today.

// ---- what the host will accept from an agent ----
const fit = normalizeFit(
  {
    score: '68.6',
    verdict: 'Strong platform record, no evidence of the team-lead scope they ask for',
    gaps: [
      {
        requirement: 'Team leadership',
        severity: 'minor',
        why: 'Asked for',
        fix: 'Name the team size',
      },
      { requirement: 'Kubernetes at scale', severity: 'BLOCKER', fix: 'How many clusters?' },
      { requirement: 'Terraform', severity: 'nonsense', why: 'Listed', fix: 'Add a bullet' },
      { requirement: '   ', severity: 'blocker' },
      'not an object',
    ],
    strengths: [
      { requirement: 'Go', evidence: '4 years across two employers' },
      { evidence: 'orphan' },
    ],
  },
  4,
  2,
)
assert.equal(fit.score, 69, 'a score is rounded and clamped into 0..100')
assert.equal(fit.basedOnVersion, 4)
assert.equal(fit.basedOnLetter, 2, 'the letter is judged too, and says so')
assert.equal(fit.gaps.length, 3, 'a gap with no requirement is not a gap')
assert.equal(
  fit.gaps[0].severity,
  'blocker',
  'blockers sort to the top — the panel is read top-down',
)
assert.equal(fit.gaps[0].requirement, 'Kubernetes at scale')
assert.equal(fit.gaps[1].severity, 'major', 'an unknown severity degrades to major, not to nothing')
assert.equal(fit.gaps[1].requirement, 'Terraform')
assert.equal(fit.gaps[2].severity, 'minor', 'and polish sorts last')
assert.equal(fit.strengths.length, 1, 'a strength with no requirement is dropped')
assert.ok(fit.updatedAt > 0)

assert.equal(normalizeFit({ score: 140 }, 1, 0).score, 100)
assert.equal(normalizeFit({ score: -5 }, 1, 0).score, 0)
assert.equal(normalizeFit({ verdict: 'close' }, 1, 0), null, 'a fit with no score is not a fit')
assert.equal(normalizeFit({ score: 'soon' }, 1, 0), null, 'and neither is an unparseable one')
assert.equal(readFit({ score: 50, gaps: 'nope' }).gaps.length, 0, 'a stored record degrades')
assert.equal(readFit(null), null)

// ---- the post breakdown: what a candidate reads instead of the dump ----
const brief = normalizeBrief({
  sections: [
    {
      title: 'About the company',
      body: "Acme runs the ledgers for a third of Berlin's small banks, since 2009.",
      source: 'company site',
    },
    { title: 'The team', body: '   ', source: 'posting' },
    { title: 'The job', body: 'You own the platform four product teams build on.' },
    { title: 'Requirements', body: '8+ years backend, 2 leading others.', source: 'posting' },
    { title: 'Estimate territory', body: 'Likely a 40-person org.', source: 'estimate' },
  ],
  meta: [
    { label: 'Location', value: 'Berlin (hybrid)' },
    { label: 'Posted', value: '7 days ago' },
    { label: 'Applicants', value: 'Over 200' },
    { label: '', value: 'dropped' },
    { label: 'Salary', value: '  ' },
  ],
})
assert.equal(brief.sections.length, 4, 'a section with no body is not a section')
assert.equal(brief.sections[0].title, 'About the company')
assert.equal(brief.sections[0].source, 'company site', 'every section names its source')
assert.equal(brief.meta.length, 3, 'a meta fact needs both halves')
assert.equal(brief.meta[2].value, 'Over 200')
assert.ok(brief.updatedAt > 0)
assert.equal(normalizeBrief({}), null, 'a brief with nothing in it is not a brief')
assert.equal(readBrief(null), null)
assert.equal(readBrief({ sections: 'nope' }), null, 'a stored record degrades to nothing usable')

// ---- the browser half ----
const require = createRequire(import.meta.url)
let spec = null
globalThis.window = { __ModuleLoader__: { load: (s) => (spec = s) } }
globalThis.document = { body: null }
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const mod = spec.factory((n) => (n === 'react' ? require('react') : { createPortal: () => null }))
const F = mod.__fit

// A score is about a version. The CV moves underneath it, and a stale score
// read as a current one is worse than no score.
assert.equal(
  F.fitStale({ basedOnVersion: 4, basedOnLetter: 0 }, { version: 4, letter: null }),
  false,
)
assert.equal(
  F.fitStale({ basedOnVersion: 4, basedOnLetter: 0 }, { version: 5, letter: null }),
  true,
)
assert.equal(
  F.fitStale({ basedOnVersion: 4, basedOnLetter: 1 }, { version: 4, letter: { version: 2 } }),
  true,
  'a letter revision dates the score as surely as a CV save',
)

assert.equal(F.fitBand(90).key, 'strong')
assert.equal(F.fitBand(75).key, 'strong')
assert.equal(F.fitBand(74).key, 'partial')
assert.equal(F.fitBand(49).key, 'thin')

// ---- the message a gap turns into ----
const one = F.buildGapMessage([fit.gaps[0]], { version: 4, jobUrl: 'https://jobs.example/42' })
assert.ok(one.includes('Close this gap in my candidacy (CV v4)'))
assert.ok(one.includes('[blocker] Kubernetes at scale'), 'the severity travels with it')
assert.ok(one.includes('Your move: How many clusters?'), "the agent's own fix is quoted back")
assert.ok(one.includes('Job post: https://jobs.example/42'))
assert.ok(one.includes('ask me for any fact you need instead of writing one'))
assert.ok(one.includes('/jobcv/fit'), 'and the score is asked to move once the document does')

const many = F.buildGapMessage(fit.gaps, { version: 4, jobUrl: '' })
assert.ok(many.includes('Close these 3 gaps'))
assert.ok(!many.includes('Job post:'), 'no link, no link line')

// The browser cannot fetch a job board itself — most are cross-origin — so the
// refresh button is a chat request that rides the same delivery path.
const fetchAsk = F.buildPostFetchRequest({ jobUrl: 'https://jobs.example/42' })
assert.ok(fetchAsk.includes('Fetch the job post for me'))
assert.ok(fetchAsk.includes('Job post: https://jobs.example/42'))
assert.ok(fetchAsk.includes('POST the readable text to /jobcv/post'))
assert.ok(fetchAsk.includes('rebuild the breakdown'), 'a changed post should re-brief')
assert.ok(
  F.buildBriefRequest({ jobUrl: '' }).includes('dsh-gap'),
  'the breakdown ask includes the page and its marks',
)
assert.ok(F.buildBriefRequest({ jobUrl: '' }).includes('data URI'), 'and the logo rule')
assert.ok(
  F.POST_GAP_CSS.includes('blocker') && F.POST_GAP_CSS.includes('minor'),
  'the red convention expresses every severity',
)
assert.ok(fetchAsk.includes('paste'), 'and a thin scrape comes back to me, not to an invention')
assert.ok(!F.buildPostFetchRequest({ jobUrl: '' }).includes('Job post:'), 'no link, no link line')

const ask = F.buildFitRequest({
  version: 4,
  jobUrl: 'https://jobs.example/42',
  letter: { version: 2 },
})
assert.ok(ask.includes('Score my fit'))
assert.ok(ask.includes('CV: v4, cover letter v2'), 'it names what it wants scored')
assert.ok(ask.includes('/jobcv/post'), 'and where the requirements live')
assert.ok(ask.includes('evidence against the requirements, not the vocabulary'))

// ---- the poll must be able to SEE a fit arrive ----
// A fit, a proposal and a letter all land without bumping the CV version or
// its html. A poll that compares only those two discards them, and the panel
// never opens until some later save happens to change the document.
const base = {
  version: 4,
  html: '<p>x</p>',
  jobUrl: '',
  workspace: '',
  company: '',
  jobTitle: '',
  postChars: 0,
  postUpdatedAt: 0,
  fit: null,
  briefUpdatedAt: 0,
  postHtmlUpdatedAt: 0,
  letter: null,
  proposal: null,
}
const D = mod.__diagnostics
assert.equal(D.sameDoc(base, { ...base }), true)
assert.equal(
  D.sameDoc(base, { ...base, fit: { score: 68, updatedAt: 9 } }),
  false,
  'a score arriving is news',
)
assert.equal(
  D.sameDoc(
    { ...base, fit: { score: 68, updatedAt: 9 } },
    { ...base, fit: { score: 71, updatedAt: 10 } },
  ),
  false,
  'and so is a re-score',
)
assert.equal(D.sameDoc(base, { ...base, proposal: { id: 'p-1' } }), false, 'so is a proposal')
assert.equal(D.sameDoc(base, { ...base, letter: { version: 1 } }), false, 'so is a cover letter')
assert.equal(D.sameDoc(base, { ...base, postChars: 4200 }), false, 'so is the job post landing')
assert.equal(
  D.sameDoc(base, { ...base, briefUpdatedAt: 42 }),
  false,
  'and so is the breakdown of it',
)
assert.equal(
  D.sameDoc(base, { ...base, postHtmlUpdatedAt: 9 }),
  false,
  'and so is the styled page of it',
)

// ---- the working state ends when the THING ASKED FOR lands, not before ----
// A CV save does not end a letter request: the letter is what was asked for,
// and a save landing while it is in flight is someone else's progress.
const from = (target, extra = {}) => ({
  target,
  version: 3,
  letterVersion: 1,
  postUpdatedAt: 5,
  postHtmlUpdatedAt: 0,
  briefUpdatedAt: 0,
  fitUpdatedAt: 0,
  ...extra,
})
const next = {
  version: 4,
  letter: { version: 2 },
  postUpdatedAt: 6,
  postHtmlUpdatedAt: 0,
  briefUpdatedAt: 0,
  fit: { updatedAt: 10 },
}
assert.equal(D.workingDone(from('cv'), next), null, 'a CV save ends a CV request')
// But the state must be SEEN before it is allowed to end: a fast agent can
// save inside one poll window, and a loading that never shows may as well
// not exist.
const young = { ...from('cv'), startedAt: Date.now() }
assert.ok(
  D.workingDone(young, next) !== null,
  'a save landing instantly does not blink the loading away',
)
const mature = { ...from('cv'), startedAt: Date.now() - 4000 }
assert.equal(D.workingDone(mature, next), null, 'once it has been visible, the save ends it')
assert.ok(
  D.workingDone(from('cv'), { ...next, version: 3 }) !== null,
  'no CV save, the CV request stands',
)
assert.equal(D.workingDone(from('letter'), next), null, 'a letter save ends a letter request')
assert.ok(
  D.workingDone(from('letter'), { ...next, letter: { version: 1 } }) !== null,
  'the CV saving does not end the letter request',
)
assert.equal(D.workingDone(from('post'), next), null, 'new post text ends a post request')
assert.ok(
  D.workingDone(from('post'), { ...next, postUpdatedAt: 5, postHtmlUpdatedAt: 0 }) !== null,
  'an untouched post leaves the request standing',
)
assert.equal(D.workingDone(from('fit'), next), null, 'a fresh score ends a fit request')
assert.ok(
  D.workingDone(from('fit', { fitUpdatedAt: 10 }), { ...next, fit: { updatedAt: 10 } }) !== null,
  'a score that has not moved leaves the request standing',
)
assert.equal(D.sameDoc(base, { ...base, html: '<p>y</p>' }), false)

console.log('ok  fit: score, gaps, and a poll that can see them arrive')
