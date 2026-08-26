import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// The tracker's pure helpers: what a tag looks like, how an activity age is
// phrased, and the message "Resume here" composes — the thing the agent
// actually acts on. The panel itself needs a DOM; these do not.
const require = createRequire(import.meta.url)
let spec = null
globalThis.window = { __ModuleLoader__: { load: (s) => (spec = s) } }
globalThis.document = { body: null }
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
}
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const mod = spec.factory((n) => (n === 'react' ? require('react') : { createPortal: () => null }))
const T = mod.__tracker

// The five tags, in pipeline order — the select offers exactly these.
assert.deepEqual(T.STATUS_ORDER, ['drafting', 'applied', 'interview', 'offer', 'rejected'])

// Untagged reads as drafting everywhere it is shown.
assert.equal(T.effectiveStatus(null), 'drafting')
assert.equal(T.effectiveStatus({}), 'drafting')
assert.equal(T.effectiveStatus({ status: 'rejected' }), 'rejected')

// Every tag paints, and no two tags paint alike (a colorblind-safe tracker
// still needs distinct hues to be readable at a glance).
const colors = T.STATUS_ORDER.map((s) => T.statusColor(s, true))
assert.ok(
  colors.every((c) => typeof c === 'string' && c !== ''),
  'dark theme colors exist',
)
assert.equal(new Set(colors).size, T.STATUS_ORDER.length, 'tags are distinguishable')
assert.notEqual(T.statusColor('applied', false), T.statusColor('applied', true))

// relTime: inside an hour it counts minutes, then hours, days, then a date.
assert.equal(T.relTime(Date.now() - 10 * 1000), 'just now')
assert.equal(T.relTime(Date.now() - 5 * 60 * 1000), '5m ago')
assert.equal(T.relTime(Date.now() - 3 * 60 * 60 * 1000), '3h ago')
assert.equal(T.relTime(Date.now() - 2 * 24 * 60 * 60 * 1000), '2d ago')
const old = T.relTime(Date.now() - 40 * 24 * 60 * 60 * 1000)
assert.ok(old !== '' && !old.includes('ago'), 'beyond a week it becomes a date: ' + old)
assert.equal(T.relTime(0), '', 'no timestamp, no phrasing')

// shortDate never throws on junk and renders something for real stamps.
assert.equal(T.shortDate(0), '')
assert.ok(T.shortDate(Date.now()).length > 0)

// Rows are identified by folder + session, so two sessions of one candidacy
// can never collide and a folder-less draft still gets its own key.
assert.equal(T.applicationKey({ workspace: '/a/b', sessionId: 's1' }), '/a/b|s1')
assert.notEqual(
  T.applicationKey({ workspace: '/a/b', sessionId: 's1' }),
  T.applicationKey({ workspace: '/a/b', sessionId: 's2' }),
)
assert.equal(T.applicationKey({ workspace: '', sessionId: 's1' }), '|s1')

// Labels: company — title, with the folder-name fallback for candidacies a
// hand-kept convention created before the plugin knew them.
assert.equal(
  T.applicationLabel({ company: 'Acme Corp', jobTitle: 'Engineer' }),
  'Acme Corp — Engineer',
)
assert.equal(T.applicationLabel({ company: 'Acme Corp', jobTitle: '' }), 'Acme Corp')
assert.equal(
  T.applicationLabel({ company: '', jobTitle: '', workspace: '/apps/acme-corp/42' }),
  'acme-corp',
  'the company hides in the second-to-last path segment',
)
assert.equal(T.applicationLabel(null), 'Untitled application')

// The optimistic display keeps the day they applied and caps its log.
var opt = T.optimisticApplication(null, 'applied', 'portal')
assert.equal(opt.status, 'applied')
assert.ok(opt.appliedAt > 0, 'landing on applied stamps the date')
var later = T.optimisticApplication(opt, 'interview', 'Fri')
assert.equal(later.appliedAt, opt.appliedAt, 'the stamp does not move')
assert.equal(later.log.length, 2)
var capped = opt
for (let i = 0; i < 30; i++) capped = T.optimisticApplication(capped, 'interview', 'x')
assert.ok(capped.log.length <= 20, 'the log stays bounded')

// The resume message carries everything the agent needs and nothing invented:
// the exact folder, the link when there is one, the exact session id spelling,
// and the adopt-don't-fork instruction that makes the upsert an upsert.
const msg = T.buildResumeMessage(
  {
    workspace: '/apps/acme-corp/42',
    jobUrl: 'https://jobs.example.com/42',
    cvVersion: 3,
    company: 'Acme Corp',
    jobTitle: 'Engineer',
  },
  'session-abcd',
)
assert.ok(msg.includes('/apps/acme-corp/42'), 'names the folder')
assert.ok(msg.includes('https://jobs.example.com/42'), 'names the link')
assert.ok(msg.includes('Session id: session-abcd'), 'states the session id verbatim')
assert.ok(msg.includes('created:false'), 'tells the agent to adopt, not fork')
assert.ok(msg.includes('cv/latest.html'), 'points at the latest saved CV')
assert.ok(msg.includes('v3'), 'says how far the CV got')

// A row without a link or version still produces a usable message.
const bare = T.buildResumeMessage({ workspace: '/a/b', sessionId: 'x' }, 'session-y')
assert.ok(bare.includes('/a/b'))
assert.ok(!bare.includes('undefined'), 'missing fields are omitted, never printed')

// ---- the workbench: search, filters, sort over the fetched listing ----
{
  const NOW = Date.now()
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  function row(over) {
    return Object.assign(
      {
        sessionId: 's1',
        workspace: '/apps/acme-corp/1',
        company: 'Acme Corp',
        jobTitle: 'Engineer',
        jobUrl: 'https://jobs.example.com/1',
        cvVersion: 2,
        letterVersion: 0,
        postChars: 500,
        fitScore: 62,
        activity: NOW - 2 * DAY,
        application: {
          status: 'applied',
          statusUpdatedAt: NOW - 1 * DAY,
          appliedAt: NOW - 3 * DAY,
          note: 'via careers portal',
          log: [],
        },
      },
      over,
    )
  }
  const rows = [
    row({ sessionId: 'r1' }),
    row({
      sessionId: 'r2',
      company: 'Globex',
      jobTitle: 'Senior Engineer',
      jobUrl: 'https://jobs.example.com/2',
      workspace: '/apps/globex/9',
      cvVersion: 0,
      letterVersion: 1,
      postChars: 0,
      fitScore: null,
      activity: NOW - 40 * DAY,
      application: {
        status: 'rejected',
        statusUpdatedAt: NOW - 40 * DAY,
        appliedAt: NOW - 45 * DAY,
        note: '',
        log: [],
      },
    }),
    row({
      sessionId: 'r3',
      company: 'Initech',
      jobTitle: 'Backend Engineer',
      jobUrl: 'https://boards.greenhouse.io/initech/jobs/7',
      workspace: '/apps/initech/backend-7',
      cvVersion: 1,
      letterVersion: 0,
      postChars: 0,
      fitScore: 81,
      activity: NOW - 2 * HOUR,
      application: null,
    }),
    row({
      sessionId: 'r4',
      company: 'Acme Corp',
      jobTitle: 'Platform Engineer',
      jobUrl: 'https://jobs.example.com/4',
      workspace: '',
      cvVersion: 0,
      letterVersion: 0,
      postChars: 0,
      fitScore: null,
      activity: NOW - 10 * 60 * 1000,
      application: null,
    }),
  ]

  // SEARCH: every whitespace term must land somewhere on the row.
  assert.equal(T.applicationMatchesQuery(rows[0], ''), true, 'an empty query hides nothing')
  assert.equal(T.applicationMatchesQuery(rows[0], 'acme'), true)
  assert.equal(T.applicationMatchesQuery(rows[0], 'ACME engineer'), true, 'case folds, terms AND')
  assert.equal(T.applicationMatchesQuery(rows[0], 'acme globex'), false)
  assert.equal(T.applicationMatchesQuery(rows[2], 'greenhouse'), true, 'the link is searchable')
  assert.equal(T.applicationMatchesQuery(rows[0], 'portal'), true, 'notes are searchable')
  assert.equal(T.applicationMatchesQuery(rows[0], '/apps/acme-corp'), true, 'so is the folder path')

  // FILTERS: the quiet state matches everything.
  assert.deepEqual(T.defaultFilters(), {
    statuses: [],
    company: '',
    has: [],
    fitBand: 'any',
    recency: 'any',
  })
  assert.equal(T.filtersActive(T.defaultFilters()), 0)
  assert.equal(T.filtersActive({ ...T.defaultFilters(), fitBand: 'strong' }), 1)

  // Artifact presence: one definition drives chips and filters alike.
  assert.equal(T.applicationHas(rows[0], 'cv'), true)
  assert.equal(T.applicationHas(rows[0], 'letter'), false)
  assert.equal(T.applicationHas(rows[1], 'letter'), true)
  assert.equal(T.applicationHas(rows[1], 'cv'), false)
  assert.equal(T.applicationHas(rows[1], 'note'), false, 'an empty note is no note')
  assert.equal(T.applicationHas(rows[0], 'post'), true)

  // Fit bands mirror the fit panel's thresholds; unscored is its own bucket.
  assert.equal(T.applicationFitBand(rows[0]), 'partial')
  assert.equal(T.applicationFitBand(rows[2]), 'strong')
  assert.equal(T.applicationFitBand(rows[1]), 'unscored')
  assert.equal(T.applicationFitBand({ ...row({}), fitScore: 30 }), 'thin')

  // Recency buckets on the activity stamp.
  assert.equal(T.applicationRecency(rows[3]), '24h')
  assert.equal(T.applicationRecency(rows[0]), '7d')
  assert.equal(T.applicationRecency(rows[2]), '24h')
  assert.equal(T.applicationRecency(rows[1]), 'older')
  assert.equal(T.applicationRecency({ activity: 0 }), 'older', 'never-touched is the oldest')

  const f = T.defaultFilters()
  f.statuses = ['applied']
  assert.deepEqual(
    T.filterApplications(rows, '', f).map((r) => r.sessionId),
    ['r1'],
    'one stage selected keeps only that stage',
  )
  const fMulti = T.defaultFilters()
  fMulti.statuses = ['applied', 'drafting']
  assert.deepEqual(
    T.filterApplications(rows, '', fMulti).map((r) => r.sessionId),
    ['r1', 'r3', 'r4'],
    'untagged rows read as drafting',
  )
  const fHas = T.defaultFilters()
  fHas.has = ['cv', 'letter']
  assert.deepEqual(T.filterApplications(rows, '', fHas), [], 'artifact facets AND together')
  const fCompany = T.defaultFilters()
  fCompany.company = 'Acme Corp'
  assert.equal(T.filterApplications(rows, '', fCompany).length, 2)
  const fCompanyCase = T.defaultFilters()
  fCompanyCase.company = 'acme corp'
  assert.equal(
    T.filterApplications(rows, '', fCompanyCase).length,
    2,
    'the facet matches case-folded',
  )
  // A row without an explicit company facets under its folder-derived name,
  // and picking that facet finds it (facet and filter resolve identically).
  const fDerived = T.defaultFilters()
  fDerived.company = 'acme-corp'
  assert.deepEqual(T.facetCompanies([row({ company: '' }), row({ company: '  ' })]), ['acme-corp'])
  assert.equal(T.filterApplications([row({ company: '' })], '', fDerived).length, 1)
  const fFit = T.defaultFilters()
  fFit.fitBand = 'unscored'
  assert.deepEqual(
    T.filterApplications(rows, '', fFit).map((r) => r.sessionId),
    ['r2', 'r4'],
  )
  const fRec = T.defaultFilters()
  fRec.recency = 'older'
  assert.deepEqual(
    T.filterApplications(rows, '', fRec).map((r) => r.sessionId),
    ['r2'],
    'quiet 30+ days is a filter, not an insult',
  )

  // Query narrows what facets already chose.
  const fq = T.defaultFilters()
  fq.company = 'Acme Corp'
  assert.deepEqual(
    T.filterApplications(rows, 'platform', fq).map((r) => r.sessionId),
    ['r4'],
  )

  // SORT: direction flips the comparison; "missing" stays last either way;
  // ties settle by activity, newest first. The input array is never mutated.
  const byFitDesc = T.sortApplications(rows, 'fitScore', 'desc')
  assert.deepEqual(
    byFitDesc.map((r) => r.sessionId),
    ['r3', 'r1', 'r4', 'r2'],
    'scored rows lead (best first); unscored sink regardless of direction',
  )
  const byFitAsc = T.sortApplications(rows, 'fitScore', 'asc')
  assert.deepEqual(
    byFitAsc.map((r) => r.sessionId),
    ['r1', 'r3', 'r4', 'r2'],
    'ascending starts at the weakest score, unscored still last',
  )

  const byAppliedAsc = T.sortApplications(rows, 'appliedAt', 'asc')
  assert.deepEqual(
    byAppliedAsc.map((r) => r.sessionId),
    ['r2', 'r1', 'r4', 'r3'],
    'oldest real stamp first; no stamp sinks on either direction',
  )
  const byAppliedDesc = T.sortApplications(rows, 'appliedAt', 'desc')
  assert.equal(byAppliedDesc[0].sessionId, 'r1', 'newest stamp leads descending')

  const byCompany = T.sortApplications(rows, 'company', 'asc')
  assert.deepEqual(
    byCompany.map((r) => r.company),
    ['Acme Corp', 'Acme Corp', 'Globex', 'Initech'],
    'company sorts case-folded alphabetically',
  )

  const byStage = T.sortApplications(rows, 'status', 'asc')
  assert.deepEqual(
    byStage.map((r) => T.effectiveStatus(r.application)),
    ['drafting', 'drafting', 'applied', 'rejected'],
    'stage follows the pipeline order',
  )

  const original = rows.map((r) => r.sessionId)
  T.sortApplications(rows, 'company', 'desc')
  assert.deepEqual(
    rows.map((r) => r.sessionId),
    original,
    'sorting returns a copy',
  )

  // FACETS: distinct companies, case-folded, alphabetical.
  assert.deepEqual(T.facetCompanies(rows), ['Acme Corp', 'Globex', 'Initech'])
  assert.deepEqual(T.facetCompanies([]), [], 'an empty listing offers no facets')

  // COUNTS always measure the FULL listing, so chips do not shrink as they narrow.
  const counts = T.countByStatus(rows)
  assert.equal(counts.applied, 1)
  assert.equal(counts.rejected, 1)
  assert.equal(counts.drafting, 2)

  // PREFERENCES: view/sort/filters survive the panel; junk degrades to fresh.
  const key = T.trackerPrefsKey('session-x')
  assert.ok(key.startsWith('dsh-job-cv:tracker:'))
  T.saveTrackerPrefs('session-x', {
    view: 'board',
    sortField: 'fitScore',
    sortDir: 'asc',
    filters: { ...T.defaultFilters(), statuses: ['offer'], has: ['cv'] },
  })
  const prefs = T.loadTrackerPrefs('session-x')
  assert.equal(prefs.view, 'board')
  assert.equal(prefs.sortField, 'fitScore')
  assert.equal(prefs.sortDir, 'asc')
  assert.deepEqual(prefs.filters.statuses, ['offer'])
  assert.deepEqual(prefs.filters.has, ['cv'])
  localStorage.setItem(
    key,
    JSON.stringify({
      view: 'kanban',
      sortField: 'vibes',
      sortDir: 'sideways',
      filters: { statuses: ['hired', 'offer'], has: ['salary'], fitBand: 7 },
    }),
  )
  const junk = T.loadTrackerPrefs('session-x')
  assert.equal(junk.view, 'list', 'unknown views fall back')
  assert.equal(junk.sortField, 'activity', 'unknown sort fields fall back')
  assert.equal(junk.sortDir, 'desc')
  assert.deepEqual(junk.filters.statuses, ['offer'], 'unknown stages drop, known ones stay')
  assert.deepEqual(junk.filters.has, [], 'unknown artifact tokens drop')
  assert.equal(junk.filters.fitBand, 'any', 'a non-string band falls back')
  localStorage.setItem(key, '{ truncated')
  assert.deepEqual(T.loadTrackerPrefs('session-x').filters, T.defaultFilters())

  console.log('ok  tracker-ui workbench (search, filters, sort, prefs)')
}
console.log('ok  tracker-ui helpers')
