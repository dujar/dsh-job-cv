import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// The exported PDF's filename. The browser takes it from the printed
// document's title, so what these helpers build IS what a recruiter reads on
// the attachment — worth asserting rather than eyeballing in a print dialog.
const require = createRequire(import.meta.url)
let spec = null
globalThis.window = { __ModuleLoader__: { load: (s) => (spec = s) } }
globalThis.document = { body: null }
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

console.log('  ok  export filename')
