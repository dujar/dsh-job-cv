// dsh-job-cv browser half.
//
// Zero-build hand-written client bundle (same proven pattern as dsh-trader):
// CJS factory + ModuleLoader wrapper. React comes from the shell's static
// module table; slot components receive the framework standard kit
// (sessionId, useSession, useSessions, useInput, inputActions) via props.
//
// When the current session's agent preset is "job" this plugin restructures
// the conversation column: the chat narrows into a right-hand sidebar and a
// CV preview pane (a sandboxed iframe rendering the stored HTML document)
// becomes the main layout. The pane hosts the toolbar with the live version,
// the job post link and the Export PDF button (browser print dialog, Save as
// PDF). The session agent updates the document through POST /jobcv/doc and
// the preview follows within a few seconds.
window.__ModuleLoader__.load({
  // Must equal package.json "name" exactly.
  id: 'dsh-job-cv',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var ReactDOM = require('react-dom')
    var createElement = React.createElement

    // ------------------------- theme -------------------------
    function isDark() {
      return typeof document !== 'undefined' && document.body && document.body.hasAttribute('data-ds-dark-theme')
    }
    function palette() {
      var dark = isDark()
      return {
        dark: dark,
        text: dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
        textStrong: dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.8)',
        panelBg: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        panelBorder: dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.09)',
        baseBg: dark ? '#1b1d21' : '#f5f5f4',
        controlBg: 'rgba(128,128,128,0.08)',
        controlBorder: 'rgba(128,128,128,0.25)',
        controlActive: 'rgba(128,128,128,0.28)',
        accent: dark ? '#7ab8ff' : '#2e6fdb',
      }
    }

    // The shell flips a body attribute to change theme; React gets no signal
    // for it, so anything we inject outside React's tree keeps the old
    // palette until an unrelated re-render. Components that paint with
    // palette() subscribe to this instead.
    function useThemeTick() {
      var state = React.useState(0)
      React.useEffect(function () {
        if (typeof MutationObserver === 'undefined' || !document.body) return undefined
        var observer = new MutationObserver(function () {
          state[1](function (n) { return n + 1 })
        })
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return function () { observer.disconnect() }
      }, [])
      return state[0]
    }

    // ------------------------- per-session preferences -------------------------
    // Each job session keeps its own layout preference (pane open/closed)
    // under a session-scoped localStorage key.
    function prefsKey(sessionId) {
      return 'dsh-job-cv:prefs:' + sessionId
    }
    function loadPrefs(sessionId) {
      try {
        var raw = localStorage.getItem(prefsKey(sessionId))
        if (raw !== null) {
          var parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') return { open: parsed.open !== false }
        }
      } catch (e) { /* fall through */ }
      return { open: true }
    }
    function savePrefs(sessionId, prefs) {
      try {
        localStorage.setItem(prefsKey(sessionId), JSON.stringify(prefs))
      } catch (e) { /* storage full/blocked — preference stays ephemeral */ }
    }

    // ------------------------- document client -------------------------
    // Talks to the host half's /jobcv/* surface. All requests are same-origin
    // relative paths, JSON in and out.
    function fetchDoc(sessionId) {
      return fetch('/jobcv/doc?session=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }).then(function (res) {
        if (!res.ok) {
          var error = new Error('doc fetch failed: ' + res.status)
          error.status = res.status
          throw error
        }
        return res.json()
      })
    }

    /** One historical body, fetched only when the user asks to look at it. */
    function fetchVersion(sessionId, version) {
      return fetch(
        '/jobcv/history?session=' + encodeURIComponent(sessionId) + '&version=' + String(version),
        { method: 'GET', headers: { 'content-type': 'application/json' } },
      ).then(function (res) {
        if (!res.ok) throw new Error('version fetch failed: ' + res.status)
        return res.json()
      })
    }

    // Why the poll stopped working, in words the user can act on. A 403 is
    // the one that looks like a hang rather than an error: the host only
    // trusts loopback, so opening the GUI on a LAN address or through a
    // tunnel makes every poll fail and the preview silently never updates.
    function offlineReason(error) {
      if (error && error.status === 403) {
        var host = typeof location === 'undefined' ? '' : location.hostname
        return (
          'the host refused this origin' +
          (host === '' ? '' : ' (' + host + ')') +
          ' — open the GUI on localhost, not a LAN address or tunnel'
        )
      }
      if (error && error.status !== undefined) return 'the host answered ' + error.status
      return 'the plugin host is not answering — is `dsh web` still running?'
    }

    // The candidacy folder for a session (path + files), so the dock can
    // show what the agent has saved into the workspace.
    function fetchWorkspace(sessionId) {
      return fetch('/jobcv/workspace?session=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }).then(function (res) {
        if (!res.ok) throw new Error('workspace fetch failed: ' + res.status)
        return res.json()
      })
    }

    // The saved versions (newest first, bodies omitted) for the rollback UI.
    function fetchHistory(sessionId) {
      return fetch('/jobcv/history?session=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }).then(function (res) {
        if (!res.ok) throw new Error('history fetch failed: ' + res.status)
        return res.json()
      })
    }

    // Roll the document back to an earlier version; resolves to the new
    // version number.
    function restoreVersion(sessionId, version) {
      return fetch('/jobcv/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, version: version }),
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) {
            var detail = body && body.error ? body.error : 'restore failed'
            throw new Error(detail + ' (' + res.status + ')')
          }
          if (!body || typeof body.version !== 'number') throw new Error('host returned no version')
          return body.version
        })
      })
    }

// ------------------------- starter document -------------------------
// A clean A4 starter CV shown when the session has no saved document yet.
// Rendered locally (never saved until the agent writes a real one) so
// the main pane demonstrates the final shape from the first second.
function starterDoc() {
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8">',
    '<title>CV</title>',
    '<style>',
    '@page{size:A4;margin:0}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    'html,body{background:#fff}',
    'body{font-family:Georgia,serif;color:#1a1a1a;font-size:11pt;line-height:1.45}',
    '.page{width:210mm;min-height:297mm;padding:18mm 17mm}',
    'h1{font-size:22pt;letter-spacing:.5px;margin-bottom:2mm}',
    '.sub{color:#555;font-size:10pt;margin-bottom:8mm}',
    'h2{font-size:11pt;text-transform:uppercase;letter-spacing:1.2px;border-bottom:1px solid #ccc;padding-bottom:1mm;margin:6mm 0 2.5mm}',
    '.item{margin-bottom:2.5mm}',
    '.row{display:flex;justify-content:space-between}',
    '.muted{color:#666;font-size:9.5pt}',
    'ul{padding-left:5mm}',
    'li{margin-bottom:1mm}',
    '</style></head><body>',
    '<div class="page">',
    '<h1>Your Name</h1>',
    '<div class="sub">your.email@example.com &middot; +1 555 0100 &middot; linkedin.com/in/you &middot; City, Country</div>',
    '<h2>Professional Summary</h2>',
    '<p class="item">A one-paragraph summary tailored to the target role. The agent rewrites this section first to mirror the job post language.</p>',
    '<h2>Experience</h2>',
    '<div class="item"><div class="row"><strong>Senior Something</strong><span class="muted">2022 &ndash; Present</span></div>',
    '<div class="muted">Company Name</div>',
    '<ul><li>Achievement quantified against the job requirements.</li><li>Achievement with numbers.</li></ul></div>',
    '<div class="item"><div class="row"><strong>Something</strong><span class="muted">2019 &ndash; 2022</span></div>',
    '<div class="muted">Earlier Company</div>',
    '<ul><li>Earlier achievement.</li></ul></div>',
    '<h2>Education</h2>',
    '<div class="item"><div class="row"><strong>Degree</strong><span class="muted">2015 &ndash; 2019</span></div><div class="muted">University</div></div>',
    '<h2>Skills</h2>',
    '<p class="item">Skill one &middot; skill two &middot; skill three</p>',
    '</div></body></html>',
  ].join('\n')
}

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

// ------------------------- review: decide before it changes -------------------------
// A wording change is the user's call — it is their CV and their claims about
// themselves. So the agent proposes content edits instead of saving them, and
// this panel is where they are accepted, swapped for an alternative, rewritten
// by hand, or dropped. One comment often implicates several parts, so a
// proposal is reviewed as a set and answered in one message.

/** The decision message: what the agent should now write, per change. */
function buildDecisionMessage(proposal, decisions) {
  var lines = []
  var changes = proposal && Array.isArray(proposal.changes) ? proposal.changes : []
  var kept = 0
  for (var i = 0; i < changes.length; i++) {
    if ((decisions[changes[i].id] || {}).skipped !== true) kept += 1
  }
  lines.push(
    'Here are my decisions on your proposed changes (' +
      String(kept) +
      ' of ' +
      String(changes.length) +
      ' to apply):',
  )
  lines.push('')
  for (var c = 0; c < changes.length; c++) {
    var change = changes[c]
    var decision = decisions[change.id] || {}
    var where = change.section ? 'section "' + change.section + '"' : 'no section heading'
    lines.push(String(c + 1) + '. In ' + where + (change.path ? ' — ' + change.path : ''))
    if (change.current) lines.push('   Currently: "' + clip(change.current, 200) + '"')
    if (decision.skipped === true) {
      lines.push('   SKIP — leave this exactly as it is.')
    } else if (squish(decision.refined || '') !== '') {
      lines.push('   USE MY WORDING, verbatim: "' + squish(decision.refined) + '"')
    } else {
      var chosen = pickedOption(change, decision)
      lines.push(
        '   USE your option "' + chosen.label + '", verbatim: "' + squish(chosen.text) + '"',
      )
    }
    lines.push('')
  }
  lines.push(
    'Apply exactly these — do not re-word what I chose or fold in edits I skipped. Save the full document with POST /jobcv/doc, then tell me in a sentence what changed and flag anything that now reads inconsistently elsewhere in the CV.',
  )
  return lines.join('\n')
}

/** The option a decision points at, defaulting to the first. */
function pickedOption(change, decision) {
  var options = Array.isArray(change.options) ? change.options : []
  for (var i = 0; i < options.length; i++) {
    if (options[i].id === (decision || {}).optionId) return options[i]
  }
  return options[0] || { id: '', label: 'option', text: '' }
}

/** Tell the host the pending set has been answered. */
function clearProposal(sessionId) {
  return fetch('/jobcv/proposal/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId }),
  }).then(function (res) {
    if (!res.ok) throw new Error('could not clear the proposal: ' + res.status)
    return res.json()
  })
}

function ReviewPanel(props) {
  var pal = props.pal
  var proposal = props.proposal
  var changes = Array.isArray(proposal.changes) ? proposal.changes : []
  var decisionsState = React.useState({})
  var decisions = decisionsState[0]
  var setDecisions = decisionsState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var noteState = React.useState(null)
  var note = noteState[0]
  var setNote = noteState[1]

  function decide(changeId, patch) {
    var next = {}
    for (var key in decisions) next[key] = decisions[key]
    next[changeId] = Object.assign({}, next[changeId] || {}, patch)
    setDecisions(next)
  }

  var applying = 0
  for (var i = 0; i < changes.length; i++) {
    if ((decisions[changes[i].id] || {}).skipped !== true) applying += 1
  }

  function apply() {
    if (applying === 0) {
      setNote('nothing selected — skip them all, or pick at least one')
      return
    }
    setBusy(true)
    var message = buildDecisionMessage(proposal, decisions)
    var via = deliverToComposer(props.inputActions, message, props.draft)
    if (via === null) {
      setBusy(false)
      setNote(deliveryNotice(via))
      return
    }
    // Retire the pending set only once the decision is on its way, so a failed
    // send never leaves the user with nothing to decide and nothing sent.
    clearProposal(props.sessionId)
      .then(function () {
        setBusy(false)
        setNote(deliveryNotice(via))
        if (via === 'sent' && props.onWorkStarted) props.onWorkStarted()
      })
      .catch(function (error) {
        setBusy(false)
        setNote(String(error && error.message ? error.message : error))
      })
  }

  function dismissAll() {
    setBusy(true)
    clearProposal(props.sessionId)
      .then(function () {
        setBusy(false)
      })
      .catch(function () {
        setBusy(false)
      })
  }

  var btn = {
    border: '1px solid ' + pal.controlBorder,
    background: pal.controlBg,
    color: pal.textStrong,
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: '16px',
    padding: '4px 10px',
    borderRadius: 6,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  }

  return createElement(
    'div',
    {
      style: {
        flex: 'none',
        maxHeight: '58%',
        overflow: 'auto',
        padding: '10px 12px 12px',
        borderBottom: '1px solid ' + pal.panelBorder,
        background: pal.panelBg,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
    },
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
      createElement(
        'span',
        {
          style: {
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: pal.accent,
          },
        },
        changes.length === 1 ? '1 proposed change' : changes.length + ' proposed changes',
      ),
      createElement(
        'span',
        { style: { fontSize: 11, color: pal.text } },
        'nothing is saved until you apply',
      ),
    ),
    proposal.summary
      ? createElement(
          'div',
          { style: { fontSize: 12, color: pal.textStrong, lineHeight: '17px' } },
          proposal.summary,
        )
      : null,
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      changes.map(function (change, index) {
        var decision = decisions[change.id] || {}
        var skipped = decision.skipped === true
        var chosen = pickedOption(change, decision)
        return createElement(
          'div',
          {
            key: change.id,
            style: {
              border: '1px solid ' + pal.panelBorder,
              borderRadius: 8,
              padding: '8px 10px',
              opacity: skipped ? 0.55 : 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            },
          },
          createElement(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } },
            createElement(
              'span',
              { style: { fontSize: 11, color: pal.accent } },
              String(index + 1) + '.',
            ),
            createElement(
              'span',
              { style: { fontSize: 11, fontWeight: 600, color: pal.textStrong } },
              change.section || 'CV',
            ),
            createElement('span', { style: { flex: 1 } }),
            createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  decide(change.id, { skipped: !skipped })
                },
                style: Object.assign({}, btn, { fontSize: 11, padding: '2px 8px' }),
              },
              skipped ? 'include' : 'skip',
            ),
          ),
          change.why
            ? createElement(
                'div',
                { style: { fontSize: 11, color: pal.text, fontStyle: 'italic' } },
                change.why,
              )
            : null,
          change.current
            ? createElement(
                'div',
                {
                  style: {
                    fontSize: 12,
                    color: pal.text,
                    textDecoration: skipped ? 'none' : 'line-through',
                    opacity: 0.8,
                  },
                },
                clip(change.current, 220),
              )
            : null,
          skipped
            ? null
            : createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                change.options.map(function (option) {
                  var active = option.id === chosen.id
                  return createElement(
                    'button',
                    {
                      key: option.id,
                      type: 'button',
                      onClick: function () {
                        decide(change.id, { optionId: option.id, refined: '' })
                      },
                      style: {
                        textAlign: 'left',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 12,
                        lineHeight: '17px',
                        padding: '6px 9px',
                        borderRadius: 6,
                        color: pal.textStrong,
                        border: '1px solid ' + (active ? pal.accent : pal.controlBorder),
                        background: active
                          ? pal.dark
                            ? 'rgba(122,184,255,0.14)'
                            : 'rgba(46,111,219,0.09)'
                          : 'transparent',
                      },
                    },
                    createElement(
                      'div',
                      {
                        style: {
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          color: active ? pal.accent : pal.text,
                          marginBottom: 2,
                        },
                      },
                      option.label,
                    ),
                    option.text,
                  )
                }),
              ),
          skipped
            ? null
            : createElement('textarea', {
                value: decision.refined || '',
                placeholder: 'or write it yourself — this wins over the options above',
                onChange: function (e) {
                  decide(change.id, { refined: e.target.value })
                },
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  minHeight: 34,
                  fontFamily: 'inherit',
                  fontSize: 12,
                  padding: '5px 8px',
                  borderRadius: 6,
                  border: '1px solid ' + pal.controlBorder,
                  background: pal.dark ? 'rgba(0,0,0,0.25)' : '#fff',
                  color: pal.textStrong,
                },
              }),
        )
      }),
    ),
    note !== null
      ? createElement('div', { style: { fontSize: 11, color: pal.accent } }, note)
      : null,
    createElement(
      'div',
      { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      createElement(
        'button',
        {
          type: 'button',
          onClick: apply,
          disabled: busy,
          style: Object.assign({}, btn, {
            background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
            borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
          }),
        },
        busy ? 'sending…' : applying === changes.length ? 'Apply all' : 'Apply ' + applying,
      ),
      createElement(
        'button',
        { type: 'button', onClick: dismissAll, disabled: busy, style: btn },
        'Dismiss',
      ),
    ),
  )
}

// ------------------------- onboarding: start a job application -------------------------
// A fresh session (version 0) shows this start form in the preview instead of
// the starter CV. It collects the two inputs the workflow needs — the public
// job post link and the current CV — where the CV is either a typed path or a
// file dropped onto the form (staged through POST /jobcv/intake, whose
// returned path is filled in). Submitting hands both to the chat so the agent
// upserts the candidacy workspace and tailors the CV. A company name is
// optional: it steers the agent's upsert, and — when the composer is
// unreachable — lets the form open the workspace directly as a fallback.

/** Read a File as base64 (the data:…;base64, prefix stripped). */
function readFileAsBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader()
    reader.onload = function () {
      var result = String(reader.result || '')
      var comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = function () {
      reject(new Error('could not read the file'))
    }
    reader.readAsDataURL(file)
  })
}

/** Stage a dropped CV with the host; resolve to the stored path. */
function intakeCv(sessionId, file) {
  return readFileAsBase64(file).then(function (dataBase64) {
    return fetch('/jobcv/intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId,
        filename: file.name,
        dataBase64: dataBase64,
      }),
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) {
          var detail = body && body.error ? body.error : 'intake failed'
          throw new Error(detail + ' (' + res.status + ')')
        }
        if (!body || typeof body.path !== 'string' || body.path === '') {
          throw new Error('host returned no staged path')
        }
        return body
      })
    })
  })
}

/** Upsert the candidacy workspace directly from the form (fallback path). */
function upsertWorkspace(sessionId, company, jobUrl) {
  return fetch('/jobcv/workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: sessionId,
      company: company,
      jobUrl: jobUrl,
    }),
  }).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok) {
        var detail = body && body.error ? body.error : 'workspace upsert failed'
        throw new Error(detail + ' (' + res.status + ')')
      }
      if (!body || typeof body.path !== 'string' || body.path === '') {
        throw new Error('host returned no workspace path')
      }
      return body
    })
  })
}

/**
 * The chat message the start form hands to the agent. When the form already
 * opened the workspace (direct fallback), the message names the exact path so
 * the agent adopts that folder instead of deriving a different one.
 */
function buildStartMessage(link, cvPath, company, workspacePath, sessionId) {
  var lines = [
    'Start a new job application for me.',
    '',
    'Job post link: ' + link,
    'My CV: ' + cvPath,
  ]
  if (company) lines.push('Company: ' + company)
  // The agent cannot discover this: personas expand only {{model}} and
  // {{cwd}}, and nothing puts a session id in its environment. Left to guess
  // it saves to a document the preview is not watching, and the pane sits on
  // this form while the work lands somewhere invisible.
  if (sessionId) {
    lines.push('Session id: ' + sessionId + '  (use this exact string in every /jobcv call)')
  }
  lines.push('')
  if (workspacePath) {
    lines.push(
      'The candidacy workspace is already open at ' +
        workspacePath +
        ' (POST /jobcv/workspace with the same company and this job link returns',
      'created:false — adopt that folder, do not create a new one). Read my CV',
      'at the path above, and tailor it against the job post. Save the tailored',
      'CV through POST /jobcv/doc and tell me what you changed.',
    )
  } else {
    lines.push(
      'Open the candidacy workspace for this job first (POST /jobcv/workspace',
      'with the company name and job id from the post), read my CV at the path',
      'above, and tailor it against the job post. Save the tailored CV through',
      'POST /jobcv/doc and tell me what you changed.',
    )
  }
  return lines.join('\n')
}

function StartForm(props) {
  var pal = props.pal
  var sessionId = props.sessionId
  var inputActions = props.inputActions

  var linkState = React.useState('')
  var link = linkState[0]
  var setLink = linkState[1]
  var pathState = React.useState('')
  var path = pathState[0]
  var setPath = pathState[1]
  var companyState = React.useState('')
  var company = companyState[0]
  var setCompany = companyState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var statusState = React.useState(null)
  var status = statusState[0]
  var setStatus = statusState[1]
  // The composed message when neither the composer nor the clipboard was
  // reachable: shown inline so nothing the user typed is lost.
  var fallbackState = React.useState(null)
  var fallback = fallbackState[0]
  var setFallback = fallbackState[1]
  var fileRef = React.useRef(null)

  // Both paths through the same pipeline: a drag-drop and a picked file.
  function stageFile(file) {
    if (!file || busy) return
    setBusy(true)
    setStatus('staging ' + file.name + '…')
    intakeCv(sessionId, file)
      .then(function (body) {
        setBusy(false)
        setPath(body.path)
        setStatus('staged: ' + body.path)
      })
      .catch(function (err) {
        setBusy(false)
        setStatus('could not stage the file: ' + String(err && err.message ? err.message : err))
      })
  }

  function onDrop(e) {
    e.preventDefault()
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
    stageFile(file)
  }

  function onPickFile(e) {
    var file = e.target && e.target.files && e.target.files[0]
    stageFile(file)
    // Reset so picking the same file again still fires onChange.
    e.target.value = ''
  }

  function submit() {
    var jobLink = squish(link)
    var cvPath = squish(path)
    var companyName = squish(company)
    if (jobLink === '') {
      setStatus('paste the job post link first')
      return
    }
    if (cvPath === '') {
      setStatus('give the CV path or drop the file')
      return
    }
    var via = deliverToComposer(
      inputActions,
      buildStartMessage(jobLink, cvPath, companyName, null, sessionId),
      props.draft,
    )
    if (via !== null) {
      setFallback(null)
      setStatus(via === 'sent' ? 'sent — the agent is on it' : deliveryNotice(via))
      if (via === 'sent' && props.onWorkStarted) props.onWorkStarted()
      return
    }
    // Composer AND clipboard unreachable. With a company name the form can at
    // least open the workspace itself so the folder exists; without one it
    // only surfaces the message to copy. Either way nothing is silently lost.
    if (companyName !== '') {
      setBusy(true)
      setStatus('opening the candidacy workspace directly…')
      upsertWorkspace(sessionId, companyName, jobLink)
        .then(function (body) {
          setBusy(false)
          setStatus('workspace open at ' + body.path + ' — copy the message below into the chat')
          setFallback(buildStartMessage(jobLink, cvPath, companyName, body.path, sessionId))
        })
        .catch(function (err) {
          setBusy(false)
          setStatus(
            'could not open the workspace: ' + String(err && err.message ? err.message : err),
          )
          setFallback(buildStartMessage(jobLink, cvPath, companyName, null, sessionId))
        })
    } else {
      setStatus('could not reach the composer — add a company name to open the workspace directly')
      setFallback(buildStartMessage(jobLink, cvPath, companyName, null, sessionId))
    }
  }

  var field = {
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: '18px',
    padding: '7px 9px',
    borderRadius: 6,
    border: '1px solid ' + pal.controlBorder,
    background: pal.dark ? 'rgba(0,0,0,0.25)' : '#fff',
    color: pal.textStrong,
  }
  var label = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: pal.text,
    marginBottom: 4,
  }
  var btn = {
    border: '1px solid ' + pal.controlBorder,
    background: pal.controlBg,
    color: pal.textStrong,
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: '16px',
    padding: '6px 14px',
    borderRadius: 6,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  }
  var primaryBtn = Object.assign({}, btn, {
    background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
    borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
    marginTop: 4,
  })

  return createElement(
    'div',
    {
      style: {
        maxWidth: 520,
        margin: '0 auto',
        padding: '26px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
    },
    createElement(
      'div',
      { style: { fontSize: 15, fontWeight: 600, color: pal.textStrong } },
      'Start a job application',
    ),
    createElement(
      'div',
      { style: { fontSize: 12, color: pal.text, lineHeight: 1.5 } },
      'Paste the public link of the job post and point at your current CV. ' +
        'The agent opens a workspace for this candidacy and tailors the CV ' +
        'into the preview.',
    ),
    createElement('label', { style: label }, 'Job post link'),
    createElement('input', {
      value: link,
      placeholder: 'https://…',
      onChange: function (e) {
        setLink(e.target.value)
      },
      style: field,
    }),
    createElement('label', { style: label }, 'Your CV'),
    createElement('input', {
      value: path,
      placeholder: '/path/to/cv.pdf',
      onChange: function (e) {
        setPath(e.target.value)
      },
      style: field,
    }),
    createElement(
      'div',
      {
        onDragOver: function (e) {
          e.preventDefault()
        },
        onDrop: onDrop,
        onClick: function () {
          if (!busy && fileRef.current) fileRef.current.click()
        },
        style: {
          border: '1px dashed ' + pal.controlBorder,
          borderRadius: 6,
          padding: '16px 12px',
          textAlign: 'center',
          fontSize: 12,
          color: pal.text,
          cursor: 'pointer',
          background: pal.panelBg,
        },
      },
      busy ? 'staging…' : 'drop the CV file here, or click to browse (PDF/DOCX)',
    ),
    createElement('input', {
      ref: fileRef,
      type: 'file',
      accept: '.pdf,.doc,.docx,application/pdf',
      onChange: onPickFile,
      style: { display: 'none' },
    }),
    createElement('label', { style: label }, 'Company (optional)'),
    createElement('input', {
      value: company,
      placeholder: 'Acme Corp — steers the workspace folder',
      onChange: function (e) {
        setCompany(e.target.value)
      },
      style: field,
    }),
    status ? createElement('div', { style: { fontSize: 12, color: pal.accent } }, status) : null,
    fallback
      ? createElement(
          'div',
          {
            style: {
              border: '1px solid ' + pal.controlBorder,
              borderRadius: 6,
              padding: '8px 10px',
              background: pal.panelBg,
            },
          },
          createElement(
            'div',
            { style: { fontSize: 11, color: pal.text, marginBottom: 4 } },
            'Copy this into the chat:',
          ),
          createElement('textarea', {
            readOnly: true,
            value: fallback,
            onFocus: function (e) {
              e.target.select()
            },
            style: Object.assign({}, field, { minHeight: 120, resize: 'vertical' }),
          }),
        )
      : null,
    createElement('button', { type: 'button', onClick: submit, style: primaryBtn }, 'Start'),
  )
}

// ------------------------- CV preview pane -------------------------
// The preview surface: a toolbar (status, job link, version, export) plus a
// sandboxed iframe rendering the document. Rendered either inside the main
// area (split mode) or as a full-viewport overlay.
//
// sandbox="allow-same-origin allow-modals":
//   - allow-same-origin lets Export PDF reach contentWindow.print() and lets
//     onLoad measure the document height;
//   - allow-modals is what actually makes print() run. Without it the spec
//     sends print() down the "sandboxed modals" early return, and it does so
//     SILENTLY — print() returns normally, so a try/catch fallback around it
//     never fires and the button just does nothing;
//   - allow-scripts stays OFF deliberately. The document is agent-authored
//     HTML, and allow-scripts together with allow-same-origin would let it
//     reach straight back into the harness page.
// Inline styles cannot express keyframes, so the two animations the working
// state needs are injected once into the host page.
var ANIM_STYLE_ID = 'dsh-job-cv-anim'
function ensureAnimations() {
  try {
    if (typeof document === 'undefined' || document.getElementById(ANIM_STYLE_ID)) return
    var style = document.createElement('style')
    style.id = ANIM_STYLE_ID
    style.textContent =
      '@keyframes dsh-job-cv-shimmer{0%{background-position:-480px 0}100%{background-position:480px 0}}' +
      '@keyframes dsh-job-cv-pulse{0%,100%{opacity:.55}50%{opacity:.95}}' +
      // Each dot swells and settles in turn, so the row reads left to right
      // as one motion rather than three things blinking.
      '@keyframes dsh-job-cv-dot{0%,70%,100%{transform:scale(.55);opacity:.35}' +
      '30%{transform:scale(1);opacity:1}}'
    ;(document.head || document.body).appendChild(style)
  } catch (e) {
    /* the working state degrades to a static placeholder */
  }
}

/** One shimmering placeholder bar on the skeleton page. */
function bar(width, height, top) {
  return createElement('div', {
    key: String(top) + '-' + String(width),
    style: {
      height: height,
      width: width,
      marginBottom: 9,
      borderRadius: 3,
      background:
        'linear-gradient(90deg, rgba(0,0,0,0.06) 25%, rgba(0,0,0,0.12) 37%, rgba(0,0,0,0.06) 63%)',
      backgroundSize: '480px 100%',
      animation: 'dsh-job-cv-shimmer 1.4s ease-in-out infinite',
    },
  })
}

/**
 * The A4 sheet shown while the FIRST CV is being written. There is nothing to
 * blur yet, and the starter template would be a lie — it is not the user's
 * document and never was.
 */
function CvSkeleton(props) {
  var pal = props.pal
  return createElement(
    'div',
    {
      style: {
        width: '210mm',
        maxWidth: '100%',
        minHeight: '297mm',
        flex: 'none',
        background: '#fff',
        border: '1px solid ' + pal.panelBorder,
        borderRadius: 3,
        boxShadow: pal.dark ? '0 2px 14px rgba(0,0,0,0.45)' : '0 2px 14px rgba(0,0,0,0.13)',
        padding: '18mm 17mm',
        boxSizing: 'border-box',
      },
    },
    bar('52%', 26, 0),
    bar('72%', 11, 1),
    createElement('div', { key: 'gap1', style: { height: 18 } }),
    bar('34%', 12, 2),
    bar('100%', 10, 3),
    bar('96%', 10, 4),
    bar('88%', 10, 5),
    createElement('div', { key: 'gap2', style: { height: 16 } }),
    bar('28%', 12, 6),
    bar('64%', 10, 7),
    bar('92%', 10, 8),
    bar('80%', 10, 9),
    createElement('div', { key: 'gap3', style: { height: 16 } }),
    bar('30%', 12, 10),
    bar('86%', 10, 11),
    bar('70%', 10, 12),
  )
}

/**
 * Three dots swelling in sequence: the plugin's one "something is happening"
 * mark. Used over the document AND in the dock, because the work continues
 * whether or not the preview is folded away — and a folded preview with no
 * sign of life reads as nothing happening at all.
 */
function WorkingDots(props) {
  ensureAnimations()
  var size = props.size || 6
  var color = props.color
  return createElement(
    'span',
    {
      'aria-label': 'working',
      style: { display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.6) },
    },
    [0, 1, 2].map(function (i) {
      return createElement('span', {
        key: i,
        style: {
          width: size,
          height: size,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
          animation: 'dsh-job-cv-dot 1.1s ease-in-out infinite',
          animationDelay: i * 0.16 + 's',
        },
      })
    }),
  )
}

/** The "the agent is on it" badge floating over the document surface. */
function WorkingBadge(props) {
  var pal = props.pal
  return createElement(
    'div',
    {
      style: {
        position: 'absolute',
        top: 18,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 3,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 13px',
        borderRadius: 999,
        fontSize: 12,
        color: pal.textStrong,
        background: pal.dark ? 'rgba(28,30,34,0.92)' : 'rgba(255,255,255,0.94)',
        border: '1px solid ' + pal.panelBorder,
        boxShadow: '0 3px 14px rgba(0,0,0,0.18)',
        pointerEvents: 'none',
      },
    },
    createElement(WorkingDots, { color: pal.accent, size: 6 }),
    props.label,
  )
}

function CvPane(props) {
  useThemeTick()
  var pal = palette()
  var doc = props.doc
  var iframeRef = React.useRef(null)
  // Which of the two documents is on screen. The letter is a second
  // document, not a section of the CV: its own version line, its own file.
  var viewState = React.useState('cv')
  var view = doc.letter ? viewState[0] : 'cv'
  var setView = viewState[1]
  var showingLetter = view === 'letter' && doc.letter
  var showingOld = looking !== null && !showingLetter
  var starter = doc.version === 0 && !showingLetter && !showingOld
  var html = showingOld
    ? looking.html
    : showingLetter
      ? doc.letter.html
      : starter
        ? starterDoc()
        : doc.html
  var working = props.working === true
  ensureAnimations()
  // A fresh session has no document yet: the pane shows the onboarding
  // start form (job link + CV path/file) instead of a CV surface.
  var onboarding = starter && !doc.workspace

  // ---- comment mode ----
  var annotatingState = React.useState(false)
  var annotating = annotatingState[0]
  var setAnnotating = annotatingState[1]
  var pickedState = React.useState(null)
  var picked = pickedState[0]
  var setPicked = pickedState[1]
  var draftState = React.useState('')
  var draft = draftState[0]
  var setDraft = draftState[1]
  var notesState = React.useState([])
  var notes = notesState[0]
  var setNotes = notesState[1]
  var sentState = React.useState(null)
  var sent = sentState[0]
  var setSent = sentState[1]
  // Bumped by the iframe's onLoad: the listener effect below has to run
  // AFTER the document exists, and a new version remounts the frame.
  var loadState = React.useState(0)
  var loadTick = loadState[0]
  var bumpLoad = loadState[1]
  var pickedElRef = React.useRef(null)

  // ---- version history / rollback ----
  var historyOpenState = React.useState(false)
  var historyOpen = historyOpenState[0]
  var setHistoryOpen = historyOpenState[1]
  var versionsState = React.useState([])
  var versions = versionsState[0]
  var setVersions = versionsState[1]
  var restoreBusyState = React.useState(false)
  var restoreBusy = restoreBusyState[0]
  var setRestoreBusy = restoreBusyState[1]
  var restoreStatusState = React.useState(null)
  var restoreStatus = restoreStatusState[0]
  var setRestoreStatus = restoreStatusState[1]
  // A historical version being LOOKED AT. Nothing is written by looking; the
  // document only changes if the user then restores.
  var lookingState = React.useState(null)
  var looking = lookingState[0]
  var setLooking = lookingState[1]

  function lookAt(version) {
    if (version === doc.version) {
      setLooking(null)
      return
    }
    setRestoreStatus(null)
    fetchVersion(props.sessionId, version)
      .then(function (body) {
        setLooking({ version: version, html: body.html })
      })
      .catch(function (error) {
        setRestoreStatus(String(error && error.message ? error.message : error))
      })
  }

  function toggleHistory() {
    var next = !historyOpen
    setHistoryOpen(next)
    setRestoreStatus(null)
    if (next) {
      fetchHistory(props.sessionId)
        .then(function (body) {
          setVersions((body && body.versions) || [])
        })
        .catch(function () {
          setVersions([])
          setRestoreStatus('could not load the version history')
        })
    }
  }

  function restoreTo(version) {
    if (restoreBusy) return
    setRestoreBusy(true)
    setRestoreStatus('restoring v' + version + '…')
    restoreVersion(props.sessionId, version)
      .then(function (newVersion) {
        setRestoreBusy(false)
        setHistoryOpen(false)
        // The doc poll picks the restored document up within a poll interval.
        setRestoreStatus('restored v' + version + ' — now v' + newVersion)
      })
      .catch(function (err) {
        setRestoreBusy(false)
        setRestoreStatus('could not restore: ' + String(err && err.message ? err.message : err))
      })
  }

  // Attach picking to the iframe document. Same-origin access is what makes
  // this possible without giving the frame allow-scripts.
  React.useEffect(
    function () {
      if (!annotating) return undefined
      var idoc = null
      try {
        idoc = iframeRef.current && iframeRef.current.contentDocument
      } catch (e) {
        idoc = null
      }
      var root = idoc && idoc.body
      if (!root) return undefined

      var style = idoc.getElementById(ANNOTATE_STYLE_ID)
      if (!style) {
        style = idoc.createElement('style')
        style.id = ANNOTATE_STYLE_ID
        style.textContent = ANNOTATE_CSS
        ;(idoc.head || root).appendChild(style)
      }

      var hot = null
      function clearHot() {
        if (hot) {
          hot.removeAttribute('data-jobcv-hot')
          hot = null
        }
      }
      function onMove(e) {
        var el = pickableFrom(e.target, root)
        if (el === hot) return
        clearHot()
        if (el) {
          el.setAttribute('data-jobcv-hot', '')
          hot = el
        }
      }
      function onClick(e) {
        var el = pickableFrom(e.target, root)
        if (!el) return
        // Comment mode owns the click: no link should navigate under it.
        e.preventDefault()
        e.stopPropagation()
        pickedElRef.current = el
        setPicked(noteFrom(el, root, doc.version))
        setSent(null)
      }
      root.addEventListener('mousemove', onMove, true)
      root.addEventListener('mouseleave', clearHot, true)
      root.addEventListener('click', onClick, true)
      return function () {
        clearHot()
        root.removeEventListener('mousemove', onMove, true)
        root.removeEventListener('mouseleave', clearHot, true)
        root.removeEventListener('click', onClick, true)
        if (style && style.parentNode) style.parentNode.removeChild(style)
        var marked = root.querySelectorAll('[data-jobcv-noted]')
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-jobcv-noted')
      }
    },
    [annotating, loadTick, doc.version],
  )

  // Everything queued, including a note still being typed.
  function collectNotes() {
    var pending =
      picked && squish(draft) !== '' ? [Object.assign({}, picked, { comment: draft })] : []
    return notes.concat(pending)
  }

  function addNote() {
    if (!picked || squish(draft) === '') return
    if (pickedElRef.current) pickedElRef.current.setAttribute('data-jobcv-noted', '')
    setNotes(notes.concat([Object.assign({}, picked, { comment: draft })]))
    setPicked(null)
    setDraft('')
    pickedElRef.current = null
  }

  function sendNotes() {
    var batch = collectNotes()
    if (batch.length === 0) return
    var message = buildRevisionMessage(batch, { version: doc.version, jobUrl: doc.jobUrl })
    var via = deliverToComposer(props.inputActions, message, props.draft)
    setSent(deliveryNotice(via))
    if (via === 'sent' && props.onWorkStarted) props.onWorkStarted()
    if (via !== null) {
      setNotes([])
      setPicked(null)
      setDraft('')
      pickedElRef.current = null
      setAnnotating(false)
    }
  }

  // A save while looking at an old version would leave the pane showing
  // something the timeline no longer describes.
  React.useEffect(
    function () {
      setLooking(null)
    },
    [doc.version],
  )

  function askForLetter() {
    var via = deliverToComposer(props.inputActions, buildLetterRequest(doc), props.draft)
    setSent(deliveryNotice(via))
    if (via === 'sent' && props.onWorkStarted) props.onWorkStarted()
  }

  function toggleAnnotating() {
    var next = !annotating
    setAnnotating(next)
    setSent(null)
    if (!next) {
      setPicked(null)
      setDraft('')
      setNotes([])
      pickedElRef.current = null
    }
  }

  function exportPdf() {
    var win = null
    try {
      win = iframeRef.current && iframeRef.current.contentWindow
      if (win) {
        win.focus()
        win.print()
        return
      }
    } catch (e) {
      /* fall through to the standalone-window fallback */
    }
    // Reached only when the frame is genuinely unreachable (detached, or a
    // browser that refuses same-origin srcdoc access).
    var w = window.open('', '_blank')
    if (w) {
      w.document.open()
      w.document.write(html)
      w.document.close()
      w.focus()
    }
  }

  var toolbarBtn = {
    border: '1px solid ' + pal.controlBorder,
    background: pal.controlBg,
    color: pal.textStrong,
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: '16px',
    padding: '4px 10px',
    borderRadius: 6,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  }

  // What the version chip says: the start form, the starter template, a
  // live version, a just-landed save, or a preview that has lost contact
  // with the host.
  var statusText = showingOld
    ? 'viewing v' + looking.version + ' of ' + doc.version
    : showingLetter
      ? 'cover letter v' + doc.letter.version
      : onboarding
        ? 'start form'
        : starter
          ? 'starter template'
          : 'v' + doc.version
  var statusColor = pal.text
  if (!props.online) {
    statusText = onboarding
      ? 'host unreachable'
      : starter
        ? 'host unreachable'
        : 'v' + doc.version + ' · host unreachable'
    statusColor = pal.dark ? '#ffb4a2' : '#b3261e'
  } else if (props.flash && !starter) {
    statusText = 'v' + doc.version + ' · just updated'
    statusColor = pal.accent
  }

  return createElement(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: pal.baseBg,
      },
    },
    // toolbar
    createElement(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid ' + pal.panelBorder,
          flex: 'none',
          flexWrap: 'wrap',
        },
      },
      createElement(
        'span',
        {
          style: {
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: pal.text,
          },
        },
        'CV preview',
      ),
      createElement(
        'span',
        {
          title: 'Job post link the CV is tailored against',
          style: {
            fontSize: 11,
            color: pal.text,
            maxWidth: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        },
        doc.jobUrl ? doc.jobUrl : 'no job post link yet',
      ),
      createElement(
        'span',
        {
          style: {
            fontSize: 11,
            color: statusColor,
            transition: 'color 200ms ease',
          },
        },
        statusText,
      ),
      createElement('span', { style: { flex: 1 } }),
      !onboarding
        ? createElement(
            'button',
            {
              type: 'button',
              onClick: toggleHistory,
              title: 'Restore an earlier saved version of the CV',
              style: historyOpen
                ? Object.assign({}, toolbarBtn, {
                    background: pal.dark ? 'rgba(122,184,255,0.22)' : 'rgba(46,111,219,0.16)',
                    borderColor: pal.accent,
                    color: pal.accent,
                  })
                : toolbarBtn,
            },
            'History',
          )
        : null,
      !onboarding && doc.letter
        ? createElement(
            'span',
            {
              style: {
                display: 'inline-flex',
                border: '1px solid ' + pal.controlBorder,
                borderRadius: 6,
                overflow: 'hidden',
              },
            },
            ['cv', 'letter'].map(function (which) {
              var active = view === which
              return createElement(
                'button',
                {
                  key: which,
                  type: 'button',
                  onClick: function () {
                    setView(which)
                  },
                  style: {
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 12,
                    lineHeight: '16px',
                    padding: '4px 10px',
                    color: active ? pal.accent : pal.text,
                    background: active
                      ? pal.dark
                        ? 'rgba(122,184,255,0.18)'
                        : 'rgba(46,111,219,0.12)'
                      : 'transparent',
                  },
                },
                which === 'cv' ? 'CV' : 'Letter v' + doc.letter.version,
              )
            }),
          )
        : null,
      !onboarding && !doc.letter
        ? createElement(
            'button',
            {
              type: 'button',
              onClick: askForLetter,
              title: 'Ask for a one-page cover letter to go with this CV',
              style: toolbarBtn,
            },
            '+ Cover letter',
          )
        : null,
      !onboarding
        ? createElement(
            'button',
            {
              type: 'button',
              onClick: toggleAnnotating,
              title: annotating
                ? 'Stop marking parts of the CV'
                : 'Click a line in the CV to say what needs fixing',
              style: annotating
                ? Object.assign({}, toolbarBtn, {
                    background: pal.dark ? 'rgba(122,184,255,0.22)' : 'rgba(46,111,219,0.16)',
                    borderColor: pal.accent,
                    color: pal.accent,
                  })
                : toolbarBtn,
            },
            annotating ? 'Done commenting' : 'Comment on a part',
          )
        : null,
      props.canFullScreen
        ? createElement(
            'button',
            {
              type: 'button',
              onClick: props.onToggleFullScreen,
              title: props.fullScreen
                ? 'Back to the side-by-side layout'
                : 'Fill the window with the CV (Esc to return)',
              style: toolbarBtn,
            },
            props.fullScreen ? 'Exit full screen' : 'Full screen',
          )
        : null,
      createElement(
        'button',
        {
          type: 'button',
          onClick: props.onClose,
          title: 'Hide the preview (chat returns to full width)',
          style: toolbarBtn,
        },
        'Close',
      ),
      !onboarding
        ? createElement(
            'button',
            {
              type: 'button',
              onClick: exportPdf,
              title: 'Print / Save as PDF (A4)',
              style: Object.assign({}, toolbarBtn, {
                background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
                borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
              }),
            },
            'Export PDF',
          )
        : null,
    ),
    // history panel
    historyOpen
      ? createElement(HistoryPanel, {
          pal: pal,
          versions: versions,
          currentVersion: doc.version,
          busy: restoreBusy,
          status: restoreStatus,
          previewingVersion: looking === null ? null : looking.version,
          onPreview: lookAt,
          onRestore: restoreTo,
          onClose: function () {
            setHistoryOpen(false)
            setRestoreStatus(null)
          },
        })
      : null,
    showingOld
      ? createElement(
          'div',
          {
            style: {
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '6px 12px',
              fontSize: 12,
              color: pal.textStrong,
              borderBottom: '1px solid ' + pal.panelBorder,
              background: pal.dark ? 'rgba(122,184,255,0.10)' : 'rgba(46,111,219,0.08)',
            },
          },
          createElement(
            'span',
            null,
            'Looking at v' + looking.version + ' — nothing is changed until you restore it.',
          ),
          createElement('span', { style: { flex: 1 } }),
          createElement(
            'button',
            {
              type: 'button',
              onClick: function () {
                restoreTo(looking.version)
              },
              disabled: restoreBusy,
              style: Object.assign({}, toolbarBtn, {
                background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
                borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
              }),
            },
            'Restore v' + looking.version,
          ),
          createElement(
            'button',
            {
              type: 'button',
              onClick: function () {
                setLooking(null)
              },
              style: toolbarBtn,
            },
            'Back to v' + doc.version,
          ),
        )
      : null,
    // review panel — a pending proposal outranks everything else here: it is
    // the one thing blocking the document from changing.
    doc.proposal
      ? createElement(ReviewPanel, {
          pal: pal,
          proposal: doc.proposal,
          sessionId: props.sessionId,
          inputActions: props.inputActions,
          draft: props.draft,
          onWorkStarted: props.onWorkStarted,
        })
      : null,
    // comment panel
    annotating
      ? createElement(CommentPanel, {
          pal: pal,
          picked: picked,
          draft: draft,
          notes: notes,
          setDraft: setDraft,
          onAdd: addNote,
          onSend: sendNotes,
          onDropPicked: function () {
            setPicked(null)
            setDraft('')
            pickedElRef.current = null
          },
          onRemoveNote: function (index) {
            setNotes(
              notes.filter(function (n, i) {
                return i !== index
              }),
            )
          },
          pendingCount: collectNotes().length,
        })
      : null,
    sent
      ? createElement(
          'div',
          {
            style: {
              flex: 'none',
              padding: '6px 12px',
              fontSize: 11,
              color: pal.accent,
              borderBottom: '1px solid ' + pal.panelBorder,
            },
          },
          sent,
        )
      : null,
    // document surface
    createElement(
      'div',
      {
        style: {
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          justifyContent: 'center',
          padding: '14px 10px',
          position: 'relative',
        },
      },
      working
        ? createElement(WorkingBadge, {
            pal: pal,
            label: starter ? 'Writing your CV…' : 'Revising v' + doc.version + '…',
          })
        : null,
      onboarding && !working
        ? createElement(StartForm, {
            pal: pal,
            sessionId: props.sessionId,
            inputActions: props.inputActions,
            draft: props.draft,
            onWorkStarted: props.onWorkStarted,
          })
        : working && starter
          ? // Nothing to blur yet, and the starter template is not the user's
            // document — show the shape of what is coming instead.
            createElement(CvSkeleton, { pal: pal })
          : createElement('iframe', {
              key: doc.version,
              ref: iframeRef,
              srcDoc: html,
              title: 'CV document',
              sandbox: 'allow-same-origin allow-modals',
              onLoad: function () {
                // srcdoc + allow-same-origin makes the frame same-origin, so
                // the document height is readable: stretch the iframe to the
                // full multi-page height and let the outer pane scroll.
                try {
                  var frame = iframeRef.current
                  var body = frame && frame.contentDocument && frame.contentDocument.body
                  if (frame && body) frame.style.height = Math.max(body.scrollHeight, 1123) + 'px'
                } catch (e) {
                  /* keep minHeight */
                }
                bumpLoad(function (n) {
                  return n + 1
                })
              },
              style: {
                width: '210mm',
                maxWidth: '100%',
                height: 'fit-content',
                minHeight: '297mm',
                flex: 'none',
                background: '#fff',
                border: '1px solid ' + pal.panelBorder,
                borderRadius: 3,
                boxShadow: pal.dark ? '0 2px 14px rgba(0,0,0,0.45)' : '0 2px 14px rgba(0,0,0,0.13)',
                // The version on screen is about to be replaced: softened so it
                // reads as superseded, still legible enough to keep your place.
                filter: working ? 'blur(2.5px) saturate(0.85)' : 'none',
                opacity: working ? 0.62 : 1,
                transition: 'filter 240ms ease, opacity 240ms ease',
                pointerEvents: working ? 'none' : 'auto',
              },
            }),
    ),
    // reopen affordance lives in the dock, not here
  )
}

// ------------------------- history timeline -------------------------
// A column of timestamps tells you nothing about which version you want, so
// each entry carries the note its author wrote, and clicking one SHOWS it in
// the preview. Restoring is a second, deliberate step from there: looking is
// how you decide, and it should not be the same gesture as changing.
function HistoryPanel(props) {
  var pal = props.pal
  var versions = props.versions
  var current = props.currentVersion
  var previewing = props.previewingVersion

  var btn = {
    border: '1px solid ' + pal.controlBorder,
    background: pal.controlBg,
    color: pal.textStrong,
    cursor: 'pointer',
    fontSize: 11,
    lineHeight: '15px',
    padding: '2px 8px',
    borderRadius: 6,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  }

  function when(ts) {
    if (!ts) return ''
    try {
      return new Date(ts).toLocaleString()
    } catch (e) {
      return ''
    }
  }

  return createElement(
    'div',
    {
      style: {
        flex: 'none',
        maxHeight: '50%',
        overflow: 'auto',
        padding: '10px 12px 12px',
        borderBottom: '1px solid ' + pal.panelBorder,
        background: pal.panelBg,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
    },
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
      createElement(
        'span',
        {
          style: {
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: pal.text,
          },
        },
        'History',
      ),
      createElement(
        'span',
        { style: { fontSize: 11, color: pal.text } },
        'click a version to look at it — restoring is a separate step',
      ),
      createElement('span', { style: { flex: 1 } }),
      createElement('button', { type: 'button', onClick: props.onClose, style: btn }, 'Close'),
    ),
    versions === null
      ? createElement('div', { style: { fontSize: 12, color: pal.text } }, 'loading…')
      : versions.length === 0
        ? createElement(
            'div',
            { style: { fontSize: 12, color: pal.text } },
            'no saved versions yet',
          )
        : createElement(
            'div',
            { style: { position: 'relative', paddingLeft: 20 } },
            // the rail the dots sit on
            createElement('div', {
              style: {
                position: 'absolute',
                left: 5,
                top: 10,
                bottom: 10,
                width: 2,
                background: pal.panelBorder,
              },
            }),
            versions.map(function (row) {
              var isCurrent = row.version === current
              var isShown = row.version === previewing || (previewing === null && isCurrent)
              return createElement(
                'div',
                {
                  key: row.version,
                  style: { position: 'relative', paddingBottom: 6 },
                },
                createElement('span', {
                  style: {
                    position: 'absolute',
                    left: -19,
                    top: 8,
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    boxSizing: 'content-box',
                    background: isShown ? pal.accent : pal.baseBg,
                    border: '2px solid ' + (isShown ? pal.accent : pal.controlBorder),
                  },
                }),
                createElement(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      flexWrap: 'wrap',
                      padding: '4px 6px',
                      borderRadius: 6,
                      background: isShown
                        ? pal.dark
                          ? 'rgba(122,184,255,0.10)'
                          : 'rgba(46,111,219,0.07)'
                        : 'transparent',
                    },
                  },
                  createElement(
                    'button',
                    {
                      type: 'button',
                      onClick: function () {
                        props.onPreview(row.version)
                      },
                      title: 'Show this version in the preview',
                      style: {
                        border: 'none',
                        background: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        textAlign: 'left',
                        flex: 1,
                        minWidth: 140,
                      },
                    },
                    createElement(
                      'span',
                      {
                        style: {
                          fontSize: 12,
                          fontWeight: 600,
                          color: isShown ? pal.accent : pal.textStrong,
                        },
                      },
                      'v' + row.version,
                    ),
                    isCurrent
                      ? createElement(
                          'span',
                          { style: { fontSize: 10, color: pal.text, marginLeft: 6 } },
                          'current',
                        )
                      : null,
                    createElement(
                      'div',
                      { style: { fontSize: 12, color: pal.textStrong, marginTop: 1 } },
                      row.note
                        ? row.note
                        : createElement('em', { style: { color: pal.text } }, 'no note'),
                    ),
                    createElement(
                      'div',
                      { style: { fontSize: 10, color: pal.text, marginTop: 1 } },
                      when(row.updatedAt),
                    ),
                  ),
                  isCurrent
                    ? null
                    : createElement(
                        'button',
                        {
                          type: 'button',
                          onClick: function () {
                            props.onRestore(row.version)
                          },
                          disabled: props.busy,
                          title: 'Make this the current version (saved as a new one)',
                          style: btn,
                        },
                        'Restore',
                      ),
                ),
              )
            }),
          ),
    props.status !== null && props.status !== undefined
      ? createElement('div', { style: { fontSize: 11, color: pal.accent } }, props.status)
      : null,
  )
}

// ------------------------- job layout -------------------------
// The preview shows up in one of two shapes, both driven by the same dock
// button:
//
//   split   — wide viewports: the shell's center grid track is squeezed to a
//             CHAT_W chat sidebar on the right and the preview takes the
//             freed main area. Pure DOM surgery on the column React owns, in
//             the same self-healing style as dsh-trader's chart host.
//   overlay — narrow viewports, or "Full screen" on a wide one: a portal over
//             the whole window. Without this, pressing the button below
//             NARROW_VP used to do nothing at all.
var CHAT_W = 460
var NARROW_VP = 900

// The center column is the ancestor of the chat scrollport whose parent
// is the shell's grid frame (sidebar | center | details). Falls back to
// a four-level climb when the computed-style probe finds nothing.
function findCenterColumn(scroll) {
  var node = scroll
  for (var i = 0; i < 8 && node && node.parentElement; i++) {
    node = node.parentElement
    try {
      var display = getComputedStyle(node.parentElement).display
      if (display === 'grid') return node
    } catch (e) {
      /* keep climbing */
    }
  }
  return null
}

/** Track viewport width so crossing NARROW_VP switches shapes. */
function useViewportWidth() {
  var state = React.useState(typeof window === 'undefined' ? 1200 : window.innerWidth)
  React.useEffect(function () {
    function onResize() {
      state[1](window.innerWidth)
    }
    window.addEventListener('resize', onResize)
    return function () {
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return state[0]
}

/**
 * Split mode: squeeze the center column and insert a pane host to its left.
 * Returns the host element once attached, or null while it is not.
 */
function useSplitPane(enabled, pal) {
  var hostState = React.useState(null)
  var host = hostState[0]
  var setHost = hostState[1]
  var paneRef = React.useRef(null)

  // Retry ticks: the scroll node may not exist for a few frames after a
  // session switch or shell boot, so the transform re-attempts briefly
  // instead of giving up until the next re-render.
  var tickState = React.useState(0)
  var tick = tickState[0]
  var bumpTick = tickState[1]

  React.useLayoutEffect(
    function () {
      if (!enabled) return undefined
      var scroll = document.querySelector('[data-conversation-scroll]')
      if (!scroll) {
        if (tick < 20) {
          var t = setTimeout(function () {
            bumpTick(tick + 1)
          }, 300)
          return function () {
            clearTimeout(t)
          }
        }
        return undefined
      }
      var col = findCenterColumn(scroll)
      if (!col)
        col =
          (scroll.parentElement &&
            scroll.parentElement.parentElement &&
            scroll.parentElement.parentElement.parentElement) ||
          scroll.parentElement
      if (!col || col.appendChild === undefined) return undefined

      var prev = {
        position: col.style.position,
        paddingRight: col.style.paddingRight,
      }
      var pane = document.createElement('div')
      pane.setAttribute('data-dsh-job-cv-pane', '')
      // Fixed to the column's VISIBLE rect, not absolute inside it.
      //
      // top:0/bottom:0 sized the pane to the column's full height. When the
      // column is taller than the window the pane runs off the bottom of the
      // screen, so its inner scroll container never overflows and never
      // scrolls — a two-page CV simply had its second page out of reach. Full
      // screen worked precisely because it is a fixed overlay instead.
      pane.style.position = 'fixed'
      pane.style.zIndex = '5'
      pane.style.overflow = 'hidden'
      // Paint it now as well as in the theme effect below: that effect first
      // runs a frame later, and an unpainted pane shows the chat through it.
      pane.style.borderRight = '1px solid ' + pal.panelBorder
      pane.style.background = pal.baseBg

      function applyTransform() {
        if (getComputedStyle(col).position === 'static') col.style.position = 'relative'
        col.style.paddingRight = CHAT_W + 'px'
      }

      /** Track the on-screen box of the column, clipped to the window. */
      function syncPaneBox() {
        try {
          var rect = col.getBoundingClientRect()
          var viewportH = window.innerHeight || 0
          if (rect.width <= 0 || viewportH <= 0) return
          var top = Math.max(0, rect.top)
          var height = Math.max(0, Math.min(viewportH, rect.bottom) - top)
          pane.style.top = top + 'px'
          pane.style.left = Math.max(0, rect.left) + 'px'
          pane.style.width = Math.max(0, rect.width - CHAT_W) + 'px'
          pane.style.height = height + 'px'
        } catch (e) {
          /* keep the last good box rather than collapsing the pane */
        }
      }
      applyTransform()
      syncPaneBox()
      col.insertBefore(pane, col.firstChild)
      paneRef.current = pane
      setHost(pane)

      // Self-heal: a shell re-render that wipes the inline padding, or a
      // layout transition that drops/reorders the pane, is repaired here.
      var observer = new MutationObserver(function () {
        if (pane.parentElement !== col || col.firstChild !== pane) {
          if (pane.parentElement) pane.parentElement.removeChild(pane)
          col.insertBefore(pane, col.firstChild)
        }
        if (col.style.paddingRight !== CHAT_W + 'px') applyTransform()
        syncPaneBox()
      })
      observer.observe(col, { childList: true, attributes: true, attributeFilter: ['style'] })

      // The box moves with the window, with the shell's own scrollers (capture
      // catches inner ones, which do not bubble), and with layout changes.
      window.addEventListener('resize', syncPaneBox)
      window.addEventListener('scroll', syncPaneBox, true)
      var resize = null
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(syncPaneBox)
        resize.observe(col)
      }
      var settle = setTimeout(syncPaneBox, 60) // after the shell's own transition

      return function () {
        clearTimeout(settle)
        window.removeEventListener('resize', syncPaneBox)
        window.removeEventListener('scroll', syncPaneBox, true)
        if (resize !== null) resize.disconnect()
        observer.disconnect()
        paneRef.current = null
        setHost(null)
        if (pane.parentElement) pane.parentElement.removeChild(pane)
        col.style.position = prev.position
        col.style.paddingRight = prev.paddingRight
      }
    },
    [enabled, tick],
  )

  // Repaint the injected host on theme flips instead of rebuilding the
  // transform: a teardown would remount the iframe and throw away where the
  // reader had scrolled to.
  React.useEffect(
    function () {
      var pane = paneRef.current
      if (!pane) return undefined
      pane.style.borderRight = '1px solid ' + pal.panelBorder
      pane.style.background = pal.baseBg
      return undefined
    },
    [pal.panelBorder, pal.baseBg, host],
  )

  return host
}

/** Full-window shell for overlay mode; Esc leaves it. */
function CvOverlay(props) {
  var pal = props.pal
  var onEscape = props.onEscape
  React.useEffect(
    function () {
      function onKey(e) {
        if (e.key === 'Escape') onEscape()
      }
      document.addEventListener('keydown', onKey)
      return function () {
        document.removeEventListener('keydown', onKey)
      }
    },
    [onEscape],
  )
  return ReactDOM.createPortal(
    createElement(
      'div',
      {
        'data-dsh-job-cv-overlay': '',
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 9000,
          background: pal.baseBg,
          display: 'flex',
          flexDirection: 'column',
        },
      },
      props.children,
    ),
    document.body,
  )
}

function JobLayout(props) {
  useThemeTick()
  var pal = palette()
  var viewportW = useViewportWidth()
  var wide = viewportW >= NARROW_VP
  var showing = props.active && props.open
  // Below NARROW_VP there is no room for a side-by-side split, so the
  // preview takes over the window rather than refusing to open.
  var asOverlay = showing && (!wide || props.fullScreen)
  var host = useSplitPane(showing && !asOverlay, pal)

  if (!showing) return null

  var pane = createElement(CvPane, {
    doc: props.doc,
    online: props.online,
    flash: props.flash,
    inputActions: props.inputActions,
    draft: props.draft,
    working: props.working,
    onWorkStarted: props.onWorkStarted,
    sessionId: props.sessionId,
    canFullScreen: wide,
    fullScreen: asOverlay,
    onToggleFullScreen: props.onToggleFullScreen,
    onClose: props.onClose,
  })

  if (asOverlay) {
    return createElement(
      CvOverlay,
      {
        pal: pal,
        // Esc drops full screen on a wide viewport, and closes the preview
        // outright on a narrow one where there is nothing to drop back to.
        onEscape: wide ? props.onExitFullScreen : props.onClose,
      },
      pane,
    )
  }
  if (host === null) {
    return createElement(
      'div',
      { style: { padding: '6px 12px', fontSize: 11, color: pal.text } },
      'Job mode active — attaching CV preview…',
    )
  }
  return ReactDOM.createPortal(pane, host)
}

// ------------------------- dock controls + root -------------------------
// Registered into "conversation.input.dock" (the full-width row above
// the composer). Renders nothing unless the current session's preset is
// "job". When it is: a status row (mode badge, job post link, live version,
// preview toggle) plus the JobLayout that owns the preview surface.
// A turn that saves ends the working state by landing a new version. A turn
// that answers WITHOUT saving ("I need the job post text first") never does,
// so the state is also bounded in time — a preview blurred indefinitely is
// worse than one that gives up and shows what is actually there.
var WORK_GIVE_UP_MS = 6 * 60 * 1000

function JobDock(props) {
  useThemeTick()
  var pal = palette()
  var sessionId = props.sessionId
  // The user's own unsent draft: a panel appends below it instead of
  // replacing it (setDraft writes the FULL next draft).
  var draft = props.useInput
    ? props.useInput(function (input) {
        return input && typeof input.draft === 'string' ? input.draft : ''
      })
    : ''
  var presetId = props.useSessions(function (s) {
    var row = s && s.byId ? s.byId[sessionId] : undefined
    return row ? row.agentPreset : undefined
  })
  var active = presetId === 'job'

  var openState = React.useState(function () {
    return loadPrefs(sessionId).open
  })
  var open = openState[0]
  var setOpenState = openState[1]

  var fullScreenState = React.useState(false)
  var fullScreen = fullScreenState[0]
  var setFullScreenState = fullScreenState[1]

  // The dock stays mounted across session switches, so the initial state
  // above is only right for the FIRST session it sees. Re-read the incoming
  // session's own preference instead of carrying the previous one over (and
  // then writing it back under the new session's key).
  var seenSession = React.useRef(sessionId)
  if (seenSession.current !== sessionId) {
    seenSession.current = sessionId
    setOpenState(loadPrefs(sessionId).open)
    setFullScreenState(false)
  }

  var docState = React.useState({ version: 0, html: '', jobUrl: '', updatedAt: 0 })
  var doc = docState[0]
  var setDoc = docState[1]
  // What we handed the agent, and the version it was based on. Cleared as
  // soon as a newer version lands, so the working state is bounded by real
  // progress rather than by a guessed duration.
  var workingFromState = React.useState(null)
  var workingFrom = workingFromState[0]
  var setWorkingFrom = workingFromState[1]
  var offlineWhyState = React.useState(null)
  var offlineWhy = offlineWhyState[0]
  var setOfflineWhy = offlineWhyState[1]
  var onlineState = React.useState(true)
  var online = onlineState[0]
  var setOnline = onlineState[1]
  var flashState = React.useState(false)
  var flash = flashState[0]
  var setFlash = flashState[1]
  // The candidacy folder once one exists: { path, files: [{name,size,mtime}] }.
  var wsState = React.useState(null)
  var ws = wsState[0]
  var setWs = wsState[1]

  function setOpen(v) {
    savePrefs(sessionId, { open: v })
    setOpenState(v)
    if (!v) setFullScreenState(false)
  }

  React.useEffect(
    function () {
      if (workingFrom === null) return undefined
      var timer = setTimeout(function () {
        setWorkingFrom(null)
      }, WORK_GIVE_UP_MS)
      return function () {
        clearTimeout(timer)
      }
    },
    [workingFrom],
  )

  // Poll the host document while Job mode is active; the agent saves a
  // new version and the preview follows within a poll interval. The
  // candidacy folder listing rides the same tick (only once a workspace
  // exists, and only when its path changed) so the dock shows what the
  // agent has saved into it.
  React.useEffect(
    function () {
      if (!active) return undefined
      var stopped = false
      var seenVersion = -1
      var seenWsPath = null
      var flashTimer = null
      function pull() {
        fetchDoc(sessionId)
          .then(function (next) {
            if (stopped) return
            setOnline(true)
            setOfflineWhy(null)
            setDoc(function (prev) {
              if (next.version === prev.version && next.html === prev.html) return prev
              return next
            })
            // Announce a genuinely new save, but not the first poll of an
            // existing document — that is not news, it is just arrival.
            if (seenVersion >= 0 && next.version > seenVersion) {
              setFlash(true)
              clearTimeout(flashTimer)
              flashTimer = setTimeout(function () {
                if (!stopped) setFlash(false)
              }, 4000)
            }
            seenVersion = next.version
            setWorkingFrom(function (from) {
              return from !== null && next.version > from ? null : from
            })
            if (next.workspace && next.workspace !== seenWsPath) {
              seenWsPath = next.workspace
              setWs(null)
              fetchWorkspace(sessionId)
                .then(function (w) {
                  if (!stopped) setWs(w)
                })
                .catch(function () {
                  /* keep the previous listing */
                })
            }
          })
          .catch(function (error) {
            if (stopped) return
            setOnline(false)
            setOfflineWhy(offlineReason(error))
          })
      }
      pull()
      var timer = setInterval(pull, 2500)
      function onVisible() {
        if (document.visibilityState === 'visible') pull()
      }
      document.addEventListener('visibilitychange', onVisible)
      return function () {
        stopped = true
        clearInterval(timer)
        clearTimeout(flashTimer)
        document.removeEventListener('visibilitychange', onVisible)
      }
    },
    [active, sessionId],
  )

  if (!active) return null

  var btn = {
    border: '1px solid ' + pal.controlBorder,
    background: pal.controlBg,
    color: pal.textStrong,
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: '16px',
    padding: '3px 9px',
    borderRadius: 6,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  }

  // The preview toggle is always present: it is the one control that says
  // what Job mode is for, and hiding it whenever the pane happens to be open
  // left no way back from a preview that had scrolled out of reach.
  var toggle = createElement(
    'button',
    {
      type: 'button',
      onClick: function () {
        setOpen(!open)
      },
      title: open
        ? 'Hide the CV preview (chat returns to full width)'
        : 'Show the CV preview alongside the chat',
      style: open
        ? btn
        : Object.assign({}, btn, {
            background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
            borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
          }),
    },
    open ? 'Hide preview' : 'Show preview',
  )

  return createElement(
    FragmentOrNull,
    null,
    createElement(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '2px 2px 8px',
          fontSize: 12,
          color: pal.text,
          flexWrap: 'wrap',
        },
      },
      createElement(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: pal.dark ? '#7ab8ff' : '#2e6fdb',
          },
        },
        '◆ Job mode',
      ),
      createElement(
        'span',
        {
          title: doc.jobUrl || 'No job post link yet — fill in the start form in the preview',
          style: {
            maxWidth: 300,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        },
        doc.jobUrl || 'fill in the start form: job post link + your CV',
      ),
      createElement('span', { style: { flex: 1 } }),
      workingFrom !== null
        ? createElement(
            'span',
            {
              title: open
                ? 'The agent is working on your CV'
                : 'The agent is working on your CV — show the preview to watch it land',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 11,
                color: pal.accent,
              },
            },
            createElement(WorkingDots, { color: pal.accent, size: 5 }),
            open ? 'working' : 'working on your CV',
          )
        : null,
      !online
        ? createElement(
            'span',
            {
              title: offlineWhy || 'The plugin host is not answering — restart `dsh web`',
              style: { fontSize: 11, color: pal.dark ? '#ffb4a2' : '#b3261e' },
            },
            offlineWhy === null ? 'host unreachable' : 'preview stalled: ' + offlineWhy,
          )
        : null,
      doc.version > 0
        ? createElement(
            'span',
            {
              style: {
                fontSize: 11,
                color: flash ? pal.accent : pal.text,
                transition: 'color 200ms ease',
              },
            },
            flash ? 'CV v' + doc.version + ' · just updated' : 'CV v' + doc.version,
          )
        : null,
      toggle,
    ),
    // Workspace row: the candidacy folder and what is in it, once one exists.
    // The label reads as the candidacy (company — job title) when known,
    // falling back to the raw path; the tooltip always carries the path.
    ws && ws.path
      ? createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 2px 8px',
              fontSize: 11,
              color: pal.text,
              flexWrap: 'wrap',
            },
          },
          createElement(
            'span',
            {
              title: ws.path,
              style: {
                fontWeight: 600,
                color: pal.textStrong,
                maxWidth: 260,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            'Workspace: ' +
              (ws.company ? ws.company + (ws.jobTitle ? ' — ' + ws.jobTitle : '') : ws.path),
          ),
          (ws.files || []).length > 0
            ? createElement(
                'span',
                { style: { display: 'inline-flex', gap: 5, flexWrap: 'wrap' } },
                (ws.files || []).map(function (f) {
                  return createElement(
                    'span',
                    {
                      key: f.name,
                      title: f.name + ' · ' + f.size + ' bytes',
                      style: {
                        border: '1px solid ' + pal.controlBorder,
                        background: pal.panelBg,
                        borderRadius: 4,
                        padding: '1px 6px',
                        fontSize: 10,
                      },
                    },
                    f.name,
                  )
                }),
              )
            : createElement('span', {}, 'empty folder'),
        )
      : null,
    createElement(JobLayout, {
      active: active,
      open: open,
      doc: doc,
      online: online,
      flash: flash,
      // Standard-kit composer actions: how a comment on the CV reaches chat.
      inputActions: props.inputActions,
      sessionId: sessionId,
      fullScreen: fullScreen,
      draft: draft,
      working: workingFrom !== null,
      onWorkStarted: function () {
        setWorkingFrom(doc.version)
      },
      onToggleFullScreen: function () {
        setFullScreenState(!fullScreen)
      },
      onExitFullScreen: function () {
        setFullScreenState(false)
      },
      onClose: function () {
        setOpen(false)
      },
    }),
  )
}

// React.Fragment is not imported as a bare name in every shell build;
// a transparent wrapper keeps the dock a single slot child.
function FragmentOrNull(props) {
  return createElement(React.Fragment, null, props.children)
}


    // ------------------------- plugin wiring -------------------------
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      var options = { name: 'conversation.input.dock', id: 'dsh-job-cv-dock', order: 1 }
      var disposers = []
      disposers.push(slots.inject('conversation.input.dock', function () {
        return slots.register(options, JobDock)
      }))
      try {
        console.log('[dsh-job-cv] client mounted; job dock registered')
      } catch (e) { /* ignore */ }
      return function () {
        for (var i = 0; i < disposers.length; i++) {
          try { disposers[i]() } catch (e) { /* ignore */ }
        }
      }
    }

    exports.name = 'dsh-job-cv'
    exports.inject = ['slots']
    exports.apply = apply

    // Test surface: the pure helpers behind the annotate-and-comment flow.
    // Not part of the loader contract (name/inject/apply) — exported so the
    // message the agent actually receives can be asserted from node, without
    // a DOM or a browser.
    exports.__annotate = {
      buildRevisionMessage: buildRevisionMessage,
      deliverToComposer: deliverToComposer,
      deliveryNotice: deliveryNotice,
      pickableFrom: pickableFrom,
      nodePath: nodePath,
      sectionOf: sectionOf,
      noteFrom: noteFrom,
      visibleText: visibleText,
      squish: squish,
      clip: clip,
      COMMENT_PRESETS: COMMENT_PRESETS,
      buildLetterRequest: buildLetterRequest,
    }

    // Test surface for the onboarding start form: the pure helpers (the
    // component itself needs a DOM). Same idea as __annotate above.
    exports.__review = { buildDecisionMessage: buildDecisionMessage, pickedOption: pickedOption }

    exports.__diagnostics = { offlineReason: offlineReason }

    exports.__onboard = {
      buildStartMessage: buildStartMessage,
      intakeCv: intakeCv,
      upsertWorkspace: upsertWorkspace,
      readFileAsBase64: readFileAsBase64,
    }

    return module.exports
  },
})
