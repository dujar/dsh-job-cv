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

// ---- a page with nothing on it is a blank page in the exported PDF ----
// The rule sits OUTSIDE both media blocks on purpose: a sheet the preview
// drops has to be a page the print drops, or the deck's whole reason for
// existing (preview and PDF agreeing) is undone.
for (const [name, deck] of [
  ['with pages', deckLight],
  ['without', deckFlat],
]) {
  assert.ok(
    deck.includes('[data-dsh-job-cv-blank]{display:none!important}'),
    'the blank-page rule ships ' + name,
  )
  assert.ok(
    !deck.includes('.page[data-dsh-job-cv-blank]'),
    'and is NOT qualified to .page — the stray between the sheets is the one ' +
      'the preview cannot show you (' +
      name +
      ')',
  )
  // Not "no @media anywhere after it" — the print-break rule legitimately
  // follows. What matters is that the blank rule sits at brace depth 0, i.e.
  // inside no media block at all.
  const at = deck.indexOf('[data-dsh-job-cv-blank]')
  const before = deck.slice(0, at)
  const depth = before.split('{').length - before.split('}').length
  assert.equal(depth, 0, 'the blank rule is fenced into no medium at all (' + name + ')')

  // The page break is the opposite: it means nothing on screen, and forcing
  // it there would tear the deck apart.
  const brk = deck.indexOf('[data-dsh-job-cv-break]')
  assert.ok(brk > -1, 'the fresh-paper rule ships ' + name)
  const beforeBrk = deck.slice(0, brk)
  assert.equal(
    beforeBrk.split('{').length - beforeBrk.split('}').length,
    1,
    'and lives inside @media print (' + name + ')',
  )
  assert.ok(
    deck.slice(0, brk).lastIndexOf('@media print') >
      deck.slice(0, brk).lastIndexOf('@media screen'),
    'specifically the print block, not the screen one (' + name + ')',
  )
}

// isBlankPage: a page a reader would see nothing on. Errs toward SHOWING —
// a false blank deletes part of the CV, a false keep is only the status quo.
function blankProbe(html) {
  const draws = /<(img|svg|canvas|video|picture|object|embed|iframe|hr|table|input|textarea)\b/i
  const styled = /style="[^"]*background/i
  return {
    textContent: html.replace(/<[^>]+>/g, ''),
    querySelector: (selector) => {
      assert.equal(selector, A.PAGE_DRAWS, 'the content net is the one the deck ships')
      return draws.test(html) || styled.test(html) ? {} : null
    },
  }
}

assert.equal(A.isBlankPage(blankProbe('')), true, 'nothing at all is blank')
assert.equal(A.isBlankPage(blankProbe('\n   \n')), true, 'and so is whitespace')
assert.equal(A.isBlankPage(blankProbe('<br>')), true, 'a lone line break writes nothing')
assert.equal(A.isBlankPage(blankProbe('<p></p><div></div>')), true, 'nor do empty blocks')
assert.equal(A.isBlankPage(blankProbe('<h1>Ada Lovelace</h1>')), false, 'words are content')
assert.equal(A.isBlankPage(blankProbe('<p> . </p>')), false, 'even one character of it')
assert.equal(
  A.isBlankPage(blankProbe('<img src="data:,">')),
  false,
  'an image-only page is not blank',
)
assert.equal(A.isBlankPage(blankProbe('<hr>')), false, 'a rule draws something')
assert.equal(
  A.isBlankPage(blankProbe('<table><tr><td></td></tr></table>')),
  false,
  'so does a table',
)
assert.equal(
  A.isBlankPage(blankProbe('<div style="background:url(data:,);height:40mm"></div>')),
  false,
  'a page carrying only a decorative background is still showing something',
)
assert.equal(A.isBlankPage(null), false, 'no element is not a blank page')
assert.equal(
  A.isBlankPage({
    get textContent() {
      throw new Error('cross-origin')
    },
  }),
  false,
  'unreadable is not blank — leaving the page alone is the safe direction',
)

// markBlankSheets: the sheets AND what sits between them. A stray <br> or an
// empty spacer is invisible against the preview's desk and still takes up a
// whole page in print — which is how the preview can be right and the PDF one
// page too long.
function sheetEl(tag, opts = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className: opts.className || '',
    attrs: {},
    children: [],
    parentNode: null,
    ownText: opts.text || '',
    get textContent() {
      return this.ownText + this.children.map((c) => c.textContent).join('')
    },
    setAttribute(k, v) {
      this.attrs[k] = v
    },
    removeAttribute(k) {
      delete this.attrs[k]
    },
    hasAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k)
    },
    marked() {
      return this.hasAttribute('data-dsh-job-cv-blank')
    },
    getBoundingClientRect() {
      // opts.mm is the sheet's rendered height in millimetres; A4 is 297.
      return { height: ((opts.mm === undefined ? 0 : opts.mm) / 297) * 1122.52 }
    },
    matches(selector) {
      const wants = selector.split(',').map((x) => x.trim())
      if (wants.includes(this.tagName.toLowerCase())) return true
      return wants.includes('[style*="background"]') && /background/.test(this.attrs.style || '')
    },
    querySelector(selector) {
      const wants = selector.split(',').map((x) => x.trim())
      const walk = (n) => {
        for (const c of n.children) {
          if (wants.includes('.page') && c.className.split(/\s+/).includes('page')) return c
          if (wants.includes(c.tagName.toLowerCase())) return c
          if (wants.includes('[style*="background"]') && /background/.test(c.attrs.style || ''))
            return c
          const found = walk(c)
          if (found) return found
        }
        return null
      }
      return walk(this)
    },
  }
  for (const child of opts.children || []) {
    child.parentNode = node
    node.children.push(child)
  }
  return node
}

const sheet = sheetEl('div', { className: 'page', children: [sheetEl('h1', { text: 'Ada' })] })
const blankSheet = sheetEl('div', { className: 'page' })
const strayBr = sheetEl('br')
const spacer = sheetEl('div')
const rule = sheetEl('hr')
const deckBody = sheetEl('body', { children: [sheet, strayBr, blankSheet, spacer, rule] })
A.markBlankSheets({ body: deckBody }, [sheet, blankSheet])
assert.equal(sheet.marked(), false, 'a sheet with words on it prints')
assert.equal(blankSheet.marked(), true, 'a sheet with nothing on it does not')
assert.equal(strayBr.marked(), true, 'a stray line break between sheets is a blank page in print')
assert.equal(spacer.marked(), true, 'and so is an empty spacer div')
assert.equal(rule.marked(), false, 'a rule draws something, so it stays')
const strayImage = sheetEl('img')
A.markBlankSheets({ body: sheetEl('body', { children: [sheet, strayImage] }) }, [sheet])
assert.equal(
  strayImage.marked(),
  false,
  'a stray image IS the thing that draws — it has no descendant to find itself in',
)

// A wrapper that HOLDS sheets is structure, not a stray — marking it would
// hide the whole document.
const inner = sheetEl('div', { className: 'page', children: [sheetEl('p', { text: 'x' })] })
const wrap = sheetEl('div', { children: [inner] })
const trailing = sheetEl('br')
const wrapped = sheetEl('body', { children: [wrap, trailing] })
A.markBlankSheets({ body: wrapped }, [inner])
assert.equal(wrap.marked(), false, 'the wrapper around the sheets is never hidden')
assert.equal(inner.marked(), false)
assert.equal(trailing.marked(), true, 'the stray outside it still is')

// Re-decided, not remembered: filling the page in takes the mark back off.
blankSheet.children.push(sheetEl('p', { text: 'Now it says something' }))
A.markBlankSheets({ body: deckBody }, [sheet, blankSheet])
assert.equal(blankSheet.marked(), false, 'a page that gained content prints again')

// ---- a sheet taller than the paper it prints on ----
// On screen an over-long .page simply grows, so nothing about the preview
// says the PDF is about to come out a sheet longer with a section broken
// across the break. This is the measurement that says it.
function deckDoc(sheets) {
  const probe = {
    setAttribute() {},
    getBoundingClientRect: () => ({ height: 1122.52 }),
    parentNode: null,
  }
  const body = sheetEl('body', { children: sheets })
  body.appendChild = (n) => (n.parentNode = body)
  body.removeChild = (n) => (n.parentNode = null)
  return {
    body,
    createElement: () => probe,
    querySelectorAll: () => sheets.filter((x) => x.className.split(/\s+/).includes('page')),
  }
}
const sheetOf = (mm, text = 'words') =>
  sheetEl('div', { className: 'page', mm, children: [sheetEl('p', { text })] })

assert.deepEqual(
  A.pageOverflows(deckDoc([sheetOf(297), sheetOf(297)])).map((o) => [o.page, o.over]),
  [],
  'two sheets that fit report nothing',
)
assert.deepEqual(
  A.pageOverflows(deckDoc([sheetOf(314.37), sheetOf(297)])).map((o) => [o.page, o.over]),
  [[1, 17]],
  'and one 17mm too long is named, with the millimetres',
)
assert.deepEqual(
  A.pageOverflows(deckDoc([sheetOf(297.4), sheetOf(297)])).map((o) => [o.page, o.over]),
  [],
  'under a millimetre is layout rounding, not a page that will break',
)

// A blank sheet does not print, so it cannot overflow — and it does not take
// a page number either, or the warning would point at the wrong sheet.
const hidden = sheetEl('div', { className: 'page', mm: 297 })
hidden.attrs['data-dsh-job-cv-blank'] = ''
assert.deepEqual(
  A.pageOverflows(deckDoc([sheetOf(297), hidden, sheetOf(320)])).map((o) => [o.page, o.over]),
  [[2, 23]],
  'the third division is the SECOND printed page, and that is what is reported',
)

// ---- fresh paper for every sheet after the first ----
const s1 = sheetOf(314.37)
const s2 = sheetOf(297)
const s3 = sheetOf(297)
const overs = A.markSheets(deckDoc([s1, s2, s3]), [s1, s2, s3])
assert.equal(s1.attrs['data-dsh-job-cv-break'], undefined, 'the first sheet needs no break')
assert.equal(s2.attrs['data-dsh-job-cv-break'], '', 'every sheet after it starts on fresh paper')
assert.equal(s3.attrs['data-dsh-job-cv-break'], '')
assert.equal(s1.attrs['data-dsh-job-cv-over'], '17', 'and the long one wears its overflow')
assert.equal(s2.attrs['data-dsh-job-cv-over'], undefined)
assert.deepEqual(
  overs.map((o) => [o.page, o.over]),
  [[1, 17]],
  'markSheets hands the overflow back — the pane has no other way to know',
)

// A blank first division must not take the "no break" slot from the sheet
// that is actually printed first.
const blank1 = sheetEl('div', { className: 'page', mm: 0 })
const real1 = sheetOf(297)
const real2 = sheetOf(297)
A.markSheets(deckDoc([blank1, real1, real2]), [blank1, real1, real2])
assert.equal(
  real1.attrs['data-dsh-job-cv-break'],
  undefined,
  'the first PRINTED sheet, not the first division',
)
assert.equal(real2.attrs['data-dsh-job-cv-break'], '')

// ---- the message that asks for the fix ----
const fitMsg = A.buildOverflowRequest(
  [
    { page: 1, over: 17 },
    { page: 2, over: 4 },
  ],
  { jobUrl: 'https://jobs.example/1' },
  'CV',
)
assert.ok(fitMsg.includes('page 1 runs 17mm past the bottom of A4'), 'it names the page and the mm')
assert.ok(fitMsg.includes('page 2 runs 4mm past'))
assert.ok(fitMsg.includes('297mm INCLUDING its padding'), 'and what the constraint actually is')
assert.ok(fitMsg.includes('POST /jobcv/doc'), 'a CV overflow saves through the CV route')
assert.ok(
  fitMsg.includes('not by shrinking the type'),
  'the cheap fix is named so it is not the one taken',
)
assert.ok(fitMsg.includes('cutting'), 'and so is cutting the evidence that does the work')
const letterMsg = A.buildOverflowRequest([{ page: 1, over: 9 }], {}, 'cover letter')
assert.ok(letterMsg.includes('POST /jobcv/letter'), 'a letter overflow never renumbers the CV')
assert.ok(letterMsg.includes('My cover letter does not fit'))

// ---- the swipe gesture: detected inside the iframe, forwarded once ----
function swipeDoc() {
  const attrs = {}
  const listeners = {}
  // Which mode's style tag is in the document — that is how attachSwipe (and
  // the link interceptor) tell whether another mode owns the finger.
  const styles = {}
  return {
    body: {
      hasAttribute: (k) => attrs[k] === '',
      setAttribute: (k, v) => (attrs[k] = v),
    },
    getElementById: (id) => styles[id] || null,
    addEventListener: (type, fn) => {
      ;(listeners[type] = listeners[type] || []).push(fn)
    },
    __listeners: listeners,
    __mode: (id) => {
      for (const k of Object.keys(styles)) delete styles[k]
      if (id) styles[id] = { id }
    },
  }
}
const swipes = []
A.setSwipeHandler((dir) => swipes.push(dir))
const swipe = swipeDoc()
A.attachSwipe(swipe)
const start = swipe.__listeners.touchstart[0]
const end = swipe.__listeners.touchend[0]

start({ touches: [{ clientX: 0, clientY: 0 }] })
end({ changedTouches: [{ clientX: 100, clientY: 0 }] })
assert.deepEqual(swipes, [-1], 'a clear swipe right moves to the previous view')
swipes.length = 0
start({ touches: [{ clientX: 200, clientY: 0 }] })
end({ changedTouches: [{ clientX: 100, clientY: 0 }] })
assert.deepEqual(swipes, [1], 'a swipe left moves to the next view')
swipes.length = 0
start({ touches: [{ clientX: 0, clientY: 0 }] })
end({ changedTouches: [{ clientX: 0, clientY: 100 }] })
assert.deepEqual(swipes, [], 'a vertical scroll never reads as a switch')
swipes.length = 0
start({ touches: [{ clientX: 0, clientY: 0 }] })
end({ changedTouches: [{ clientX: 40, clientY: 0 }] })
assert.deepEqual(swipes, [], 'a nudge under the 60px threshold is not a swipe')
swipes.length = 0
start({ touches: [{ clientX: 0, clientY: 0 }] })
end({ changedTouches: [{ clientX: 100, clientY: 80 }] })
assert.deepEqual(swipes, [], 'a mostly-vertical drag stays a scroll')

// A mode that owns the finger stands the swipe down: switching tabs mid-
// comment drops the notes marked on this document, and mid-edit drops words
// that exist nowhere but the frame.
swipes.length = 0
swipe.__mode('dsh-job-cv-annotate')
start({ touches: [{ clientX: 200, clientY: 0 }] })
end({ changedTouches: [{ clientX: 100, clientY: 0 }] })
assert.deepEqual(swipes, [], 'comment mode owns the finger — no tab switch under it')
swipe.__mode('dsh-job-cv-edit')
start({ touches: [{ clientX: 200, clientY: 0 }] })
end({ changedTouches: [{ clientX: 100, clientY: 0 }] })
assert.deepEqual(swipes, [], 'and so does edit mode')
swipe.__mode(null)
start({ touches: [{ clientX: 200, clientY: 0 }] })
end({ changedTouches: [{ clientX: 100, clientY: 0 }] })
assert.deepEqual(swipes, [1], 'with neither mode on, the swipe works again')
swipes.length = 0

// ---- picking a part with a finger ----
// The mouse path is mousedown/mousemove/mouseup, and a phone does not
// reliably make those out of a tap — iOS Safari does not synthesize them for
// a paragraph inside a frame, which is why comment mode did nothing at all
// on mobile.
function touchDoc() {
  const docListeners = {}
  const rootListeners = {}
  const bullet = el('li', { text: 'Cut deploy time by 40%.' })
  const strong = el('strong', { text: 'Senior Engineer' })
  const role = el('div', { className: 'row', children: [strong] })
  const rootBody = el('body', { children: [el('div', { className: 'page', children: [role] })] })
  bullet.parentElement = rootBody
  bullet.parentNode = rootBody
  return {
    idoc: {
      addEventListener: (t, fn) => (docListeners[t] = docListeners[t] || []).push(fn),
      removeEventListener: (t, fn) => {
        docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn)
      },
    },
    root: Object.assign(rootBody, {
      addEventListener: (t, fn) => (rootListeners[t] = rootListeners[t] || []).push(fn),
      removeEventListener: (t, fn) => {
        rootListeners[t] = (rootListeners[t] || []).filter((f) => f !== fn)
      },
    }),
    docListeners,
    rootListeners,
    strong,
    role,
  }
}

const T = touchDoc()
const picked = []
const detach = A.attachTouchPicking(T.idoc, T.root, (el) => picked.push(el))
const tStart = T.rootListeners.touchstart[0]
const tEnd = T.docListeners.touchend[0]
let prevented = 0
const tap = (from, to, target) => {
  tStart({ touches: [{ clientX: from[0], clientY: from[1] }], target })
  tEnd({
    changedTouches: [{ clientX: to[0], clientY: to[1] }],
    cancelable: true,
    preventDefault: () => (prevented += 1),
  })
}

tap([50, 50], [50, 50], T.strong)
assert.deepEqual(picked, [T.role], 'a tap on an inline run picks the block around it')
assert.equal(prevented, 1, 'and cancels the tap, so the mouse path cannot pick it a second time')

picked.length = 0
tap([50, 50], [50, 140], T.strong)
assert.deepEqual(picked, [], 'a drag is a SCROLL on a phone — taking it would trap the reader')
tap([50, 50], [140, 50], T.strong)
assert.deepEqual(picked, [], 'sideways too')
tap([50, 50], [58, 56], T.strong)
assert.deepEqual(
  picked,
  [T.role],
  'but a finger is never perfectly still, so a little slop is a tap',
)

picked.length = 0
tStart({ touches: [{ clientX: 50, clientY: 50 }], target: T.strong })
T.docListeners.touchcancel[0]()
tEnd({ changedTouches: [{ clientX: 50, clientY: 50 }], cancelable: true, preventDefault: () => {} })
assert.deepEqual(picked, [], 'a cancelled touch picks nothing')

detach()
assert.equal(
  T.rootListeners.touchstart.length,
  0,
  'leaving comment mode takes the listeners with it',
)
assert.equal(T.docListeners.touchend.length, 0)

// one listener per document, and no handler means no forwarding
const second = swipeDoc()
A.attachSwipe(second)
A.attachSwipe(second)
assert.equal(second.__listeners.touchstart.length, 1, 'the listener attaches once per document')
A.setSwipeHandler(null)
swipes.length = 0
start({ touches: [{ clientX: 0, clientY: 0 }] })
end({ changedTouches: [{ clientX: 100, clientY: 0 }] })
assert.deepEqual(swipes, [], 'with no handler a swipe is dropped, not thrown')

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
