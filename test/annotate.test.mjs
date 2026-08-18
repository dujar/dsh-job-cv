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

const one = A.buildRevisionMessage([{ ...note, comment: '' }], { version: 1 })
assert.ok(one.includes('Revise one part of my CV (currently v1)'))
assert.ok(one.includes('What is needed: improve this'), 'an empty comment still says something')
assert.ok(!one.includes('Job post:'), 'no job link, no job line')

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
