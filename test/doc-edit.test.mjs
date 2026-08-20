import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// What comes back out of a hand-edited document is what gets SAVED over the
// user's CV, so the rule for which nodes belong to the author and which the
// preview injected is asserted directly — and so is the routing, because a
// letter edit landing on /jobcv/doc would renumber the wrong document.
const require = createRequire(import.meta.url)
let spec = null
globalThis.window = { __ModuleLoader__: { load: (s) => (spec = s) } }
globalThis.document = { body: null }
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const mod = spec.factory((n) => (n === 'react' ? require('react') : { createPortal: () => null }))
const E = mod.__edit

// ---- tiny fake DOM: only what the serializer touches ----
function el(tag, attrs = {}, children = [], text = '') {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs: Object.assign({}, attrs),
    children: [],
    parentNode: null,
    text,
    get id() {
      return this.attrs.id || ''
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name)
    },
    getAttribute(name) {
      return this.hasAttribute(name) ? this.attrs[name] : null
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value)
    },
    removeAttribute(name) {
      delete this.attrs[name]
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child)
      child.parentNode = null
      return child
    },
    querySelectorAll(selector) {
      assert.equal(selector, '*', 'the serializer walks the tree, it does not match selectors')
      const out = []
      const walk = (n) => {
        for (const c of n.children) {
          out.push(c)
          walk(c)
        }
      }
      walk(this)
      return out
    },
    cloneNode(deep) {
      return el(tag, this.attrs, deep ? this.children.map((c) => c.cloneNode(true)) : [], this.text)
    },
    get outerHTML() {
      const attrs = Object.keys(this.attrs)
        .map((k) => ' ' + k + '="' + this.attrs[k] + '"')
        .join('')
      const inner = this.text + this.children.map((c) => c.outerHTML).join('')
      return '<' + tag + attrs + '>' + inner + '</' + tag + '>'
    },
  }
  for (const child of children) {
    child.parentNode = node
    node.children.push(child)
  }
  return node
}

// ---- isInjectedNode: the parent's fingerprints, and nothing else ----
assert.equal(E.isInjectedNode(el('style', { id: 'dsh-job-cv-pages' })), true, 'the page deck')
assert.equal(E.isInjectedNode(el('style', { id: 'dsh-job-cv-annotate' })), true, 'comment marks')
assert.equal(E.isInjectedNode(el('style', { id: 'dsh-job-cv-working' })), true, 'working paint')
assert.equal(E.isInjectedNode(el('style', { id: 'dsh-job-cv-post-gap' })), true, 'the red marks')
assert.equal(E.isInjectedNode(el('style', { id: 'dsh-job-cv-edit' })), true, 'the edit affordance')
assert.equal(
  E.isInjectedNode(el('style', { id: 'cv-theme' })),
  false,
  "the author's own stylesheet is the document",
)
assert.equal(E.isInjectedNode(el('style')), false, 'an unnamed author stylesheet stays')
assert.equal(
  E.isInjectedNode(el('meta', { name: 'viewport', 'data-dsh-job-cv-viewport': '' })),
  true,
  'the viewport the deck declared',
)
assert.equal(
  E.isInjectedNode(el('meta', { name: 'viewport', content: 'width=1024' })),
  false,
  'a viewport the document declared itself is the document',
)
assert.equal(E.isInjectedNode(el('p')), false)

// ---- the whole round trip, off a document dressed the way the preview dresses one ----
function editedDocument() {
  const deck = el('style', { id: 'dsh-job-cv-pages' }, [], '.page{}')
  const editCss = el('style', { id: 'dsh-job-cv-edit' }, [], 'body{}')
  const ourViewport = el('meta', { name: 'viewport', 'data-dsh-job-cv-viewport': '' })
  const authorStyle = el('style', { id: 'cv-theme' }, [], 'h1{color:#111}')
  const head = el('head', {}, [ourViewport, deck, editCss, authorStyle])
  const summary = el('p', { class: 'lede', 'data-jobcv-noted': '' }, [], 'Platform engineer.')
  const bullet = el('li', { 'data-jobcv-picked': '' }, [], 'Cut deploy time by 40%.')
  const page = el('div', { class: 'page' }, [summary, el('ul', {}, [bullet])])
  const body = el(
    'body',
    {
      contenteditable: 'true',
      spellcheck: 'true',
      'data-dsh-job-cv-swipe': '',
      'data-dsh-job-cv-links': '',
    },
    [page],
  )
  const root = el('html', { lang: 'en' }, [head, body])
  return { documentElement: root, doctype: { name: 'html' } }
}

const idoc = editedDocument()
const saved = E.serializeEditedDoc(idoc)

assert.ok(saved.startsWith('<!DOCTYPE html>\n<html'), 'the doctype survives the round trip')
assert.ok(!saved.includes('dsh-job-cv-pages'), 'the page deck never rides into a save')
assert.ok(!saved.includes('dsh-job-cv-edit'), 'nor does the edit affordance')
assert.ok(!saved.includes('data-dsh-job-cv-viewport'), 'nor the viewport the deck declared')
assert.ok(!saved.includes('contenteditable'), 'the document does not save as permanently editable')
assert.ok(!saved.includes('spellcheck'), 'nor carrying the editor spellcheck flag')
assert.ok(!saved.includes('data-jobcv-noted'), 'comment marks are paint, not content')
assert.ok(!saved.includes('data-jobcv-picked'))
assert.ok(!saved.includes('data-dsh-job-cv-swipe'), 'the once-only listener guards come out')
assert.ok(!saved.includes('data-dsh-job-cv-links'))
assert.ok(saved.includes('h1{color:#111}'), "the author's stylesheet is the document, and stays")
assert.ok(saved.includes('id="cv-theme"'))
assert.ok(saved.includes('Cut deploy time by 40%.'), 'the words are what is being saved')
assert.ok(saved.includes('class="lede"'), "the author's own classes survive")
assert.ok(saved.includes('lang="en"'), 'so do attributes on the root element')

// Serializing must not disturb what is on screen: a failed save has to leave
// the user still editing what they wrote.
assert.equal(
  idoc.documentElement.children[1].getAttribute('contenteditable'),
  'true',
  'the live frame is untouched — the strip runs on a clone',
)
assert.equal(idoc.documentElement.children[0].children.length, 4, 'and keeps its injected head')

// A document with no doctype does not gain one.
const bare = { documentElement: el('html', {}, [el('body', {}, [], 'hi')]), doctype: null }
assert.ok(E.serializeEditedDoc(bare).startsWith('<html>'), 'no doctype invented')
assert.equal(E.serializeEditedDoc(null), '', 'an unreachable frame serializes to nothing')
assert.equal(E.serializeEditedDoc({}), '')

// ---- the note the timeline shows ----
assert.equal(E.editNote(''), E.EDIT_DEFAULT_NOTE, 'an unlabelled edit still says what it was')
assert.equal(E.editNote('   '), E.EDIT_DEFAULT_NOTE)
assert.equal(E.editNote(undefined), E.EDIT_DEFAULT_NOTE)
assert.equal(E.editNote('  Fixed the start date  '), 'Fixed the start date')

// ---- routing: each document saves through its own route ----
const calls = []
globalThis.fetch = (path, init) => {
  calls.push({ path, body: JSON.parse(init.body), method: init.method })
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, version: 7 }) })
}

const cvVersion = await E.saveEditedDoc('s1', 'cv', '<html>cv</html>', 'Tightened the summary')
assert.equal(calls[0].path, '/jobcv/doc')
assert.equal(calls[0].method, 'POST')
assert.deepEqual(calls[0].body, {
  sessionId: 's1',
  html: '<html>cv</html>',
  note: 'Tightened the summary',
})
assert.equal(cvVersion, 7, 'the caller learns the version it landed as')

await E.saveEditedDoc('s1', 'letter', '<html>letter</html>', '')
assert.equal(calls[1].path, '/jobcv/letter', 'a letter edit never renumbers the CV')
assert.equal(calls[1].body.note, E.EDIT_DEFAULT_NOTE)

const postVersion = await E.saveEditedDoc('s1', 'post', '<html>post</html>', 'ignored', {
  text: 'We are hiring a platform engineer.',
  source: 'you',
})
assert.equal(calls[2].path, '/jobcv/post')
assert.deepEqual(calls[2].body, {
  sessionId: 's1',
  text: 'We are hiring a platform engineer.',
  source: 'you',
  html: '<html>post</html>',
})
assert.equal(postVersion, null, 'the post has no version line to report')

// The post's text goes back up UNCHANGED: editing the page is not a claim
// about what the posting said, and the stored text is what the brief, the
// fit score and every document are written against.
await E.saveEditedDoc('s1', 'post', '<html>p</html>', '', { text: 'Original.', source: 'agent' })
assert.equal(calls[3].body.text, 'Original.')
assert.equal(calls[3].body.source, 'agent', 'a page edit does not relabel who fetched the text')

// A refused save reports why, rather than resolving as if it had landed.
globalThis.fetch = () =>
  Promise.resolve({
    ok: false,
    status: 400,
    json: () => Promise.resolve({ error: 'html must be a non-empty string' }),
  })
await assert.rejects(
  E.saveEditedDoc('s1', 'cv', '<html></html>', ''),
  /html must be a non-empty string \(400\)/,
)

// ---- the affordance never reaches the printed PDF ----
assert.ok(E.EDIT_CSS.startsWith('@media screen{'), 'edit paint is screen-only')
assert.ok(E.EDIT_CSS.trim().endsWith('}'))
assert.ok(E.EDIT_STRIP_ATTRS.indexOf('contenteditable') !== -1)

console.log('  ok  doc-edit: the strip, the note, and the route each edit saves through')
