import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Render the preview's panels for real.
//
// There is no react-dom here, and a component that throws on render does not
// report itself — React unmounts the subtree and the user sees the dock, or
// the preview, simply gone. So this walks the element tree calling every
// component in it, with hooks stubbed to their initial values: enough to
// execute the render path of each panel and to read what it puts on screen.
const require = createRequire(import.meta.url)
const RealReact = require('react')

let hookDepth = 0
const stubReact = {
  createElement: RealReact.createElement,
  Fragment: RealReact.Fragment,
  Component: RealReact.Component,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

let spec = null
globalThis.window = { __ModuleLoader__: { load: (s) => (spec = s) } }
globalThis.document = { body: null, getElementById: () => null, createElement: () => ({}) }
// CvPane reads the per-session prefs on render; give it an empty store so the
// test stays hermetic instead of tripping node's experimental localStorage.
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const mod = spec.factory((n) => (n === 'react' ? stubReact : { createPortal: (c) => c }))
const UI = mod.__ui

/** Render an element tree to its visible text, calling every component in it. */
let capturedSrcDoc = null
function text(node, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node) + ' '
  if (Array.isArray(node)) return node.map((n) => text(n, depth)).join('')
  assert.ok(depth < 60, 'component tree did not bottom out')
  if (typeof node.type === 'function') {
    hookDepth += 1
    const rendered = node.type(node.props || {})
    hookDepth -= 1
    return text(rendered, depth + 1)
  }
  const p = node.props || {}
  // The posting page lives in a sandboxed iframe; its content is what the
  // assertions below read.
  if (node.type === 'iframe' && typeof p.srcDoc === 'string') capturedSrcDoc = p.srcDoc
  return text(p.children, depth + 1)
}

function render(component, props) {
  capturedSrcDoc = null
  return text(RealReact.createElement(component, props))
}

const pal = {
  dark: false,
  text: '#666',
  textStrong: '#111',
  panelBg: '#fafafa',
  panelBorder: '#ddd',
  baseBg: '#fff',
  controlBg: '#eee',
  controlBorder: '#ccc',
  controlActive: '#ddd',
  accent: '#2e6fdb',
}

// ---- the fit panel: the score, and what is missing ----
const fit = {
  score: 68,
  verdict: 'Strong platform record, no evidence of the lead scope they ask for',
  basedOnVersion: 4,
  basedOnLetter: 0,
  updatedAt: 1,
  gaps: [
    {
      requirement: 'Kubernetes at scale',
      severity: 'blocker',
      why: 'Named twice',
      fix: 'How many clusters?',
    },
    { requirement: 'Mentoring', severity: 'minor', why: '', fix: '' },
  ],
  strengths: [{ requirement: 'Go', evidence: '4 years' }],
}
const fitOut = render(UI.FitPanel, {
  pal,
  fit,
  doc: { version: 4, letter: null },
  onRescore: () => {},
  onAskGaps: () => {},
  onClose: () => {},
})
assert.ok(fitOut.includes('68%'), 'the score is the first thing on it')
assert.ok(fitOut.includes('Kubernetes at scale'))
assert.ok(fitOut.includes('blocker'))
assert.ok(fitOut.includes('How many clusters?'), 'and the move that closes the gap')
assert.ok(fitOut.includes('Ask to close all 2'))
assert.ok(fitOut.includes('not a probability of an offer'), 'the number says what it is not')

const staleOut = render(UI.FitPanel, {
  pal,
  fit,
  doc: { version: 6, letter: null },
  onRescore: () => {},
  onAskGaps: () => {},
  onClose: () => {},
})
assert.ok(staleOut.includes('the document has moved since'), 'a stale score says so')

// ---- the post surface ----
const postOut = render(UI.PostSurface, {
  pal,
  post: {
    text: 'We are hiring a Staff Engineer to own the platform.',
    source: 'agent',
    updatedAt: 2,
  },
  brief: null,
  briefLoading: false,
  doc: {
    company: 'Acme',
    jobTitle: 'Staff Engineer',
    jobUrl: 'https://jobs.example/42',
    postUpdatedAt: 2,
  },
  loading: false,
  sessionId: 's1',
  onSaved: () => {},
  onAskFetch: () => {},
  onAskBrief: () => {},
})
assert.ok(postOut.includes('Acme — Staff Engineer'))
assert.ok(postOut.includes('own the platform'), 'the post itself is readable in the preview')
assert.ok(postOut.includes('open the posting'), 'with a way back to the live posting')
assert.ok(postOut.includes('fetched by the agent'), 'and says where the text came from')
assert.ok(postOut.includes('Refresh'), 'a post with a link offers a re-fetch')

const emptyWithLink = render(UI.PostSurface, {
  pal,
  post: null,
  brief: null,
  briefLoading: false,
  doc: { company: '', jobTitle: '', jobUrl: 'https://jobs.example/42', postUpdatedAt: 0 },
  loading: false,
  sessionId: 's1',
  onSaved: () => {},
  onAskFetch: () => {},
  onAskBrief: () => {},
})
assert.ok(
  emptyWithLink.includes('Fetch the post for me'),
  'no text + a link = the agent fetches it',
)

const briefed = render(UI.PostSurface, {
  pal,
  post: { text: 'We are hiring…', source: 'agent', updatedAt: 2 },
  brief: {
    updatedAt: 3,
    sections: [
      {
        title: 'About the company',
        body: 'Acme runs ledgers, since 2009.',
        source: 'company site',
      },
      { title: 'The job', body: 'You own the platform.', source: 'posting' },
    ],
    meta: [
      { label: 'Location', value: 'Berlin (hybrid)' },
      { label: 'Posted', value: '7 days ago' },
      { label: 'Applicants', value: 'Over 200' },
    ],
  },
  briefLoading: false,
  doc: { company: 'Acme', jobTitle: 'Staff Engineer', jobUrl: '', postUpdatedAt: 2 },
  loading: false,
  sessionId: 's1',
  onSaved: () => {},
  onAskFetch: () => {},
  onAskBrief: () => {},
})
assert.ok(briefed.includes('About the company'), 'the brief leads with the company')
assert.ok(briefed.includes('runs ledgers, since 2009'), 'the section body is readable')
assert.ok(briefed.includes('company site'), 'each section names where its content came from')
assert.ok(briefed.includes('Over 200'), 'the applicant count is up front in the meta strip')
assert.ok(briefed.includes('Full text of the posting'), 'the raw text is still reachable')
assert.ok(!briefed.includes('Break this down'), 'a brief that exists does not beg for one')

const staleBrief = render(UI.PostSurface, {
  pal,
  post: { text: 'We are hiring…', source: 'agent', updatedAt: 2 },
  brief: { updatedAt: 1, sections: [{ title: 'The job', body: 'x' }], meta: [] },
  briefLoading: false,
  doc: { company: '', jobTitle: '', jobUrl: '', postUpdatedAt: 9 },
  loading: false,
  sessionId: 's1',
  onSaved: () => {},
  onAskFetch: () => {},
  onAskBrief: () => {},
})
assert.ok(
  staleBrief.includes('has changed since this breakdown'),
  'a brief of an older post says so',
)

// ---- the posting page: A4-styled, with the CV's gaps painted red ----
const pageHtml =
  '<html><head><style>body{font:13px system-ui}</style></head><body>' +
  '<h1>Acme — Staff Engineer</h1>' +
  '<p>8+ years backend, <mark class="dsh-gap" data-dsh-gap="blocker" title="no evidence">' +
  '2 leading others</mark>, Kubernetes at scale.</p>' +
  '<p>Red marks a requirement your CV does not yet evidence.</p></body></html>'
const pagedPost = render(UI.PostSurface, {
  pal,
  post: {
    text: 'We are hiring…',
    source: 'agent',
    updatedAt: 2,
    html: pageHtml,
    htmlUpdatedAt: 4,
  },
  brief: {
    updatedAt: 3,
    sections: [{ title: 'The job', body: 'You own the platform.', source: 'posting' }],
    meta: [{ label: 'Posted', value: '7 days ago' }],
  },
  briefLoading: false,
  doc: { company: 'Acme', jobTitle: 'Staff Engineer', jobUrl: '', postUpdatedAt: 2 },
  loading: false,
  sessionId: 's1',
  onSaved: () => {},
  onAskFetch: () => {},
  onAskBrief: () => {},
})
assert.equal(
  capturedSrcDoc,
  pageHtml,
  'the posting page is rendered as the iframe document, marks and all',
)
assert.ok(pagedPost.includes('Posted'), 'the meta strip still leads')
assert.ok(!pagedPost.includes('The job'), 'the section cards step aside for the page')
assert.ok(pagedPost.includes('Full text of the posting'), 'the raw text stays reachable')
assert.ok(!pagedPost.includes('Break this down'), 'a page that exists does not beg for one')
assert.ok(
  capturedSrcDoc.includes('<mark class="dsh-gap"'),
  'the red marks ride inside the document the agent wrote',
)

const unBriefed = render(UI.PostSurface, {
  pal,
  post: { text: 'We are hiring…', source: 'agent', updatedAt: 2 },
  brief: null,
  briefLoading: false,
  doc: { company: 'Acme', jobTitle: '', jobUrl: '', postUpdatedAt: 2 },
  loading: false,
  sessionId: 's1',
  onSaved: () => {},
  onAskFetch: () => {},
  onAskBrief: () => {},
})
assert.ok(unBriefed.includes('Break this down for me'), 'a raw post offers the breakdown')
assert.ok(unBriefed.includes('We are hiring…'), 'and still reads')

const emptyPost = render(UI.PostSurface, {
  pal,
  post: null,
  brief: null,
  briefLoading: false,
  doc: { company: '', jobTitle: '', jobUrl: '', postUpdatedAt: 0 },
  loading: false,
  sessionId: 's1',
  onSaved: () => {},
  onAskFetch: () => {},
  onAskBrief: () => {},
})
assert.ok(emptyPost.includes('Paste the post text'), 'an empty post offers the paste box')
assert.ok(!emptyPost.includes('Fetch the post'), 'without a link there is nothing to fetch')

// ---- history, now for either document ----
const versions = [
  { version: 2, updatedAt: Date.now(), note: 'Tightened the opening' },
  { version: 1, updatedAt: Date.now() - 6e5, note: '' },
]
const cvHistory = render(UI.HistoryPanel, {
  pal,
  what: 'CV',
  versions,
  currentVersion: 2,
  busy: false,
  status: null,
  previewingVersion: null,
  onPreview: () => {},
  onRestore: () => {},
  onClose: () => {},
})
assert.ok(cvHistory.includes('CV history'))
assert.ok(cvHistory.includes('Tightened the opening'), 'entries are labelled by their note')

const letterHistory = render(UI.HistoryPanel, {
  pal,
  what: 'cover letter',
  versions,
  currentVersion: 2,
  busy: false,
  status: null,
  previewingVersion: null,
  onPreview: () => {},
  onRestore: () => {},
  onClose: () => {},
})
assert.ok(letterHistory.includes('cover letter history'), 'the letter has its own timeline')

// ---- the whole pane, in the state a live session is in ----
const paneOut = render(UI.CvPane, {
  pal,
  doc: {
    version: 4,
    html: '<html><body><p>CV</p></body></html>',
    jobUrl: 'https://jobs.example/42',
    company: 'Acme',
    jobTitle: 'Staff Engineer',
    updatedAt: 1,
    workspace: '/apps/acme/42',
    letter: { version: 2, html: '<html><body><p>Dear</p></body></html>' },
    proposal: null,
    fit,
    postChars: 900,
    postUpdatedAt: 5,
  },
  online: true,
  flash: false,
  working: false,
  draft: '',
  sessionId: 's1',
  inputActions: {},
  canFullScreen: true,
  fullScreen: false,
  onToggleFullScreen: () => {},
  onClose: () => {},
  onWorkStarted: () => {},
})
assert.ok(paneOut.includes('CV preview'))
assert.ok(paneOut.includes('68% fit'), 'the score is in the toolbar, not behind a click')
assert.ok(paneOut.includes('Post'), 'and the post has a tab of its own')
assert.ok(paneOut.includes('Letter v2'))
assert.ok(paneOut.includes('History'))
assert.ok(paneOut.includes('Export PDF'))
assert.equal(hookDepth, 0)

// ---- the loading lives only on the surface that was asked for ----
// A comment batch dims the marked parts, not the page; a letter request does
// not dim the CV; a post request shows on the post tab only.
const paneCvParts = render(UI.CvPane, {
  pal,
  doc: { version: 4, html: '<p>x</p>', jobUrl: '', updatedAt: 1 },
  online: true,
  flash: false,
  working: { target: 'cv', version: 4, anchors: ['ul > li:nth-of-type(1)', 'p:nth-of-type(2)'] },
  draft: '',
  sessionId: 's1',
  inputActions: {},
  canFullScreen: true,
  fullScreen: false,
  onToggleFullScreen: () => {},
  onClose: () => {},
  onWorkStarted: () => {},
})
assert.ok(paneCvParts.includes('Working on 2 marked parts…'), 'the badge names the parts')
const paneLetter = render(UI.CvPane, {
  pal,
  doc: {
    version: 4,
    html: '<p>cv</p>',
    jobUrl: '',
    updatedAt: 1,
    letter: { version: 2, html: '<p>letter</p>' },
  },
  online: true,
  flash: false,
  working: { target: 'letter', version: 4, letterVersion: 2, anchors: [] },
  draft: '',
  sessionId: 's1',
  inputActions: {},
  canFullScreen: true,
  fullScreen: false,
  onToggleFullScreen: () => {},
  onClose: () => {},
  onWorkStarted: () => {},
})
// On the CV tab a letter request is invisible: nothing here is the letter.
assert.ok(!paneLetter.includes('Working on the cover letter'), 'the CV tab stays clear')
const panePost = render(UI.CvPane, {
  pal,
  doc: {
    version: 4,
    html: '<p>cv</p>',
    jobUrl: 'https://j.example/1',
    postChars: 30,
    postUpdatedAt: 1,
    updatedAt: 1,
  },
  online: true,
  flash: false,
  working: { target: 'post', version: 4, anchors: [] },
  draft: '',
  sessionId: 's1',
  inputActions: {},
  canFullScreen: true,
  fullScreen: false,
  onToggleFullScreen: () => {},
  onClose: () => {},
  onWorkStarted: () => {},
})
assert.ok(panePost.includes('Post'), 'the tab exists')
assert.ok(!panePost.includes('Revising v4'), 'the CV is not dimmed by a post request')
const postWorking = render(UI.PostSurface, {
  pal,
  post: { text: 'We are hiring…', source: 'agent', updatedAt: 2 },
  brief: null,
  briefLoading: false,
  working: { target: 'post', anchors: [] },
  doc: { company: '', jobTitle: '', jobUrl: '', postUpdatedAt: 2 },
  loading: false,
  sessionId: 's1',
  onSaved: () => {},
  onAskFetch: () => {},
  onAskBrief: () => {},
})
assert.ok(postWorking.includes('Working on the posting…'), 'the post tab carries the loading')

// ---- the swipe hint: touch devices only, and only while it is still new ----
assert.ok(!paneOut.includes('swipe to switch'), 'without a coarse pointer the hint stays hidden')
globalThis.window.matchMedia = (q) => ({ matches: q.indexOf('coarse') !== -1 })
const touchPane = render(UI.CvPane, {
  pal,
  doc: {
    version: 4,
    html: '<html><body><p>CV</p></body></html>',
    jobUrl: '',
    updatedAt: 1,
    letter: { version: 2, html: '<html><body><p>Dear</p></body></html>' },
    postChars: 900,
    postUpdatedAt: 5,
  },
  online: true,
  flash: false,
  working: false,
  draft: '',
  sessionId: 's1',
  inputActions: {},
  canFullScreen: false,
  fullScreen: false,
  onToggleFullScreen: () => {},
  onClose: () => {},
  onWorkStarted: () => {},
})
globalThis.window.matchMedia = undefined
assert.ok(
  touchPane.includes('swipe to switch'),
  'a touch device with several views shows the swipe affordance',
)

console.log('ok  preview renders: fit panel, post surface, both timelines')
