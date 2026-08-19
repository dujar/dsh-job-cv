import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// The exported PDF's filename. The browser takes it from the printed
// document's title, so what these helpers build IS what a recruiter reads on
// the attachment — worth asserting rather than eyeballing in a print dialog.
const require = createRequire(import.meta.url)
let spec = null
const listeners = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (s) => (spec = s) },
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: (type) => listeners.delete(type),
}
globalThis.document = { body: null, title: 'my session — DeepSeek Harness' }
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const mod = spec.factory((n) => (n === 'react' ? require('react') : { createPortal: () => null }))
const X = mod.__export

const CV = '<html><head><title>CV</title></head><body><h1>Jane Doe</h1><p>…</p></body></html>'

// ---- the name the document states about itself ----
assert.equal(X.candidateNameFrom(CV), 'Jane Doe')
// The <h1> wins over the title, and its markup is not part of the name.
assert.equal(X.candidateNameFrom('<h1><span>Jane</span> <b>Doe</b></h1>'), 'Jane Doe')
// No <h1>: the title stands in, unless it is the template's generic one.
assert.equal(X.candidateNameFrom('<title>Jane Doe</title>'), 'Jane Doe')
assert.equal(X.candidateNameFrom('<title>Cover Letter</title>'), '')
assert.equal(X.candidateNameFrom(CV.replace(/<h1>[\s\S]*?<\/h1>/, '')), '')
assert.equal(X.candidateNameFrom(''), '')
assert.equal(X.candidateNameFrom(null), '')
// An entity in the header is decoded, not spelled out.
assert.equal(X.candidateNameFrom('<h1>Jane &amp; Co</h1>'), 'Jane & Co')

// ---- one filename segment ----
assert.equal(X.fileSlug('Senior Frontend Engineer'), 'Senior_Frontend_Engineer')
assert.equal(X.fileSlug('Acme, Inc.'), 'Acme_Inc')
assert.equal(X.fileSlug("Siobhán O'Brien"), 'Siobhan_OBrien')
assert.equal(X.fileSlug('  /../etc/passwd  '), 'etc_passwd')
assert.equal(X.fileSlug(''), '')
assert.equal(X.fileSlug(undefined), '')

// ---- the whole name ----
const full = { name: 'Jane Doe', jobTitle: 'Staff Engineer', company: 'Acme Inc' }
assert.equal(
  X.exportFileName(Object.assign({ kind: 'cv' }, full)),
  'Jane_Doe_CV_Staff_Engineer_Acme_Inc',
)
assert.equal(
  X.exportFileName(Object.assign({ kind: 'letter' }, full)),
  'Jane_Doe_Cover_Letter_Staff_Engineer_Acme_Inc',
)
// Whatever the candidacy does not know yet is left out, never left as a gap.
assert.equal(X.exportFileName({ kind: 'cv', name: 'Jane Doe' }), 'Jane_Doe_CV')
assert.equal(X.exportFileName({ kind: 'cv', name: '', company: 'Acme' }), 'CV_Acme')
assert.equal(X.exportFileName({}), 'CV')
// A filesystem name limit cuts the tail, and never leaves a trailing joiner.
const long = X.exportFileName({
  kind: 'letter',
  name: 'Jane Doe',
  jobTitle: 'Senior Staff Software Engineer, Platform Infrastructure and Reliability',
  company: 'A Very Long Company Name That Keeps Going And Going Limited',
})
assert.ok(long.length <= 150, 'filename stays inside the name limit')
assert.ok(long.startsWith('Jane_Doe_Cover_Letter_'), 'the name and the kind survive the cut')
assert.ok(!long.endsWith('_'), 'no trailing joiner: ' + long)

// ---- the HOST page's title is what Chrome names the download after ----
// (printing the preview iframe suggests the TOP-LEVEL title, which is how an
// export lands as "<session> — DeepSeek Harness.pdf")
const shellTitle = document.title
const undo = X.wearPrintTitle('Jane_Doe_CV_Staff_Engineer_Acme_Inc')
assert.equal(document.title, 'Jane_Doe_CV_Staff_Engineer_Acme_Inc')
assert.ok(listeners.has('afterprint'), 'the dialog closing is what puts the title back')
// The dialog closes — cancelled or saved, afterprint fires either way.
listeners.get('afterprint')()
assert.equal(document.title, shellTitle, 'the shell gets its own title back')
assert.equal(listeners.has('afterprint'), false, 'the one-shot listener is released')
undo() // idempotent: the fallback path calls it too
assert.equal(document.title, shellTitle)

// Nothing to suggest: the shell's title is left alone rather than blanked.
X.wearPrintTitle('')
assert.equal(document.title, shellTitle)

// The timer behind afterprint: a browser that never sends the event must not
// leave the tab renamed.
const timers = []
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms) => {
  timers.push({ fn, ms })
  return timers.length
}
X.wearPrintTitle('Jane_Doe_CV')
assert.equal(document.title, 'Jane_Doe_CV')
assert.equal(timers.length, 1)
assert.ok(timers[0].ms >= 60000, 'the fallback outlasts reading a print preview')
timers[0].fn()
assert.equal(document.title, shellTitle, 'the fallback restores it without afterprint')
globalThis.setTimeout = realSetTimeout

console.log('  ok  export filename')
