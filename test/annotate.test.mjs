import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Load the built browser bundle the way the shell's ModuleLoader does, then
// reach the pure annotate helpers through the test surface.
const require = createRequire(import.meta.url)
let spec = null
globalThis.window = { __ModuleLoader__: { load: (s) => (spec = s) } }
globalThis.document = { body: null }
// node ships a getter-only `navigator`; the bundle reads navigator.clipboard
function stubNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
}
stubNavigator({})
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const mod = spec.factory((n) => (n === 'react' ? require('react') : { createPortal: () => null }))
const A = mod.__annotate

// ---- tiny fake DOM: these helpers only touch tagName/className/parent/children ----
function el(tag, opts = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className: opts.className || '',
    textContent: opts.text || '',
    children: [],
    parentElement: null,
    previousElementSibling: null,
  }
  for (const child of opts.children || []) {
    child.parentElement = node
    child.parentNode = node
    if (node.children.length) child.previousElementSibling = node.children[node.children.length - 1]
    node.children.push(child)
    if (!opts.text) node.textContent += child.textContent
  }
  node.parentNode = null
  return node
}

const bullet = el('li', { text: 'Shipped a thing' })
const bullet2 = el('li', { text: 'Shipped another thing' })
const list = el('ul', { children: [bullet, bullet2] })
const role = el('div', { className: 'row bold', text: 'Senior Engineer' })
const item = el('div', { className: 'item', children: [role, list] })
const h2 = el('h2', { text: 'Experience' })
const summary = el('p', { className: 'item', text: 'A summary.' })
const h2a = el('h2', { text: 'Professional Summary' })
const page = el('div', { className: 'page', children: [h2a, summary, h2, item] })
const body = el('body', { children: [page] })

// pickableFrom: climbs inlines, refuses the page wrapper and the body
const strong = el('strong', { text: 'Senior Engineer' })
strong.parentElement = role
strong.parentNode = role
assert.equal(A.pickableFrom(strong, body), role, 'an inline resolves to its block')
assert.equal(A.pickableFrom(bullet, body), bullet)
assert.equal(A.pickableFrom(page, body), null, 'the page wrapper is too coarse to anchor')
assert.equal(A.pickableFrom(body, body), null)

// nodePath: nth-of-type only where it disambiguates; first class only
assert.equal(A.nodePath(bullet, body), 'div.page > div.item > ul > li:nth-of-type(1)')
assert.equal(A.nodePath(bullet2, body), 'div.page > div.item > ul > li:nth-of-type(2)')
assert.equal(A.nodePath(role, body), 'div.page > div.item > div.row')
assert.equal(A.nodePath(item, body), 'div.page > div.item', 'the only div needs no index')
// two sibling divs DO need disambiguating
const jobA = el('div', { className: 'item', text: 'A' })
const jobB = el('div', { className: 'item', text: 'B' })
const twoJobs = el('div', { className: 'page', children: [jobA, jobB] })
const body2 = el('body', { children: [twoJobs] })
assert.equal(A.nodePath(jobB, body2), 'div.page > div.item:nth-of-type(2)')
assert.equal(A.nodePath(jobA, body2), 'div.page > div.item:nth-of-type(1)')

// sectionOf: nearest preceding heading, walking up out of nested blocks
assert.equal(A.sectionOf(bullet, body), 'Experience')
assert.equal(A.sectionOf(summary, body), 'Professional Summary')
assert.equal(A.sectionOf(h2a, body), '', 'the first heading has nothing before it')

// noteFrom bundles what the agent needs, stamped with the version it was marked on
const note = A.noteFrom(bullet, body, 4)
assert.deepEqual(note, {
  text: 'Shipped a thing',
  path: 'div.page > div.item > ul > li:nth-of-type(1)',
  section: 'Experience',
  version: 4,
  comment: '',
})

// visibleText prefers innerText, so a flex row of <strong>+<span> quotes back
// as it reads ("Senior Engineer 2022") instead of running together
const rendered = el('div', { className: 'row', text: 'ignored' })
rendered.innerText = 'Senior Engineer 2022'
rendered.textContent = 'Senior Engineer2022'
assert.equal(A.visibleText(rendered), 'Senior Engineer 2022')
assert.equal(A.noteFrom(rendered, body, 1).text, 'Senior Engineer 2022')
// ...and falls back where innerText is absent or empty
assert.equal(A.visibleText({ textContent: 'plain' }), 'plain')
assert.equal(A.visibleText({ innerText: '', textContent: 'plain' }), 'plain')

// squish/clip normalize whatever the agent's HTML indentation looked like
assert.equal(A.squish('  a\n\t b  '), 'a b')
assert.equal(A.clip('abcdefghij', 5), 'abcd…')
assert.equal(A.clip('abc', 10), 'abc')

// ---- the message the agent receives ----
const msg = A.buildRevisionMessage(
  [
    { ...note, comment: 'Quantify with real numbers' },
    {
      text: 'A summary.',
      path: 'div.page > p.item',
      section: 'Professional Summary',
      version: 3,
      comment: '  Shorten this  ',
    },
  ],
  { version: 4, jobUrl: 'https://jobs.example/42' },
)
assert.ok(msg.includes('Revise 2 parts of my CV (currently v4)'))
assert.ok(msg.includes('1. In section "Experience" — div.page > div.item > ul > li:nth-of-type(1)'))
assert.ok(msg.includes('Current text: "Shipped a thing"'))
assert.ok(msg.includes('What is needed: Quantify with real numbers'))
assert.ok(
  msg.includes('What is needed: Shorten this'),
  'the typed comment is whitespace-normalized',
)
assert.ok(msg.includes('(marked on v3, before your latest save)'), 'a stale anchor is declared')
assert.ok(!msg.includes('(marked on v4'), 'a current note carries no staleness note')
assert.ok(msg.includes('Job post: https://jobs.example/42'))
assert.ok(msg.includes('POST the full replacement document'), 'the agent is told to save')
assert.ok(msg.includes('advise me'), 'the agent is told to answer with advice, not just edits')
assert.ok(msg.includes('overstate'), 'and to push back rather than invent experience')

// ---- the loading treatment for a comment batch lives on the marked parts ----
// One injected rule per anchor path: the marked elements dim and pulse, and
// nothing else in the document moves. The path is machine-generated from the
// user's own document, but it still passes a whitelist before it becomes CSS.
assert.equal(
  A.sanitizeAnchorPath('div.page > div.item > ul > li:nth-of-type(1)'),
  'div.page > div.item > ul > li:nth-of-type(1)',
)
assert.equal(A.sanitizeAnchorPath('li}body{display:none'), 'libodydisplay:none', 'no rule escape')
const workingCss = A.buildWorkingCss(['div.page > p:nth-of-type(1)', 'ul > li:nth-of-type(2)', ''])
assert.ok(workingCss.includes('@media screen'), 'never bleeds into a printed PDF')
assert.ok(workingCss.includes('div.page > p:nth-of-type(1)'))
assert.ok(workingCss.includes('ul > li:nth-of-type(2)'), 'every part gets its own selector')
assert.ok(workingCss.includes('blur(1.1px)'), 'the marked part blurs, not the page')
assert.ok(workingCss.includes('dsh-job-cv-working-pulse'), 'and pulses while the agent works')
assert.equal(A.buildWorkingCss([]), '', 'no parts, no rule')
// The queued phase: parts added to the batch blur the moment they are added,
// before the batch is sent — [data-jobcv-noted] is the selector.
const queuedCss = A.buildQueuedCss()
assert.ok(queuedCss.includes('[data-jobcv-noted]'), 'queued parts are the selector')
assert.ok(queuedCss.includes('blur(1.1px)'), 'and they get the same blur treatment')
assert.ok(queuedCss.includes('@media screen'), 'still never in print')
assert.equal(A.buildWorkingCss(['}']), '', 'nothing usable survives sanitizing')

// ---- a dragged range: several parts, one note, quoted one per line ----
const rangeEls = [
  el('li', { text: 'Built a thing' }),
  el('li', { text: 'Shipped a thing' }),
  el('li', { text: 'Scaled a thing' }),
]
const rangePage = el('div', { className: 'page', children: [el('ul', { children: rangeEls })] })
const range = A.rangeNoteFrom(rangeEls, rangePage, 4)
assert.equal(range.parts.length, 3, 'every touched element joins the note')
assert.equal(range.parts[0].text, 'Built a thing')
assert.ok(range.path.includes('…'), 'the path spans first to last')
assert.equal(range.paths.length, 3, 'each part keeps its own path')
assert.ok(range.text.includes('Scaled a thing'), 'the joined quote mentions the whole range')

const rangeMsg = A.buildRevisionMessage([{ ...range, comment: 'Cut this whole section' }], {
  version: 4,
})
assert.ok(rangeMsg.includes('3 parts, one marked range'), 'the message says it is one range')
assert.ok(rangeMsg.includes('- "Built a thing"'), 'each part is quoted on its own line')
assert.ok(rangeMsg.includes('- "Scaled a thing"'))

assert.deepEqual(
  A.anchorPathsFor([note, { ...range, path: 'x' }]),
  ['div.page > div.item > ul > li:nth-of-type(1)', ...range.paths],
  'the loading treatment covers every element of every range',
)

// ---- the three visual states of a mark, each one unmistakable ----
const css = A.ANNOTATE_CSS
assert.ok(css.includes('[data-jobcv-hot]'), 'the hover/drag state exists')
assert.ok(
  css.includes('outline:2px solid'),
  'the drag reads as solid clubbing, not a faint dashed hint',
)
assert.ok(css.includes('[data-jobcv-picked]'), 'the picked state exists')
assert.ok(
  css.includes('box-shadow'),
  'the picked box is emphatic enough to persist against the document',
)
assert.ok(css.includes('[data-jobcv-noted]'), 'the queued state exists')

// ---- the page deck: sheets of paper, with the break visible ----
const deckLight = A.pageDeckCss(true, { dark: false })
assert.ok(deckLight.includes('.page{'), 'each .page division becomes a sheet')
assert.ok(deckLight.includes('22px'), 'the gap between sheets is the page break')
assert.ok(deckLight.includes('box-shadow'), 'and the shadow makes them read as stacked paper')
assert.ok(
  deckLight.includes('box-sizing:border-box'),
  'the sheet is 210mm of PAPER, padding included',
)
assert.ok(deckLight.includes('@media print'), 'the print normalizer travels with the deck')
assert.ok(
  deckLight.includes('repeating-linear-gradient'),
  'the A4 boundary is drawn on the sheet itself — an overflow crosses it where the PDF would break',
)
assert.ok(
  deckLight.includes('text-size-adjust:100%'),
  'mobile font boosting is pinned off — it would re-wrap the CV and break the A4 agreement',
)
const deckDark = A.pageDeckCss(true, { dark: true })
assert.ok(deckDark.includes('#26282b'), 'the desk follows the theme')
const deckFlat = A.pageDeckCss(false, { dark: false })
assert.ok(
  deckFlat.includes('repeating-linear-gradient'),
  'no .page divisions, a boundary line instead',
)
assert.ok(deckFlat.includes('297mm'), 'the fallback line lands on the A4 boundary')
assert.ok(deckFlat.includes('text-size-adjust:100%'), 'the fallback deck pins the font size too')

const one = A.buildRevisionMessage([{ ...note, comment: '' }], { version: 1 })
assert.ok(one.includes('Revise one part of my CV (currently v1)'))
assert.ok(one.includes('What is needed: improve this'), 'an empty comment still says something')
assert.ok(!one.includes('Job post:'), 'no job link, no job line')

// ---- which document the marks came off ----
// The cover letter is a second document with its own version line and its own
// route. A request that does not say so reads as a request about the CV, and
// the agent rewrites the wrong document and saves it over the right one.
const letter = A.buildRevisionMessage(
  [
    { ...note, comment: 'Too formal' },
    { ...note, version: 1, comment: 'Cut this' },
  ],
  { target: 'letter', version: 2, jobUrl: 'https://jobs.example/42' },
)
assert.ok(letter.includes('Revise 2 parts of my cover letter (currently letter v2)'))
assert.ok(!letter.includes('my CV ('), 'the CV is never what a letter request asks to revise')
assert.ok(
  letter.includes('(marked on letter v1, before your latest save)'),
  'a stale anchor is stale against the LETTER version line, not the CV one',
)
assert.ok(letter.includes('POST /jobcv/letter'), 'and it is saved through the letter route')
assert.ok(letter.includes('not /jobcv/doc'), 'named against precisely to keep the CV out of it')
assert.ok(letter.includes('more persuasive'), 'the advice asked for is about the letter')

const oneLetter = A.buildRevisionMessage([{ ...note, comment: 'Shorten' }], {
  target: 'letter',
  version: 3,
})
assert.ok(oneLetter.includes('Revise one part of my cover letter (currently letter v3)'))

// The CV is the default: no target, no letter wording.
assert.ok(!msg.includes('/jobcv/letter'), 'a CV request never mentions the letter route')
assert.ok(!msg.includes('cover letter'))

// ---- composer delivery ----
// The documented face (dsh-client-ui-conversation): setDraft writes the FULL
// next draft, submit sends it. An empty composer therefore auto-sends.
let wrote = null
let submitted = 0
const composer = {
  setDraft: (t) => (wrote = t),
  submit: () => (submitted += 1),
}
assert.equal(A.deliverToComposer(composer, 'hello', ''), 'sent')
assert.equal(wrote, 'hello')
assert.equal(submitted, 1)

// A draft the user is still typing must not be replaced or sent half-written:
// the message is appended below it and left for them.
wrote = null
submitted = 0
assert.equal(A.deliverToComposer(composer, 'my note', 'half a thought'), 'queued')
assert.equal(wrote, 'half a thought\n\nmy note', 'their words are kept, ours follow')
assert.equal(submitted, 0, 'nothing is sent on the user behalf')

// whitespace-only counts as empty
wrote = null
submitted = 0
assert.equal(A.deliverToComposer(composer, 'x', '   \n '), 'sent')
assert.equal(wrote, 'x')

// a write face with no submit still delivers, it just cannot send
assert.equal(A.deliverToComposer({ setDraft: () => {} }, 'x', ''), 'queued')
// a throwing action falls back rather than losing the text
let clipped = null
stubNavigator({ clipboard: { writeText: (t) => (clipped = t) } })
assert.equal(
  A.deliverToComposer(
    {
      setDraft: () => {
        throw new Error('nope')
      },
    },
    'rescue me',
    '',
  ),
  'clipboard',
)
assert.equal(clipped, 'rescue me')
assert.equal(A.deliverToComposer(null, 'hi', ''), 'clipboard')
stubNavigator({})
assert.equal(A.deliverToComposer({ unrelated: () => {} }, 'hi', ''), null)

// the outcome the user is told about — a successful send needs no words,
// the chat itself is the feedback
assert.equal(A.deliveryNotice('sent'), null)
assert.ok(A.deliveryNotice('queued').includes('press enter'))
assert.ok(A.deliveryNotice('clipboard').includes('clipboard'))
assert.ok(A.deliveryNotice(null).includes('nothing was sent'))

assert.ok(A.COMMENT_PRESETS.length >= 4)

console.log('ok  annotate helpers')
