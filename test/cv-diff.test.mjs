import { strict as assert } from 'node:assert'
import {
  htmlBlocks,
  diffBlocks,
  summarizeDiff,
  MAX_BLOCKS,
  MAX_CHANGES,
} from '../lib/store/cv-diff.js'

// ---- htmlBlocks: markup churn never reaches the diff, words do ----

// Same words, different styling: one block list.
const styled = `<!doctype html><html><head><meta charset="utf-8">
<title>Jane Doe</title>
<style>body{font-family:Arial}.page{width:210mm}</style></head>
<body><div class="page"><h1>Jane Doe</h1>
<p class="tagline">Senior engineer &mdash; Berlin</p>
<ul><li>Led a team of 10</li><li>Shipped in two weeks</li></ul>
<script>alert('never')</script>
</div></body></html>`
const plain = `<html><body><div class="page"><h1> Jane Doe </h1>
<p>Senior engineer — Berlin</p><ul><li>Led a team of&nbsp;10</li>
<li>Shipped in two weeks</li></ul></div></body></html>`

assert.deepEqual(htmlBlocks(styled), htmlBlocks(plain), 'styling, head and scripts are not content')
assert.deepEqual(htmlBlocks(styled), [
  'Jane Doe',
  'Senior engineer — Berlin',
  'Led a team of 10',
  'Shipped in two weeks',
])

// Entities decode, including the ampersand last (so &amp;lt; stays "&lt;")
assert.deepEqual(htmlBlocks('<p>A &amp; B &lt;x&gt; &#39;q&#39;</p>'), ["A & B <x> 'q'"])

// Comments, whitespace collapse, empties
assert.deepEqual(htmlBlocks('<div><!-- build note -->\n  Spaced\n   out  </div><p></p><br>'), [
  'Spaced out',
])

// Empty and junk inputs degrade to []
assert.deepEqual(htmlBlocks(''), [])
assert.deepEqual(htmlBlocks(null), [])
assert.deepEqual(htmlBlocks('<style>.a{color:red}</style>'), [])

// Caps: no document can blow up the comparison
assert.equal(
  htmlBlocks(Array.from({ length: 600 }, (_, i) => '<li>b' + i).join('')).length,
  MAX_BLOCKS,
)
assert.ok(
  htmlBlocks('<p>' + 'word '.repeat(200) + '</p>')[0].length <= 320,
  'one block is capped by characters',
)

// ---- diffBlocks: the LCS over blocks, runs merged ----

const master = ['Jane Doe', 'Senior engineer', 'Experience', 'Led a team', 'Python']

// Pure addition
assert.deepEqual(diffBlocks(master, [...master, 'Docker']), [
  { op: 'same', text: master.join('\n') },
  { op: 'add', text: 'Docker' },
])
// Pure removal
assert.deepEqual(diffBlocks(master, master.slice(0, 4)), [
  { op: 'same', text: master.slice(0, 4).join('\n') },
  { op: 'del', text: 'Python' },
])
// Replacement reads as del+add at the same spot
const ops = diffBlocks(master, ['Jane Doe', 'Staff engineer', 'Experience', 'Led a team', 'Python'])
assert.equal(JSON.stringify(ops.map((o) => o.op)), JSON.stringify(['same', 'del', 'add', 'same']))
assert.equal(ops[1].text, 'Senior engineer')
assert.equal(ops[2].text, 'Staff engineer')

// Identical documents: one same run, nothing else
assert.deepEqual(diffBlocks(master, master.slice()), [{ op: 'same', text: master.join('\n') }])
// Empty sides degrade honestly
assert.deepEqual(diffBlocks([], ['a']), [{ op: 'add', text: 'a' }])
assert.deepEqual(diffBlocks(['a'], []), [{ op: 'del', text: 'a' }])
assert.deepEqual(diffBlocks([], []), [])

// ---- summarizeDiff: counts plus change-only entries, capped ----

const summary = summarizeDiff(
  diffBlocks(['keep', 'old bullet', 'gone'], ['keep', 'new bullet', 'extra']),
)
assert.equal(summary.added, 2)
assert.equal(summary.removed, 2)
assert.equal(summary.same, 1)
assert.deepEqual(
  summary.changes.map((c) => c.op),
  ['del', 'del', 'add', 'add'],
)
assert.equal(summary.truncated, false)

// The cap bounds the payload, not the counts
const many = Array.from({ length: MAX_CHANGES + 20 }, (_, i) => 'b' + i)
const capped = summarizeDiff(diffBlocks([], many))
assert.equal(capped.added, MAX_CHANGES + 20, 'counts stay honest past the cap')
assert.equal(capped.changes.length, MAX_CHANGES)
assert.equal(capped.truncated, true)
