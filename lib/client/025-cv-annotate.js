// ------------------------- annotate: point at the CV, say what is wrong -------------------------
// The preview iframe deliberately runs no scripts (allow-scripts is off), but
// it IS same-origin, so the PARENT document can attach listeners to its
// contentDocument and paint highlights into it. That is how picking works
// without granting agent-authored HTML any script capability of its own.

var ANNOTATE_STYLE_ID = 'dsh-job-cv-annotate'

// Injected into the iframe only while comment mode is on, and wrapped in
// @media screen so a highlight can never bleed into the printed PDF.
//
// Three visual states, each one unmistakable:
//   hot    — under the cursor, or mid-drag: solid outline + tint, so a drag
//            reads as the elements clubbing together into one selection
//   picked — the part(s) currently being commented on: the box PERSISTS in
//            the preview while the panel is open, so the user can see what
//            the comment is about
//   noted  — added to the batch: queued, waiting on the send
var ANNOTATE_CSS = [
  '@media screen{',
  '[data-jobcv-hot]{outline:2px solid rgba(46,111,219,.9)!important;outline-offset:2px;',
  'background:rgba(46,111,219,.10)!important;cursor:crosshair}',
  '[data-jobcv-picked]{outline:2px solid #2e6fdb!important;outline-offset:2px;',
  'background:rgba(46,111,219,.16)!important;',
  'box-shadow:0 0 0 3px rgba(46,111,219,.18)}',
  '[data-jobcv-noted]{outline:2px solid #2e6fdb!important;outline-offset:2px;',
  'background:rgba(46,111,219,.16)!important}',
  '}',
].join('')

// ------------------------- working-state anchors -------------------------
// While the agent works on a comment batch, the loading treatment sits on the
// SPECIFIC parts that were marked, not on the whole document. The note paths
// nodePath() produced are CSS selectors against the same document, so one
// injected rule per part is all it takes.
//
// The path is machine-generated from the user's own document, but a <style>
// in the iframe still gets the lightest possible whitelist: a bad selector is
// dropped by the CSS engine, while an injected one could restyle things it
// was never meant to. No script risk either way — the frame runs no scripts.
function sanitizeAnchorPath(path) {
  var raw = String(path === undefined || path === null ? '' : path).slice(0, 200)
  var out = ''
  // A per-character whitelist rather than a negated class: selector
  // characters include brackets, which make a negated class ambiguous enough
  // to have kept `}` and `{` — and those are exactly what would let a rule
  // escape into the rest of the stylesheet.
  for (var i = 0; i < raw.length; i++) {
    var c = raw.charCodeAt(i)
    var ok =
      (c >= 97 && c <= 122) || // a-z
      (c >= 65 && c <= 90) || // A-Z
      (c >= 48 && c <= 57) || // 0-9
      c === 32 || // space
      c === 45 || // -
      c === 95 || // _
      c === 46 || // .
      c === 58 || // :
      c === 62 || // >
      c === 35 || // #
      c === 91 || // [
      c === 93 || // ]
      c === 40 || // (
      c === 41 || // )
      c === 61 || // =
      c === 34 || // "
      c === 39 // '
    if (ok) out += raw[i]
  }
  return out.trim()
}

/**
 * The loading rule for a set of marked parts: each one dims, blurs slightly,
 * and pulses its outline until the next save lands. Wrapped in @media screen
 * so it can never bleed into a printed PDF.
 */
function buildWorkingCss(anchors) {
  var selectors = []
  for (var i = 0; i < (Array.isArray(anchors) ? anchors : []).length; i++) {
    var sel = sanitizeAnchorPath(anchors[i])
    if (sel !== '') selectors.push(sel)
  }
  if (selectors.length === 0) return ''
  return (
    '@media screen{' +
    '@keyframes dsh-job-cv-working-pulse{0%,100%{outline-color:#2e6fdb}' +
    '50%{outline-color:rgba(46,111,219,.12)}}' +
    selectors.join(',') +
    '{outline:2px dashed #2e6fdb!important;outline-offset:2px;' +
    'background:rgba(46,111,219,.07)!important;opacity:.55;' +
    'filter:blur(1.1px);animation:dsh-job-cv-working-pulse 1.2s ease-in-out infinite}' +
    '}'
  )
}

/** The queued-phase treatment: the parts added to the batch, before send. */
function buildQueuedCss() {
  return (
    '@media screen{' +
    '@keyframes dsh-job-cv-working-pulse{0%,100%{outline-color:#2e6fdb}' +
    '50%{outline-color:rgba(46,111,219,.12)}}' +
    '[data-jobcv-noted]{outline:2px dashed #2e6fdb!important;outline-offset:2px;' +
    'background:rgba(46,111,219,.07)!important;opacity:.55;' +
    'filter:blur(1.1px);animation:dsh-job-cv-working-pulse 1.2s ease-in-out infinite}' +
    '}'
  )
}

// Blocks worth quoting back to the agent. Clicking a <strong> inside a row
// should mark the row, not the bare inline run.
var PICKABLE = {
  P: 1,
  LI: 1,
  H1: 1,
  H2: 1,
  H3: 1,
  H4: 1,
  H5: 1,
  H6: 1,
  DIV: 1,
  UL: 1,
  OL: 1,
  TD: 1,
  TH: 1,
  TR: 1,
  SECTION: 1,
  HEADER: 1,
  FOOTER: 1,
  BLOCKQUOTE: 1,
  PRE: 1,
  TABLE: 1,
}

function squish(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(text, max) {
  var s = squish(text)
  return s.length > max ? s.slice(0, max - 1).replace(/\s+$/, '') + '…' : s
}

/** The block-level element a click should mark, or null when there is none. */
function pickableFrom(node, root) {
  var el = node
  while (el && el.nodeType !== 1) el = el.parentNode
  while (el && el !== root) {
    if (PICKABLE[el.tagName] === 1) {
      // A direct child of <body> is the page wrapper — the whole CV, too
      // coarse to be a useful anchor for a correction.
      if (el.parentElement === root) return null
      return el
    }
    el = el.parentElement
  }
  return null
}

/** A CSS-ish path, so the agent can locate the node when the text repeats. */
function nodePath(el, root) {
  var parts = []
  var node = el
  while (node && node !== root && node.tagName) {
    var part = node.tagName.toLowerCase()
    var cls = typeof node.className === 'string' ? squish(node.className).split(' ')[0] : ''
    if (cls) part += '.' + cls
    var parent = node.parentElement
    if (parent && parent.children) {
      var twins = []
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) twins.push(parent.children[i])
      }
      if (twins.length > 1) {
        for (var j = 0; j < twins.length; j++) {
          if (twins[j] === node) part += ':nth-of-type(' + (j + 1) + ')'
        }
      }
    }
    parts.unshift(part)
    node = node.parentElement
  }
  return parts.join(' > ')
}

/** The section heading a node sits under, for human-readable context. */
function sectionOf(el, root) {
  var node = el
  while (node && node !== root) {
    var sib = node.previousElementSibling
    while (sib) {
      if (sib.tagName && /^H[1-6]$/.test(sib.tagName)) return clip(visibleText(sib), 60)
      sib = sib.previousElementSibling
    }
    node = node.parentElement
  }
  return ''
}

/**
 * The text as it READS, not as it concatenates. innerText honours element
 * boundaries, so a row of <strong>Senior Engineer</strong><span>2022</span>
 * quotes back as "Senior Engineer 2022" rather than "Senior Engineer2022".
 * Falls back to textContent where innerText is unavailable.
 */
function visibleText(el) {
  var rendered = typeof el.innerText === 'string' ? el.innerText : ''
  return rendered !== '' ? rendered : el.textContent
}

/** Everything the agent needs to find and judge one marked spot. */
function noteFrom(el, root, version) {
  return {
    text: clip(visibleText(el), 240),
    path: nodePath(el, root),
    section: sectionOf(el, root),
    version: version,
    comment: '',
  }
}

/**
 * One note over a RANGE: every element the drag touched, in document order.
 *
 * The agent locates by quoted text first and by path when that text repeats,
 * and a range of five bullets is five things to find — so each part carries
 * its own quote and its own path, and the note quotes them one per line
 * instead of concatenating them into an unreadable paragraph.
 */
function rangeNoteFrom(els, root, version) {
  var parts = []
  for (var i = 0; i < (Array.isArray(els) ? els : []).length; i++) {
    parts.push({
      text: clip(visibleText(els[i]), 240),
      path: nodePath(els[i], root),
    })
  }
  var joined = []
  for (var j = 0; j < parts.length; j++) joined.push(parts[j].text)
  return {
    text: clip(joined.join(' · '), 160),
    parts: parts,
    paths: parts.map(function (p) {
      return p.path
    }),
    path: parts[0].path + ' … ' + parts[parts.length - 1].path,
    section: sectionOf(els[0], root),
    version: version,
    comment: '',
  }
}

/** The loading treatment covers exactly the marked elements of a batch. */
function anchorPathsFor(notes) {
  var paths = []
  for (var i = 0; i < (Array.isArray(notes) ? notes : []).length; i++) {
    var note = notes[i]
    if (note && Array.isArray(note.paths) && note.paths.length > 0) {
      for (var j = 0; j < note.paths.length; j++) paths.push(note.paths[j])
    } else if (note && note.path) {
      paths.push(note.path)
    }
  }
  return paths
}

/**
 * The chat message a batch of notes turns into. Written for the agent: the
 * quoted text is the real anchor, the path is the fallback when that text
 * repeats, and the closing ask is what makes it answer with advice rather
 * than only rewriting. The truthfulness clause matters because the user can
 * ask for something the CV cannot honestly support.
 *
 * WHICH DOCUMENT is named first, in every version number, and again in the
 * closing ask. The cover letter is a separate document with its own version
 * line and its own route, and a marked-up request that does not say so reads
 * as being about the CV: the agent rewrites the wrong document and saves it
 * over the right one through /jobcv/doc.
 */
function buildRevisionMessage(notes, meta) {
  var letter = !!(meta && meta.target === 'letter')
  var version = meta && meta.version ? meta.version : 0
  var what = letter ? 'my cover letter' : 'my CV'
  function versionLabel(n) {
    return letter ? 'letter v' + n : 'v' + n
  }
  var lines = []
  lines.push(
    (notes.length === 1 ? 'Revise one part of ' : 'Revise ' + notes.length + ' parts of ') +
      what +
      ' (currently ' +
      versionLabel(version) +
      '):',
  )
  lines.push('')
  for (var i = 0; i < notes.length; i++) {
    var n = notes[i]
    var where = n.section ? 'section "' + n.section + '"' : 'no section heading'
    lines.push(String(i + 1) + '. In ' + where + ' — ' + n.path)
    if (n.parts && n.parts.length > 1) {
      lines.push('   Current text (' + n.parts.length + ' parts, one marked range):')
      for (var pi = 0; pi < n.parts.length; pi++) {
        lines.push('   - "' + n.parts[pi].text + '"')
      }
    } else {
      lines.push('   Current text: "' + n.text + '"')
    }
    lines.push('   What is needed: ' + (squish(n.comment) || 'improve this'))
    if (n.version && version && n.version !== version) {
      lines.push('   (marked on ' + versionLabel(n.version) + ', before your latest save)')
    }
    lines.push('')
  }
  if (meta && meta.jobUrl) lines.push('Job post: ' + meta.jobUrl)
  lines.push(
    letter
      ? 'Apply these edits to the COVER LETTER and save it with POST /jobcv/letter — not /jobcv/doc, which would overwrite my CV. Then tell me what you changed and advise me: for each edit, say whether it actually makes the letter more persuasive for this job post, and push back on anything I asked for that would claim more than my CV supports.'
      : 'Apply these edits, POST the full replacement document, then tell me what you changed and advise me: for each edit, say whether it actually strengthens the CV against this job post, and push back on anything I asked for that would overstate what my experience supports.',
  )
  return lines.join('\n')
}

// The composer face is documented by @deepseek-ai/dsh-client-ui-conversation:
//
//   InputActions.setDraft(text)  single public draft write path (FULL next
//                                draft — it replaces, it does not append)
//   InputActions.submit()        enter submission
//
// So a panel can both write and send. The probe list stays as a narrow
// fallback for a shell that exposes a different face, but the contract is
// what is used.
var COMPOSER_WRITE = ['setDraft', 'setText', 'setValue', 'setInput', 'appendText', 'insertText']
var COMPOSER_SUBMIT = ['submit', 'send', 'sendMessage']

function composerFn(inputActions, names) {
  if (!inputActions) return null
  for (var i = 0; i < names.length; i++) {
    if (typeof inputActions[names[i]] === 'function')
      return inputActions[names[i]].bind(inputActions)
  }
  return null
}

/**
 * Put a composed message in front of the agent.
 *
 * Auto-sends when the composer is empty — that is the whole point: a comment
 * on the CV is a finished thought, and making the user click send again adds
 * nothing. When the user has their OWN half-typed draft, setDraft would
 * destroy it and submit would send it half-written, so the message is
 * appended below their text and left for them to review instead. Their words
 * are never sent, and never lost, without them.
 *
 * Returns what happened: 'sent' | 'queued' | 'clipboard' | null.
 */
function deliverToComposer(inputActions, text, currentDraft) {
  var write = composerFn(inputActions, COMPOSER_WRITE)
  var submit = composerFn(inputActions, COMPOSER_SUBMIT)
  var existing = typeof currentDraft === 'string' ? currentDraft : ''
  if (write !== null) {
    try {
      if (squish(existing) !== '') {
        write(existing.replace(/\s+$/, '') + '\n\n' + text)
        return 'queued'
      }
      write(text)
      if (submit !== null) {
        submit()
        return 'sent'
      }
      return 'queued'
    } catch (e) {
      /* fall through to the clipboard */
    }
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
      return 'clipboard'
    }
  } catch (e) {
    /* nothing left to try */
  }
  return null
}

/** What to tell the user about a delivery outcome. */
function deliveryNotice(outcome) {
  if (outcome === 'sent') return null // the chat itself is the feedback
  if (outcome === 'queued') return 'added below your unsent draft — review it and press enter'
  if (outcome === 'clipboard') return 'copied to the clipboard — paste it into the chat'
  return 'could not reach the composer — nothing was sent'
}

/** Ready-made intents, so the common corrections are one click. */
var COMMENT_PRESETS = [
  'Shorten this',
  'Quantify with real numbers',
  'Reword for this job post',
  'Stronger action verb',
  'This is outdated / wrong',
  'Remove this',
]

/** Ask the agent for the letter that argues what the CV only evidences. */
function buildLetterRequest(doc) {
  return [
    doc.letter
      ? 'Rewrite my cover letter for this job.'
      : 'Write a cover letter to go with this CV.',
    '',
    doc.jobUrl ? 'Job post: ' + doc.jobUrl : '',
    doc.company ? 'Company: ' + doc.company : '',
    doc.jobTitle ? 'Role: ' + doc.jobTitle : '',
    '',
    'One A4 page, same self-contained HTML rules as the CV, and save it with',
    'POST /jobcv/letter (NOT /jobcv/doc — the letter has its own version).',
    '',
    'It should argue what the CV can only list: why this role, why this',
    'employer, and the through-line the bullet points do not spell out. Do not',
    'restate the CV in prose, and claim nothing the CV does not already',
    'support. If you do not know enough about my motivation to write it',
    'honestly, ask me first rather than inventing enthusiasm.',
  ]
    .filter(function (line, i, all) {
      return line !== '' || (i > 0 && all[i - 1] !== '')
    })
    .join('\n')
}
