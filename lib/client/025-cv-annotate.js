// ------------------------- annotate: point at the CV, say what is wrong -------------------------
// The preview iframe deliberately runs no scripts (allow-scripts is off), but
// it IS same-origin, so the PARENT document can attach listeners to its
// contentDocument and paint highlights into it. That is how picking works
// without granting agent-authored HTML any script capability of its own.

var ANNOTATE_STYLE_ID = 'dsh-job-cv-annotate'

// Injected into the iframe only while comment mode is on, and wrapped in
// @media screen so a highlight can never bleed into the printed PDF.
var ANNOTATE_CSS = [
  '@media screen{',
  '[data-jobcv-hot]{outline:2px dashed rgba(46,111,219,.85)!important;outline-offset:2px;',
  'background:rgba(46,111,219,.08)!important;cursor:crosshair}',
  '[data-jobcv-noted]{outline:2px solid #2e6fdb!important;outline-offset:2px;',
  'background:rgba(46,111,219,.16)!important}',
  '}',
].join('')

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
 * The chat message a batch of notes turns into. Written for the agent: the
 * quoted text is the real anchor, the path is the fallback when that text
 * repeats, and the closing ask is what makes it answer with advice rather
 * than only rewriting. The truthfulness clause matters because the user can
 * ask for something the CV cannot honestly support.
 */
function buildRevisionMessage(notes, meta) {
  var version = meta && meta.version ? meta.version : 0
  var lines = []
  lines.push(
    notes.length === 1
      ? 'Revise one part of my CV (currently v' + version + '):'
      : 'Revise ' + notes.length + ' parts of my CV (currently v' + version + '):',
  )
  lines.push('')
  for (var i = 0; i < notes.length; i++) {
    var n = notes[i]
    var where = n.section ? 'section "' + n.section + '"' : 'no section heading'
    lines.push(String(i + 1) + '. In ' + where + ' — ' + n.path)
    lines.push('   Current text: "' + n.text + '"')
    lines.push('   What is needed: ' + (squish(n.comment) || 'improve this'))
    if (n.version && version && n.version !== version) {
      lines.push('   (marked on v' + n.version + ', before your latest save)')
    }
    lines.push('')
  }
  if (meta && meta.jobUrl) lines.push('Job post: ' + meta.jobUrl)
  lines.push(
    'Apply these edits, POST the full replacement document, then tell me what you changed and advise me: for each edit, say whether it actually strengthens the CV against this job post, and push back on anything I asked for that would overstate what my experience supports.',
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
