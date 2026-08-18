import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// The split preview, asserted from node. Which side the chat lands on is DOM
// surgery against someone else's shell, but how the column is divided is
// arithmetic — and both failures look the same from here: a preview you
// cannot read because the conversation is standing on it.
const require = createRequire(import.meta.url)
let spec = null
globalThis.window = { __ModuleLoader__: { load: (s) => (spec = s) } }
globalThis.document = { body: null }
new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const mod = spec.factory((n) => (n === 'react' ? require('react') : { createPortal: () => null }))
const L = mod.__layout

// ---- the chat is squeezed to the RIGHT, so nothing sits over the preview ----
// padding-right narrows the conversation where it stands: the freed width
// opens up beside it, and the pane — which is placed on the column's left —
// lands on top of the chat instead of next to it.
const src = readFileSync(new URL('../lib/client/040-job-layout.js', import.meta.url), 'utf8')
assert.ok(
  /col\.style\.paddingLeft/.test(src),
  'the chat sidebar is moved across with padding-LEFT on the center column',
)
assert.ok(
  !/col\.style\.paddingRight/.test(src),
  'padding-right only narrows the conversation in place — it leaves it over the preview',
)

// ---- the two halves ----
// A roomy column pays the surplus to the CV, not to the chat.
assert.equal(L.chatWidthFor(1160), L.CHAT_MAX)
assert.equal(L.chatWidthFor(2400), L.CHAT_MAX)
// A tight one takes it back off the chat, down to the narrowest split there is.
assert.equal(L.chatWidthFor(900), 900 - L.PREVIEW_MIN)
assert.equal(L.chatWidthFor(L.SPLIT_MIN), L.CHAT_MIN)

for (let colW = L.SPLIT_MIN; colW <= 2600; colW += 7) {
  const chat = L.chatWidthFor(colW)
  const preview = colW - chat
  assert.ok(chat >= L.CHAT_MIN, 'chat sidebar narrower than CHAT_MIN at ' + colW)
  assert.ok(chat <= L.CHAT_MAX, 'chat sidebar wider than CHAT_MAX at ' + colW)
  assert.ok(preview >= L.PREVIEW_MIN, 'preview narrower than PREVIEW_MIN at ' + colW)
}

// The preview only ever grows as the column does — no width goes missing.
let last = -1
for (let colW = L.SPLIT_MIN; colW <= 2600; colW += 1) {
  const preview = colW - L.chatWidthFor(colW)
  assert.ok(preview >= last, 'the preview shrank as the column grew, at ' + colW)
  last = preview
}

// ---- too small to split: the preview takes the window instead ----
assert.equal(L.splitFits(L.SPLIT_MIN), true)
assert.equal(L.splitFits(L.SPLIT_MIN - 1), false)
assert.equal(L.splitFits(640), false) // the shell's own floor for the column
assert.equal(L.splitFits(0), false)
assert.ok(L.SPLIT_MIN === L.CHAT_MIN + L.PREVIEW_MIN)

// ---- the divider: a drag is a decision, clamped so neither side folds ----
assert.equal(L.clampChatW(999, 1200), 1200 - L.MIN_PREVIEW_PX, 'the preview keeps its floor')
assert.equal(L.clampChatW(0, 1200), L.CHAT_MIN, 'the chat never folds below CHAT_MIN')
assert.equal(L.clampChatW(500, 1200), 500, 'a share inside the bounds stands as dragged')
assert.equal(
  L.clampChatW(700, 860),
  860 - L.MIN_PREVIEW_PX,
  'a tight column still leaves the preview readable',
)
assert.ok(L.SHEET_W > 790 && L.SHEET_W < 800, 'the sheet is 210mm plus its borders')

console.log('  ok  layout: chat sidebar right, preview keeps ' + L.PREVIEW_MIN + 'px or the window')
