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
          if (parsed && typeof parsed === 'object') {
            return {
              open: parsed.open !== false,
              // The chat share the user dragged the divider to; null = the
              // computed share. Zero is how a reset is persisted.
              chatW:
                typeof parsed.chatW === 'number' && parsed.chatW > 0 ? parsed.chatW : null,
            }
          }
        }
      } catch (e) { /* fall through */ }
      // The empty-prefs fallback must carry the same shape as a stored one:
      // chatW missing meant undefined, and undefined is not null — the split
      // treated it as a dragged share and computed a NaN pane width.
      return { open: true, chatW: null }
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

    /**
     * Is this poll the same document as the last one?
     *
     * The poll discards a response that matches, so what this compares is
     * what the preview is able to notice. Version-and-html alone missed
     * everything that changes WITHOUT a save: a proposal (which lands with no
     * new version at all, and so did not open the review panel until some
     * later save happened to change the html), a cover letter, a fit score, a
     * job post. Each of those has its own version line or timestamp, and each
     * is compared here.
     */
    function sameDoc(a, b) {
      if (a.version !== b.version || a.html !== b.html) return false
      if (a.jobUrl !== b.jobUrl || a.workspace !== b.workspace) return false
      if (a.company !== b.company || a.jobTitle !== b.jobTitle) return false
      if (a.postChars !== b.postChars || a.postUpdatedAt !== b.postUpdatedAt) return false
      if (a.postHtmlUpdatedAt !== b.postHtmlUpdatedAt) return false
      if (a.briefUpdatedAt !== b.briefUpdatedAt) return false
      if (!a.fit !== !b.fit) return false
      if (a.fit && b.fit && (a.fit.updatedAt !== b.fit.updatedAt || a.fit.score !== b.fit.score))
        return false
      if (!a.letter !== !b.letter) return false
      if (a.letter && b.letter && a.letter.version !== b.letter.version) return false
      if (!a.proposal !== !b.proposal) return false
      if (a.proposal && b.proposal && a.proposal.id !== b.proposal.id) return false
      return true
    }

    /** One historical body, fetched only when the user asks to look at it. */
    function fetchVersion(sessionId, version, kind) {
      return fetch(
        '/jobcv/history?session=' +
          encodeURIComponent(sessionId) +
          '&version=' +
          String(version) +
          kindParam(kind),
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

    // URL the dock's file chips point at: open one candidacy file in its own
    // tab. `name` is the relative label the workspace listing returned.
    function fileUrl(sessionId, name) {
      return (
        '/jobcv/file?session=' + encodeURIComponent(sessionId) + '&name=' + encodeURIComponent(name)
      )
    }

    // The job post text. Deliberately its own request: it is thousands of
    // characters and the document poll runs every 2.5s, so /jobcv/doc carries
    // only a marker (postChars/postUpdatedAt) and the body is fetched when
    // the Post tab actually wants it.
    function fetchPost(sessionId) {
      return fetch('/jobcv/post?session=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }).then(function (res) {
        if (!res.ok) throw new Error('post fetch failed: ' + res.status)
        return res.json()
      })
    }

    // The structured brief of the posting. Same marker pattern as the post:
    // /jobcv/doc carries briefUpdatedAt only, and the body is fetched when
    // the Post tab wants it.
    function fetchBrief(sessionId) {
      return fetch('/jobcv/brief?session=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }).then(function (res) {
        if (!res.ok) throw new Error('brief fetch failed: ' + res.status)
        return res.json()
      })
    }

    // Store post text the user pasted. source:'you' so the panel can say the
    // requirements came from them and not from a scrape that may have missed.
    function savePost(sessionId, text) {
      return fetch('/jobcv/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, text: text, source: 'you' }),
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'post save failed')
          return body
        })
      })
    }

    /**
     * How long the working state must be VISIBLE, even when the thing asked
     * for lands immediately.
     *
     * The poll runs every 2.5s, and a fast agent can save inside one window:
     * without a floor, the loading flashes for less than a poll and reads as
     * "nothing happened". The floor keeps it on screen long enough to be seen
     * before the next poll clears it.
     */
    var WORKING_MIN_VISIBLE_MS = 3000

    /**
     * Is the working state over?
     *
     * The agent's work is bounded by the thing that was asked for landing:
     * a CV request ends when the CV saves, a letter request when the letter
     * does, a post request when the post text, page or brief moves, a fit
     * request when the score moves. Any OTHER marker advancing says nothing —
     * a save landing while a letter is being revised is not the letter.
     * Returns null when done, the snapshot itself while it is not.
     */
    function workingDone(from, next) {
      if (from === null) return null
      var landed = false
      if (from.target === 'cv') landed = next.version > from.version
      if (from.target === 'letter') landed = !!next.letter && next.letter.version > from.letterVersion
      if (from.target === 'post')
        landed =
          next.postUpdatedAt > from.postUpdatedAt ||
          next.postHtmlUpdatedAt > from.postHtmlUpdatedAt ||
          next.briefUpdatedAt > from.briefUpdatedAt
      if (from.target === 'fit') landed = !!next.fit && next.fit.updatedAt > from.fitUpdatedAt
      if (!landed) return from
      return Date.now() - (from.startedAt || 0) >= WORKING_MIN_VISIBLE_MS ? null : from
    }

    // The saved versions (newest first, bodies omitted) for the rollback UI.
    // kind:'letter' reads the cover letter's own timeline — it is a separate
    // document with its own version line, so it has separate history.
    function fetchHistory(sessionId, kind) {
      return fetch(
        '/jobcv/history?session=' + encodeURIComponent(sessionId) + kindParam(kind),
        { method: 'GET', headers: { 'content-type': 'application/json' } },
      ).then(function (res) {
        if (!res.ok) throw new Error('history fetch failed: ' + res.status)
        return res.json()
      })
    }

    /** '&kind=letter', or nothing at all for the CV. */
    function kindParam(kind) {
      return kind === 'letter' ? '&kind=letter' : ''
    }

    // Roll the document back to an earlier version; resolves to the new
    // version number.
    function restoreVersion(sessionId, version, kind) {
      return fetch('/jobcv/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          version: version,
          kind: kind === 'letter' ? 'letter' : 'cv',
        }),
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

// ------------------------- page deck -------------------------
// The preview should look like paper, not a scroll: when the document is
// laid out in .page divisions (the convention the contract mandates), each
// one is drawn as a separate A4 sheet on a desk, with the page break visible
// as the gap and shadow between them. A document without .page divisions
// gets the fallback: a boundary line every 297mm, so the break is still
// readable even though the sheets are not.
function pageDeckCss(hasPages, pal) {
  var desk = pal && pal.dark ? '#26282b' : '#e3e2df'
  var line = pal && pal.dark ? 'rgba(255,255,255,.10)' : '#d9d7d2'
  // Mobile browsers "boost" small text in wide documents to keep it readable
  // when the page is zoomed out — which re-wraps the CV (a summary that is 4
  // lines on desktop becomes 6 on a phone) and so breaks the A4 agreement
  // between preview and print. Pin the size: the document is already laid
  // out in mm, and the viewport must not rescale it.
  var textSizeFix = 'html{text-size-adjust:100%!important;-webkit-text-size-adjust:100%!important}'
  // The PRINT normalizer: a .page whose width or min-height counts its
  // padding twice is taller than the sheet, and the printed PDF breaks where
  // the preview never did. border-box makes 210mm mean the paper, not the
  // text column; body margins are zeroed so nothing overflows the A4 box.
  var printFix =
    '@media print{' +
    'html,body{margin:0!important;padding:0!important}' +
    '.page{box-sizing:border-box!important;width:210mm!important;' +
    'min-height:297mm!important;margin:0!important;background:#fff!important}' +
    '}'
  if (hasPages) {
    return (
      '@media screen{' +
      textSizeFix +
      'html{background:' +
      desk +
      '!important}' +
      'body{background:transparent!important}' +
      '.page{box-sizing:border-box!important;background:#fff!important;margin:0 auto 22px!important;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.16)!important;border-radius:2px;' +
      // The print boundary, drawn ON the sheet itself: content that spills
      // past the A4 edge crosses this line in the preview exactly where the
      // printed PDF would break, so the preview never shows one page and the
      // PDF two.
      'background-image:repeating-linear-gradient(to bottom,' +
      'transparent 0,transparent calc(297mm - 1px),' +
      line +
      ' calc(297mm - 1px),' +
      line +
      ' 297mm)!important}' +
      '}' +
      printFix
    )
  }
  return (
    '@media screen{' +
    textSizeFix +
    'body{background-image:repeating-linear-gradient(to bottom,' +
    'transparent 0,transparent calc(297mm - 2px),' +
    line +
    ' calc(297mm - 2px),' +
    line +
    ' 297mm)!important}' +
    '}' +
    printFix
  )
}

// The iframe swallows touch events (they anchor to the document the gesture
// started on), so a swipe between CV / letter / post has to be detected
// INSIDE the document and forwarded out. One handler at a time, set by the
// pane that owns the tabs; every deck iframe (CV, letter, post) calls
// attachSwipe, so the gesture works on whichever surface is showing.
var swipeHandler = null
function setSwipeHandler(handler) {
  swipeHandler = typeof handler === 'function' ? handler : null
}
function attachSwipe(doc) {
  try {
    if (!doc || !doc.body || doc.body.hasAttribute('data-dsh-job-cv-swipe')) return
    doc.body.setAttribute('data-dsh-job-cv-swipe', '')
    var start = null
    doc.addEventListener(
      'touchstart',
      function (e) {
        var t = e.touches && e.touches[0]
        start = t ? { x: t.clientX, y: t.clientY } : null
      },
      { passive: true },
    )
    function finish(e) {
      if (!start || !swipeHandler) return
      var t = e.changedTouches && e.changedTouches[0]
      var from = start
      start = null
      if (!t) return
      var dx = t.clientX - from.x
      var dy = t.clientY - from.y
      // Clearly horizontal and deliberate: a vertical scroll must never read
      // as a tab change.
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
      swipeHandler(dx < 0 ? 1 : -1)
    }
    doc.addEventListener('touchend', finish, { passive: true })
    doc.addEventListener('touchcancel', function () {
      start = null
    })
  } catch (e) {
    /* swipe is a nicety; the tabs still exist */
  }
}

/**
 * Paint the page deck into a document iframe. Same-origin, one style tag,
 * rewritten when the document changes under it. Call BEFORE measuring the
 * body height: the deck changes the layout the measurement reads.
 *
 * The agent is told not to script or frame anything, but the document is
 * agent-authored, so the deck also DEFENDS: scripts are removed (the
 * sandbox would block them anyway — this just silences the console), and
 * an embedded external page becomes a link, because LinkedIn and most
 * boards refuse to be framed and the blocked frame renders as a broken
 * box.
 */
function injectPageDeck(frame, pal) {
  try {
    var doc = frame && frame.contentDocument
    if (!doc || !doc.head) return
    var style = doc.getElementById('dsh-job-cv-pages')
    if (!style) {
      style = doc.createElement('style')
      style.id = 'dsh-job-cv-pages'
      doc.head.appendChild(style)
    }
    var pages = doc.querySelectorAll('.page').length > 0
    style.textContent = pageDeckCss(pages, pal)
    // Second defense against mobile font boosting — the text-size-adjust pin
    // in pageDeckCss is the first. Declaring a viewport stops the browser
    // treating the fixed-width A4 document as a zoomed-out desktop page, so
    // it never inflates the type and re-wraps the content. Leave an existing
    // one alone: the document may already say what it wants.
    if (!doc.querySelector('meta[name="viewport"]')) {
      var viewport = doc.createElement('meta')
      viewport.name = 'viewport'
      viewport.content = 'width=device-width, initial-scale=1'
      doc.head.insertBefore(viewport, doc.head.firstChild)
    }
    attachSwipe(doc)
    var scripts = doc.querySelectorAll('script')
    for (var si = 0; si < scripts.length; si++) {
      if (scripts[si].parentNode) scripts[si].parentNode.removeChild(scripts[si])
    }
    var frames = doc.querySelectorAll('iframe[src]')
    for (var fi = 0; fi < frames.length; fi++) {
      var src = frames[fi].getAttribute('src')
      if (!src) continue
      var a = doc.createElement('a')
      a.textContent = 'open the embedded page ↗'
      a.setAttribute('href', src)
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noreferrer noopener')
      a.setAttribute('data-dsh-job-cv-embedded', '')
      a.setAttribute(
        'style',
        'display:inline-block;padding:2px 8px;border:1px solid #2e6fdb;border-radius:4px;' +
          'color:#2e6fdb;font:11px system-ui,sans-serif;text-decoration:none',
      )
      if (frames[fi].parentNode) frames[fi].parentNode.replaceChild(a, frames[fi])
    }
    // Links open in a new tab from the PARENT. Same-frame navigation would
    // replace the preview with the linked page, and target="_blank" inside
    // the sandbox is blocked outright — so the parent intercepts and opens.
    // The exported PDF keeps the anchors as-is, and they are clickable there.
    if (doc.body && !doc.body.hasAttribute('data-dsh-job-cv-links')) {
      doc.body.setAttribute('data-dsh-job-cv-links', '')
      doc.addEventListener(
        'click',
        function (e) {
          // Comment mode owns every click while it is on; the annotate style
          // only exists then.
          if (doc.getElementById(ANNOTATE_STYLE_ID)) return
          var target = e.target
          var a = target && target.closest ? target.closest('a[href]') : null
          if (!a) return
          var href = a.getAttribute('href') || ''
          if (!/^https?:\/\//i.test(href)) return
          e.preventDefault()
          e.stopPropagation()
          try {
            window.open(href, '_blank', 'noopener')
          } catch (err) {
            /* leave the default */
          }
        },
        true,
      )
    }
  } catch (e) {
    /* the document still reads; the deck is decoration */
  }
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

// ------------------------- fit: the score and the gaps -------------------------
// "How close am I?" is the question the whole mode exists to answer, and a CV
// preview alone cannot answer it — the document says what you have, not what
// the post asked for. The agent scores the two against each other and POSTs
// the result; this renders it, and turns each gap into one message that asks
// for exactly that gap to be closed.
//
// The number is deliberately NOT computed here. Keyword overlap in the browser
// would always be available and quietly wrong: it cannot tell a requirement
// that is met from one that merely shares a word.

/** Score bands. Colour carries the verdict at a glance; the text carries it properly. */
function fitBand(score) {
  if (score >= 75) return { key: 'strong', light: '#1e7a3c', dark: '#7ddb9b', label: 'strong' }
  if (score >= 50) return { key: 'partial', light: '#8a5a00', dark: '#f0c274', label: 'partial' }
  return { key: 'thin', light: '#b3261e', dark: '#ffb4a2', label: 'thin' }
}

function fitColor(score, dark) {
  var band = fitBand(score)
  return dark ? band.dark : band.light
}

/** A fit is stale the moment the document it judged is no longer the one on screen. */
function fitStale(fit, doc) {
  if (!fit) return false
  var letterVersion = doc && doc.letter ? doc.letter.version : 0
  return fit.basedOnVersion !== doc.version || fit.basedOnLetter !== letterVersion
}

/** Ask the agent for a fresh assessment. */
function buildFitRequest(doc) {
  var lines = ['Score my fit for this job.', '']
  if (doc.jobUrl) lines.push('Job post: ' + doc.jobUrl)
  lines.push(
    'CV: v' + doc.version + (doc.letter ? ', cover letter v' + doc.letter.version : ''),
    '',
    'Read the stored post (GET /jobcv/post) and my CV as they stand, then POST the assessment to /jobcv/fit: the percentage, a one-line verdict of what actually decides this application, the gaps — each with a severity and the move that would close it — and the strengths with the line in my CV that evidences each one.',
    'Score the evidence against the requirements, not the vocabulary. Where closing a gap needs a fact you do not have, make the fix a question to me rather than a number you invented.',
  )
  return lines.join('\n')
}

/**
 * Ask for one gap — or the whole set — to be closed.
 *
 * The gaps arrive as the agent's own words, so they are quoted back rather
 * than paraphrased: it recognises its own assessment and works from the fix
 * it already decided on instead of re-deriving one.
 */
function buildGapMessage(gaps, doc) {
  var lines = []
  lines.push(
    gaps.length === 1
      ? 'Close this gap in my candidacy (CV v' + doc.version + '):'
      : 'Close these ' + gaps.length + ' gaps in my candidacy (CV v' + doc.version + '):',
  )
  lines.push('')
  for (var i = 0; i < gaps.length; i++) {
    var gap = gaps[i]
    lines.push(String(i + 1) + '. [' + gap.severity + '] ' + gap.requirement)
    if (squish(gap.why) !== '') lines.push('   Why it matters: ' + squish(gap.why))
    if (squish(gap.fix) !== '') lines.push('   Your move: ' + squish(gap.fix))
    lines.push('')
  }
  if (doc.jobUrl) lines.push('Job post: ' + doc.jobUrl)
  lines.push(
    'Do what the evidence actually supports: propose the wording changes that close these, ask me for any fact you need instead of writing one, and say plainly which of these cannot be closed by editing the CV at all. Re-POST /jobcv/fit once the document has moved.',
  )
  return lines.join('\n')
}

/** The score, the verdict, and what is missing — the panel behind the toolbar badge. */
function FitPanel(props) {
  var pal = props.pal
  var fit = props.fit
  var doc = props.doc
  var stale = fitStale(fit, doc)
  var color = fitColor(fit.score, pal.dark)

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
  var primaryBtn = Object.assign({}, btn, {
    background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
    borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
  })

  function chip(severity) {
    var tone =
      severity === 'blocker'
        ? pal.dark
          ? '#ffb4a2'
          : '#b3261e'
        : severity === 'major'
          ? pal.dark
            ? '#f0c274'
            : '#8a5a00'
          : pal.text
    return createElement(
      'span',
      {
        style: {
          border: '1px solid ' + tone,
          color: tone,
          borderRadius: 4,
          padding: '0 5px',
          fontSize: 10,
          lineHeight: '15px',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          flex: 'none',
        },
      },
      severity,
    )
  }

  var gaps = Array.isArray(fit.gaps) ? fit.gaps : []
  var strengths = Array.isArray(fit.strengths) ? fit.strengths : []

  return createElement(
    'div',
    {
      style: {
        flex: 'none',
        padding: '10px 12px 12px',
        borderBottom: '1px solid ' + pal.panelBorder,
        background: pal.panelBg,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxHeight: '58%',
        overflow: 'auto',
      },
    },
    // ---- score line ----
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
      createElement(
        'span',
        { style: { fontSize: 26, fontWeight: 700, color: color, lineHeight: '28px' } },
        String(fit.score) + '%',
      ),
      createElement(
        'span',
        { style: { fontSize: 12, color: pal.textStrong, flex: 1, minWidth: 160 } },
        fit.verdict || 'match against this job post',
      ),
      createElement(
        'button',
        { type: 'button', onClick: props.onRescore, style: btn, title: 'Ask for a fresh score' },
        'Re-score',
      ),
      createElement('button', { type: 'button', onClick: props.onClose, style: btn }, 'Close'),
    ),
    // A bar reads faster than a number, and makes two scores comparable.
    createElement(
      'div',
      {
        style: {
          height: 6,
          borderRadius: 3,
          background: pal.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)',
          overflow: 'hidden',
        },
      },
      createElement('div', {
        style: {
          width: Math.max(2, Math.min(100, fit.score)) + '%',
          height: '100%',
          background: color,
          transition: 'width 300ms ease',
        },
      }),
    ),
    createElement(
      'div',
      { style: { fontSize: 11, color: stale ? pal.accent : pal.text } },
      stale
        ? 'Scored against CV v' +
            fit.basedOnVersion +
            (fit.basedOnLetter ? ' + letter v' + fit.basedOnLetter : '') +
            ' — the document has moved since. Re-score to see where you are now.'
        : 'Scored against CV v' +
            fit.basedOnVersion +
            (fit.basedOnLetter ? ' + letter v' + fit.basedOnLetter : '') +
            ' · alignment with this post, not a probability of an offer',
    ),
    // ---- the gaps: what to close, in order of what it costs you ----
    gaps.length === 0
      ? createElement(
          'div',
          { style: { fontSize: 12, color: pal.text } },
          'No gaps recorded — ask for a re-score if that seems too kind.',
        )
      : createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            createElement(
              'span',
              { style: { fontSize: 11, fontWeight: 600, color: pal.textStrong } },
              'Missing — ' + gaps.length + (gaps.length === 1 ? ' gap' : ' gaps'),
            ),
            createElement('span', { style: { flex: 1 } }),
            createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  props.onAskGaps(gaps)
                },
                style: primaryBtn,
                title: 'Send every gap to the agent as one request',
              },
              gaps.length === 1 ? 'Ask to close it' : 'Ask to close all ' + gaps.length,
            ),
          ),
          gaps.map(function (gap, index) {
            return createElement(
              'div',
              {
                key: index,
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid ' + pal.controlBorder,
                  background: pal.dark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
                },
              },
              createElement(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                chip(gap.severity),
                createElement(
                  'span',
                  { style: { fontSize: 12, color: pal.textStrong, fontWeight: 600, flex: 1 } },
                  gap.requirement,
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: function () {
                      props.onAskGaps([gap])
                    },
                    style: btn,
                    title: 'Ask the agent to close this one',
                  },
                  'Close this',
                ),
              ),
              gap.why
                ? createElement('div', { style: { fontSize: 11, color: pal.text } }, gap.why)
                : null,
              gap.fix
                ? createElement(
                    'div',
                    { style: { fontSize: 11, color: pal.accent } },
                    '→ ' + gap.fix,
                  )
                : null,
            )
          }),
        ),
    // ---- what already lands, so the next edit does not undo it ----
    strengths.length > 0
      ? createElement(
          'details',
          { style: { fontSize: 11, color: pal.text } },
          createElement(
            'summary',
            { style: { cursor: 'pointer', color: pal.textStrong, fontWeight: 600 } },
            'What already lands (' + strengths.length + ')',
          ),
          createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 5 } },
            strengths.map(function (item, index) {
              return createElement(
                'div',
                { key: index },
                createElement(
                  'span',
                  { style: { color: pal.textStrong } },
                  '✓ ' + item.requirement,
                ),
                item.evidence ? createElement('span', null, ' — ' + item.evidence) : null,
              )
            }),
          ),
        )
      : null,
  )
}

/**
 * The job post itself, as a readable page in the preview.
 *
 * The post is the thing the CV is being written against, and it lived only in
 * the browser tab it was copied from — so checking a requirement meant leaving
 * the preview. It is stored per candidacy, shown here, and pasteable, which is
 * also the answer to a JavaScript-rendered board that curl comes back empty on.
 */
// The red treatment for requirements the CV does not evidence. Injected by
// the PARENT into the post iframe (it is same-origin), so the convention is
// enforced by the plugin rather than by whatever stylesheet the agent wrote:
// the agent marks <mark class="dsh-gap" data-dsh-gap="blocker|major|minor">,
// and the severity is expressed here, one place, consistently.
var POST_GAP_CSS = [
  '.dsh-gap{color:#b3261e!important;background:rgba(179,38,30,.08)!important;',
  'border-bottom:2px solid #b3261e!important;border-radius:2px;',
  'font-style:inherit;padding:0 1px}',
  '.dsh-gap[data-dsh-gap="blocker"]{background:rgba(179,38,30,.16)!important;font-weight:600}',
  '.dsh-gap[data-dsh-gap="minor"]{border-bottom:1px dashed #b3261e!important;',
  'background:rgba(179,38,30,.04)!important}',
].join('')

/** Paint the gap convention into the post document, once per load. */
function injectPostGapCss(frame) {
  try {
    var doc = frame && frame.contentDocument
    if (!doc || !doc.head) return
    if (doc.getElementById('dsh-job-cv-post-gap')) return
    var style = doc.createElement('style')
    style.id = 'dsh-job-cv-post-gap'
    style.textContent = POST_GAP_CSS
    doc.head.appendChild(style)
  } catch (e) {
    /* the marks stay unstyled; the document still reads */
  }
}

/** Ask the agent for the structured breakdown of the posting. */
function buildBriefRequest(doc) {
  return [
    'Break this job post down for me.',
    '',
    doc.jobUrl ? 'Job post: ' + doc.jobUrl : '',
    '',
    'Read the stored post (GET /jobcv/post), then research what the posting does not say and POST the brief to /jobcv/brief:',
    '  sections — "About the company" (what they do, history if it helps me), "The team" (only if the post or the company actually says something), "The job" (what I would own day to day), "Requirements" (what they ask for, in their words), "Expectations" (how success will be judged, if the post implies it), and any other section that helps me prepare. Each section carries a source: "posting", "company site", "LinkedIn", or "estimate" — and an estimate must say what would confirm it.',
    '  meta — location and remote policy, salary range if shown, when it was posted, how many have applied if the board says, the deadline if there is one. Only what you could actually verify: no invented numbers, no invented history.',
    '  the posting PAGE itself — POST /jobcv/post again with the same text plus the "html" field: the posting rendered as a self-contained styled HTML page (same rules as the CV document), the company logo embedded as a small data URI when you can fetch one, and every requirement my CV does not evidence wrapped in <mark class="dsh-gap" data-dsh-gap="blocker|major|minor" title="<what is missing>">…</mark> — the preview paints those red, so the marks must match the gaps you score in /jobcv/fit.',
    '',
    'If the post text is missing or thin, say so instead of inventing one.',
  ].join('\n')
}

/**
 * Ask the agent to fetch (or re-fetch) the posting.
 *
 * The browser cannot fetch a job board itself — most are cross-origin and
 * several need the shell's curl-and-strip pipeline — so this is a chat
 * request, like a fit score. The agent's answer POSTs the text, the poll
 * notices, and the tab updates on its own.
 */
function buildPostFetchRequest(doc) {
  return [
    'Fetch the job post for me.',
    '',
    doc.jobUrl ? 'Job post: ' + doc.jobUrl : '',
    '',
    'Read it with the shell — curl, strip the markup — and POST the readable text to /jobcv/post (it replaces what is stored). If the page comes back thin or renders through JavaScript, say so and ask me to paste the text instead. If the stored text changed, rebuild the breakdown too (POST /jobcv/brief) so the preview shows the latest.',
  ]
    .filter(function (line, i, all) {
      return line !== '' || (i > 0 && all[i - 1] !== '')
    })
    .join('\n')
}

/**
 * The job post, as a candidate actually wants to read it.
 *
 * The raw text is kept — it is the source of truth and the paste box is the
 * way a JavaScript-rendered board gets its requirements in — but the lead is
 * the brief the agent built: the company, the team, the job, the requirements
 * and the practical facts a posting buries in its third paragraph. A posting
 * with no brief yet still reads, and asks for one.
 */
function PostSurface(props) {
  var pal = props.pal
  var post = props.post
  var brief = props.brief
  var doc = props.doc
  var editingState = React.useState(false)
  var editing = editingState[0]
  var setEditing = editingState[1]
  var draftState = React.useState('')
  var draft = draftState[0]
  var setDraft = draftState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var errorState = React.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var postFrameRef = React.useRef(null)
  // The same scaled-sheet machinery as the CV: the container width drives
  // the factor, the measured page height drives the wrapper height.
  var postSurfaceRef = React.useRef(null)
  var postScale = useSheetScale(postSurfaceRef)
  var postFrameHState = React.useState(1123)
  var postFrameH = postFrameHState[0]
  var setPostFrameH = postFrameHState[1]

  var text = post && typeof post.text === 'string' ? post.text : ''
  var page = post && typeof post.html === 'string' && post.html !== '' ? post.html : ''
  var empty = squish(text) === ''
  var sections = brief && Array.isArray(brief.sections) ? brief.sections : []
  var meta = brief && Array.isArray(brief.meta) ? brief.meta : []
  // The post moved after the brief was built: the breakdown describes an
  // older text, which is worth saying rather than silently showing.
  var stale =
    brief !== null &&
    brief !== undefined &&
    doc.postUpdatedAt > 0 &&
    brief.updatedAt > 0 &&
    doc.postUpdatedAt > brief.updatedAt

  var btn = {
    border: '1px solid ' + pal.controlBorder,
    background: pal.controlBg,
    color: pal.textStrong,
    cursor: 'pointer',
    fontSize: 11,
    lineHeight: '15px',
    padding: '3px 9px',
    borderRadius: 6,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  }
  var primaryBtn = Object.assign({}, btn, {
    background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
    borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
  })

  function submit() {
    if (squish(draft) === '' || busy) return
    setBusy(true)
    setError(null)
    savePost(props.sessionId, draft)
      .then(function () {
        setBusy(false)
        setEditing(false)
        props.onSaved()
      })
      .catch(function (err) {
        setBusy(false)
        setError(String(err && err.message ? err.message : err))
      })
  }

  var editor = createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 7, width: '100%' } },
    createElement('textarea', {
      value: draft,
      autoFocus: true,
      placeholder:
        'Paste the job post text here — everything: responsibilities, requirements, the nice-to-haves.',
      onChange: function (e) {
        setDraft(e.target.value)
      },
      style: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 220,
        resize: 'vertical',
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid ' + pal.controlBorder,
        background: pal.dark ? 'rgba(0,0,0,0.25)' : '#fff',
        color: pal.textStrong,
      },
    }),
    createElement(
      'div',
      { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      createElement(
        'button',
        { type: 'button', onClick: submit, style: primaryBtn, disabled: busy },
        busy ? 'Saving…' : 'Save the post',
      ),
      createElement(
        'button',
        {
          type: 'button',
          style: btn,
          onClick: function () {
            setEditing(false)
            setError(null)
          },
        },
        'Cancel',
      ),
      error
        ? createElement(
            'span',
            { style: { fontSize: 11, color: pal.dark ? '#ffb4a2' : '#b3261e' } },
            error,
          )
        : null,
    ),
  )

  return createElement(
    'div',
    {
      ref: postSurfaceRef,
      style: {
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        display: 'flex',
        justifyContent: 'center',
        padding: '14px 10px',
      },
    },
    createElement(
      'div',
      {
        style: {
          width: '100%',
          maxWidth: 760,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        },
      },
      // ---- the agent is on it: the loading lives HERE, nowhere else ----
      props.working
        ? createElement(
            'div',
            {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                alignSelf: 'center',
                fontSize: 11,
                color: pal.accent,
                border: '1px solid ' + pal.controlBorder,
                background: pal.panelBg,
                borderRadius: 999,
                padding: '5px 12px',
              },
            },
            createElement(WorkingDots, { color: pal.accent, size: 5 }),
            'Working on the posting…',
          )
        : null,
      // ---- where this came from ----
      createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            flexWrap: 'wrap',
            fontSize: 11,
            color: pal.text,
            borderBottom: '1px solid ' + pal.panelBorder,
            paddingBottom: 8,
          },
        },
        createElement(
          'span',
          { style: { fontSize: 13, fontWeight: 600, color: pal.textStrong } },
          doc.company
            ? doc.company + (doc.jobTitle ? ' — ' + doc.jobTitle : '')
            : doc.jobTitle || 'The job post',
        ),
        doc.jobUrl
          ? createElement(
              'a',
              {
                href: doc.jobUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
                style: { color: pal.accent, textDecoration: 'none' },
                title: doc.jobUrl,
              },
              'open the posting ↗',
            )
          : null,
        createElement('span', { style: { flex: 1 } }),
        empty
          ? null
          : createElement(
              'span',
              null,
              (post.source === 'you' ? 'pasted by you' : 'fetched by the agent') +
                ' · ' +
                text.length +
                ' chars',
            ),
        !editing && !empty
          ? createElement(
              'span',
              { style: { display: 'inline-flex', gap: 6 } },
              createElement(
                'button',
                {
                  type: 'button',
                  style: btn,
                  onClick: function () {
                    setDraft(text)
                    setEditing(true)
                  },
                  title: 'Replace this with the full text',
                },
                'Replace',
              ),
              doc.jobUrl
                ? createElement(
                    'button',
                    {
                      type: 'button',
                      style: btn,
                      onClick: props.onAskFetch,
                      title:
                        'Ask the agent to re-fetch the posting from the link — postings get edited,' +
                        ' requirements change, applicant counts move',
                    },
                    'Refresh',
                  )
                : null,
            )
          : null,
      ),
      // ---- the practical facts, up front where a candidate looks first ----
      meta.length > 0
        ? createElement(
            'div',
            {
              style: {
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                alignItems: 'stretch',
              },
            },
            meta.map(function (m, index) {
              return createElement(
                'div',
                {
                  key: index,
                  style: {
                    border: '1px solid ' + pal.controlBorder,
                    background: pal.dark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
                    borderRadius: 6,
                    padding: '4px 9px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                    minWidth: 90,
                  },
                },
                createElement(
                  'span',
                  {
                    style: {
                      fontSize: 9,
                      lineHeight: '12px',
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      color: pal.text,
                    },
                  },
                  m.label,
                ),
                createElement('span', { style: { fontSize: 12, color: pal.textStrong } }, m.value),
              )
            }),
          )
        : null,
      // ---- the posting page itself: A4-styled, the gaps painted red ----
      !editing && page !== ''
        ? createElement(
            'div',
            {
              style: {
                position: 'relative',
                flex: 'none',
                margin: '0 auto',
                width: Math.round(SHEET_W * postScale) + 'px',
                height: Math.round((postFrameH + 2) * postScale) + 'px',
              },
            },
            createElement('iframe', {
              key: post.htmlUpdatedAt || post.updatedAt,
              ref: postFrameRef,
              srcDoc: page,
              title: 'Job post',
              sandbox: 'allow-same-origin allow-modals',
              onLoad: function () {
                // The red convention is painted by the PARENT, not by whatever
                // stylesheet the agent wrote — one place, one definition. The
                // page deck comes before the height measurement, same as the CV.
                injectPostGapCss(postFrameRef.current)
                injectPageDeck(postFrameRef.current, pal)
                try {
                  var frame = postFrameRef.current
                  var body = frame && frame.contentDocument && frame.contentDocument.body
                  if (frame && body) setPostFrameH(Math.max(body.scrollHeight, 1123))
                } catch (e) {
                  /* keep the floor */
                }
              },
              style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '210mm',
                height: postFrameH + 'px',
                background: '#fff',
                border: '1px solid ' + pal.panelBorder,
                borderRadius: 3,
                boxShadow: pal.dark ? '0 2px 14px rgba(0,0,0,0.45)' : '0 2px 14px rgba(0,0,0,0.13)',
                transform: 'scale(' + postScale + ')',
                transformOrigin: 'top left',
              },
            }),
          )
        : null,
      // ---- the brief, built by the agent: the posting in sections ----
      // (it steps aside for the page, which is the same information, better)
      page !== ''
        ? null
        : sections.map(function (section, index) {
            return createElement(
              'div',
              {
                key: index,
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '9px 11px',
                  borderRadius: 8,
                  border: '1px solid ' + pal.panelBorder,
                  background: pal.dark ? 'rgba(255,255,255,0.02)' : '#fff',
                },
              },
              createElement(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: 7 } },
                createElement(
                  'span',
                  { style: { fontSize: 13, fontWeight: 600, color: pal.textStrong, flex: 1 } },
                  section.title,
                ),
                section.source
                  ? createElement(
                      'span',
                      {
                        title: 'Where this came from',
                        style: {
                          fontSize: 9,
                          lineHeight: '14px',
                          letterSpacing: 0.4,
                          textTransform: 'uppercase',
                          color: pal.text,
                          border: '1px solid ' + pal.controlBorder,
                          borderRadius: 4,
                          padding: '0 5px',
                          flex: 'none',
                        },
                      },
                      section.source,
                    )
                  : null,
              ),
              createElement(
                'div',
                {
                  style: {
                    whiteSpace: 'pre-wrap',
                    fontSize: 12.5,
                    lineHeight: '19px',
                    color: pal.textStrong,
                    wordBreak: 'break-word',
                  },
                },
                section.body,
              ),
            )
          }),
      // ---- no brief yet: the raw text reads, and the button asks for better ----
      !editing && !empty && sections.length === 0 && page === ''
        ? createElement(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '9px 11px',
                borderRadius: 8,
                border: '1px dashed ' + pal.controlBorder,
              },
            },
            createElement(
              'div',
              { style: { fontSize: 12, color: pal.text, lineHeight: '18px' } },
              props.briefLoading
                ? 'Building the breakdown…'
                : 'This posting is still raw text. The agent can break it into what you' +
                    ' actually need — the company, the team, the job, the requirements, and the' +
                    ' practical facts (posted when, how many applied, salary if it is shown).',
            ),
            props.briefLoading
              ? null
              : createElement(
                  'button',
                  {
                    type: 'button',
                    style: primaryBtn,
                    onClick: props.onAskBrief,
                    title: 'Ask the agent to research and build the breakdown',
                  },
                  'Break this down for me',
                ),
          )
        : null,
      stale
        ? createElement(
            'div',
            { style: { fontSize: 11, color: pal.accent } },
            'The stored post has changed since this breakdown was built — ask for a fresh one.',
          )
        : null,
      // ---- the posting itself, always reachable ----
      editing
        ? editor
        : empty
          ? createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
              createElement(
                'div',
                { style: { fontSize: 12, color: pal.text, lineHeight: '18px' } },
                props.loading
                  ? 'Looking for the post…'
                  : 'No post text saved yet. The agent stores what it fetches here — and many' +
                      ' boards render through JavaScript and come back empty, which is what pasting' +
                      ' is for. Everything else in this mode is written against this text.',
              ),
              props.loading
                ? null
                : createElement(
                    'div',
                    { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                    doc.jobUrl
                      ? createElement(
                          'button',
                          {
                            type: 'button',
                            style: primaryBtn,
                            onClick: props.onAskFetch,
                            title: 'Ask the agent to fetch the posting and store it here',
                          },
                          'Fetch the post for me',
                        )
                      : null,
                    createElement(
                      'button',
                      {
                        type: 'button',
                        style: primaryBtn,
                        onClick: function () {
                          setDraft('')
                          setEditing(true)
                        },
                      },
                      'Paste the post text',
                    ),
                  ),
            )
          : sections.length === 0 && page === ''
            ? createElement(
                'div',
                {
                  style: {
                    whiteSpace: 'pre-wrap',
                    fontSize: 13,
                    lineHeight: '20px',
                    color: pal.textStrong,
                    wordBreak: 'break-word',
                  },
                },
                text,
              )
            : createElement(
                'details',
                {
                  style: { fontSize: 11, color: pal.text },
                },
                createElement(
                  'summary',
                  {
                    style: { cursor: 'pointer', color: pal.textStrong, fontWeight: 600 },
                  },
                  'Full text of the posting (' + text.length + ' chars)',
                ),
                createElement(
                  'div',
                  {
                    style: {
                      whiteSpace: 'pre-wrap',
                      fontSize: 12.5,
                      lineHeight: '19px',
                      color: pal.textStrong,
                      wordBreak: 'break-word',
                      paddingTop: 6,
                    },
                  },
                  text,
                ),
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

// The printed sheet at 96dpi: 210mm plus its two 1px borders. The scale
// factor divides the PANE into this — below a full sheet, the document
// shrinks as a whole instead of reflowing, so the preview stays exactly the
// layout the PDF prints, just smaller.
var SHEET_W = (210 * 96) / 25.4 + 2

/**
 * Fit the sheet to its container: 1 while the pane is wide enough, and a
 * scale factor below 1 when it is not. Scaling, not reflow — the document
 * still lays out at 210mm internally, so preview and print keep agreeing.
 */
function useSheetScale(containerRef) {
  var state = React.useState(1)
  var scale = state[0]
  var setScale = state[1]
  React.useEffect(
    function () {
      var ro = null
      var host = null
      var recheck = null
      // The width the sheet must fit into. On a phone the LAYOUT viewport
      // (what a fixed overlay spans) can be wider than what is actually
      // visible — no/odd viewport meta, or a pinch-zoom in — so the sheet
      // has to fit the VISIBLE screen width, or it renders at full A4 width
      // and spills off the right edge. visualViewport is the honest number.
      function visibleWidth(el) {
        var w = el.clientWidth
        var vv =
          typeof window !== 'undefined' && window.visualViewport && window.visualViewport.width
        if (vv) {
          // Prefer the visible screen when the box is not yet measurable, or
          // wider than it (layout viewport > visual viewport on a phone).
          w = w > 0 ? Math.min(w, vv) : vv
        }
        return w
      }
      function measure() {
        // The ref is read FRESH every time: the pane mounts through a portal
        // a beat after this effect, and an element captured early would be
        // the wrong one forever.
        var el = containerRef.current
        if (!el) return
        // clientWidth excludes the scrollbar; the container padding is the
        // breathing room around the sheet.
        var avail = visibleWidth(el) - 22
        setScale(avail > 0 ? Math.min(1, avail / SHEET_W) : 1)
      }
      function bind() {
        var el = containerRef.current
        if (!el) return false
        measure()
        window.addEventListener('resize', measure)
        // Mobile rotation, pinch-zoom and the browser chrome showing/hiding
        // resize the VISUAL viewport without resizing the window — follow it
        // so the sheet re-scales instead of going stale.
        if (typeof window !== 'undefined' && window.visualViewport) {
          window.visualViewport.addEventListener('resize', measure)
        }
        if (typeof ResizeObserver === 'undefined') return true
        ro = new ResizeObserver(measure)
        ro.observe(el)
        // The pane host is the element the divider actually resizes; it is a
        // stable DOM node that survives React re-renders, so observing it as
        // well makes the scale follow the drag deterministically.
        host = el.closest && el.closest('[data-dsh-job-cv-pane]')
        if (host) ro.observe(host)
        return true
      }
      // The container may not exist yet at effect time — retry briefly.
      var bound = bind()
      if (!bound) {
        var retry = setInterval(function () {
          if (bind()) clearInterval(retry)
        }, 200)
        var stopRetry = function () {
          clearInterval(retry)
        }
      }
      // If the split rebuilds the pane host, the observed node is replaced;
      // a cheap periodic re-bind follows it.
      recheck = setInterval(function () {
        var el = containerRef.current
        if (!el || ro === null) return
        var currentHost = el.closest && el.closest('[data-dsh-job-cv-pane]')
        if (currentHost && currentHost !== host) {
          host = currentHost
          ro.observe(host)
        }
      }, 1000)
      return function () {
        if (stopRetry) stopRetry()
        clearInterval(recheck)
        window.removeEventListener('resize', measure)
        if (typeof window !== 'undefined' && window.visualViewport) {
          window.visualViewport.removeEventListener('resize', measure)
        }
        if (ro !== null) ro.disconnect()
      }
    },
    [containerRef],
  )
  return scale
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

// ---- what the exported PDF is called -------------------------------------
// "Save as PDF" takes its default filename from the printed document's title,
// so the title is set to the name we want just before print(). One
// convention for both documents — Firstname_Lastname_CV_Job_Company.pdf and
// Firstname_Lastname_Cover_Letter_Job_Company.pdf — so a candidacy's two
// files sort together in the downloads folder, and a recruiter reading only
// the attachment name still knows who applied and for what.

/** A title of "CV" is the template's, not the candidate's. */
var GENERIC_TITLE = /^(cv|resum[eé]|curriculum vitae|cover letter|letter|document|untitled)$/i

/**
 * The candidate's name as the document itself states it: its first <h1>,
 * which both the CV and the letter carry as the header (one personal brand).
 * Falls back to <title>, unless that is the generic template title.
 */
function candidateNameFrom(html) {
  var s = String(html === undefined || html === null ? '' : html)
  var m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(s)
  var raw = m ? m[1] : ''
  if (squish(stripTags(raw)) === '') {
    var t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)
    raw = t ? t[1] : ''
  }
  var name = squish(stripTags(raw))
  return GENERIC_TITLE.test(name) ? '' : name
}

/** Markup out, entities that matter decoded, so an &amp; is not "amp". */
function stripTags(html) {
  return String(html === undefined || html === null ? '' : html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&(?:lt|gt|quot|#39|apos|middot|ndash|mdash);/gi, ' ')
}

/**
 * One filename segment: accents folded to ASCII (a downloads folder is a
 * worse place for encoding surprises than a CV is), everything that is not a
 * letter or a digit collapsed to a single underscore.
 */
function fileSlug(part, max) {
  var s = String(part === undefined || part === null ? '' : part)
  try {
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  } catch (e) {
    /* an engine without NFD normalization just keeps the original letters */
  }
  return s
    .replace(/['\u2018\u2019]/g, '') // O'Brien reads better than O_Brien
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max || 48)
    .replace(/_+$/, '')
}

/**
 * Firstname_Lastname_CV_Job_Company — with whatever is not known yet simply
 * left out, so an unnamed candidacy exports as "Jane_Doe_CV" rather than
 * carrying empty gaps.
 */
function exportFileName(parts) {
  var p = parts || {}
  var kind = p.kind === 'letter' ? 'Cover_Letter' : 'CV'
  var segs = [fileSlug(p.name), kind, fileSlug(p.jobTitle), fileSlug(p.company)]
  var out = []
  for (var i = 0; i < segs.length; i++) {
    if (segs[i] !== '') out.push(segs[i])
  }
  // Long job titles plus a long company can outrun a filesystem's name limit;
  // the tail is what gets cut, so the name and the kind always survive.
  return out.join('_').slice(0, 150).replace(/_+$/, '')
}

function CvPane(props) {
  useThemeTick()
  var pal = palette()
  var doc = props.doc
  var iframeRef = React.useRef(null)
  // A historical version being LOOKED AT. Declared before anything derives
  // from it: `var` hoists, so reading it above this line yields undefined —
  // and `undefined !== null` is true, which previously made the pane believe
  // it was showing a version it did not have and crash on its html.
  var lookingState = React.useState(null)
  var looking = lookingState[0]
  var setLooking = lookingState[1]

  // Which surface is on screen: the CV, the cover letter (a second document
  // with its own version line and its own file), or the job post itself.
  var viewState = React.useState('cv')
  var rawView = viewState[0]
  var setView = viewState[1]
  // A view whose subject no longer exists falls back to the CV rather than
  // rendering a tab into nothing.
  var view = rawView === 'letter' && !doc.letter ? 'cv' : rawView
  var showingLetter = view === 'letter' && doc.letter
  var showingPost = view === 'post'
  // A one-time hint that the surface can be swiped between views on touch
  // devices; dismissed on the first switch (swipe or tab click).
  var swipeHintState = React.useState(true)
  var swipeHint = swipeHintState[0]
  var setSwipeHint = swipeHintState[1]

  // The post body is fetched on demand: /jobcv/doc is polled every 2.5s and
  // carries only a marker for it (postChars/postUpdatedAt).
  var postState = React.useState(null)
  var post = postState[0]
  var setPost = postState[1]
  var postLoadingState = React.useState(false)
  var postLoading = postLoadingState[0]
  var setPostLoading = postLoadingState[1]
  // Bumped after a paste, so the fetch below re-runs against what was saved.
  var postTickState = React.useState(0)
  var postTick = postTickState[0]
  var bumpPostTick = postTickState[1]
  // The structured brief of the posting, fetched beside the raw text.
  var briefState = React.useState(null)
  var brief = briefState[0]
  var setBrief = briefState[1]
  var briefLoadingState = React.useState(false)
  var briefLoading = briefLoadingState[0]
  var setBriefLoading = briefLoadingState[1]

  // The tabs that exist right now. The post earns one as soon as there is
  // text to show or a posting to paste in from.
  var views = ['cv']
  if (doc.letter) views.push('letter')
  if (doc.postChars > 0 || doc.jobUrl) views.push('post')

  // ---- fit: the score and the gaps ----
  var fitOpenState = React.useState(false)
  var fitOpen = fitOpenState[0]
  var setFitOpen = fitOpenState[1]
  // Truthiness, not a null test: only an actual {version, html} shows one.
  // An old version is only "on screen" while the tab it belongs to is: the CV
  // and the letter each count from v1, so a letter draft shown under the CV
  // tab would be a different document wearing the same number.
  var showingOld =
    !!(looking && looking.html) &&
    !showingPost &&
    looking.kind === (showingLetter ? 'letter' : 'cv')
  var starter = doc.version === 0 && !showingLetter && !showingOld
  var html = showingOld
    ? looking.html
    : showingLetter
      ? doc.letter.html
      : starter
        ? starterDoc()
        : doc.html
  // What a comment is ABOUT. The letter is a second document with its own
  // version line and its own route, and an old version being looked at is not
  // the live one — a mark that cites neither reads as a mark on the current CV.
  var commentTarget = showingLetter ? 'letter' : 'cv'
  var commentWhat = showingLetter ? 'cover letter' : 'CV'
  // The live version of the document on screen — what History lists against,
  // what a restore lands on top of, and what a mark cites when it is current.
  var liveVersion = showingLetter ? doc.letter.version : doc.version
  var commentVersion = showingOld ? looking.version : liveVersion
  var working = props.working === null || props.working === undefined ? null : props.working
  // The loading shows only on the surface that was asked for: a letter
  // request does not dim the CV, a post request does not dim anything that
  // prints, and a comment batch dims exactly the parts that were marked.
  var workingHere =
    working !== null &&
    (showingPost
      ? working.target === 'post'
      : showingLetter
        ? working.target === 'letter'
        : working.target === 'cv')
  var workingParts = workingHere && Array.isArray(working.anchors) && working.anchors.length > 0
  var workingWholeDoc =
    workingHere && !workingParts && (working.target === 'cv' || working.target === 'letter')
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
  // The elements of a dragged range, so Add marks them all as noted.
  var pickedElsRef = React.useRef(null)
  // The scaled-sheet machinery: the container width drives the factor, and
  // the measured document height drives the wrapper's height.
  var surfaceRef = React.useRef(null)
  var scale = useSheetScale(surfaceRef)
  var frameHState = React.useState(1123)
  var frameH = frameHState[0]
  var setFrameH = frameHState[1]
  // Measure the FULL document, not just the body: documentElement grows past
  // the body when the last page's bottom margin collapses, and body is the
  // one that grows when the agent put everything in body. Take whichever is
  // taller, floored at one A4 page, so a multi-page CV is never clipped to
  // the first sheet.
  function measureFrame() {
    try {
      var frame = iframeRef.current
      var idoc = frame && frame.contentDocument
      if (!idoc) return
      var height = Math.max(
        (idoc.documentElement && idoc.documentElement.scrollHeight) || 0,
        (idoc.body && idoc.body.scrollHeight) || 0,
        1123,
      )
      setFrameH(height)
    } catch (e) {
      /* keep the floor */
    }
  }

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
  function lookAt(version) {
    if (version === liveVersion) {
      setLooking(null)
      return
    }
    setRestoreStatus(null)
    fetchVersion(props.sessionId, version, commentTarget)
      .then(function (body) {
        // Tagged with the document it came off: the two timelines both count
        // from v1, and a letter body rendered as the CV is just wrong.
        setLooking({ version: version, html: body.html, kind: commentTarget })
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
      fetchHistory(props.sessionId, commentTarget)
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
    var kind = looking && looking.kind ? looking.kind : commentTarget
    setRestoreBusy(true)
    setRestoreStatus('restoring v' + version + '…')
    restoreVersion(props.sessionId, version, kind)
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

      // The picked part(s) stay boxed in the preview while the comment is
      // being written — without this the panel quotes text and the document
      // shows nothing, and the user cannot see what they are commenting on.
      function clearPickedPaint() {
        var old = []
        if (pickedElsRef.current) old = pickedElsRef.current.slice()
        else if (pickedElRef.current) old = [pickedElRef.current]
        for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-jobcv-picked')
      }
      function paintPicked(els) {
        for (var i = 0; i < els.length; i++) els[i].setAttribute('data-jobcv-picked', '')
      }

      // Click marks ONE part; dragging across parts grows the selection into
      // a range — everything the pointer touches joins the note, and the note
      // quotes each part separately so the agent can find all of them.
      var hot = []
      var dragItems = []
      var dragging = false
      function clearHot() {
        for (var i = 0; i < hot.length; i++) hot[i].removeAttribute('data-jobcv-hot')
        hot = []
      }
      function paintHot(el) {
        if (hot.indexOf(el) !== -1) return
        el.setAttribute('data-jobcv-hot', '')
        hot.push(el)
      }
      function onMove(e) {
        var el = pickableFrom(e.target, root)
        if (!el) return
        if (dragging) {
          paintHot(el)
          if (dragItems.indexOf(el) === -1) dragItems.push(el)
          return
        }
        clearHot()
        paintHot(el)
      }
      function onDown(e) {
        var el = pickableFrom(e.target, root)
        if (!el) return
        // Comment mode owns the pointer: no link navigates, and no native
        // text selection starts, under it.
        e.preventDefault()
        e.stopPropagation()
        dragging = true
        dragItems = [el]
        paintHot(el)
      }
      function finishDrag() {
        if (!dragging) return
        dragging = false
        // Document order, not the order the pointer happened to touch them.
        if (dragItems.length > 1 && typeof dragItems[0].compareDocumentPosition === 'function') {
          dragItems.sort(function (a, b) {
            return a.compareDocumentPosition(b) & 2 ? 1 : -1
          })
        }
        clearPickedPaint()
        if (dragItems.length === 1) {
          pickedElRef.current = dragItems[0]
          pickedElsRef.current = null
          setPicked(noteFrom(dragItems[0], root, commentVersion))
          paintPicked([dragItems[0]])
        } else {
          pickedElRef.current = null
          pickedElsRef.current = dragItems
          setPicked(rangeNoteFrom(dragItems, root, commentVersion))
          paintPicked(dragItems)
        }
        dragItems = []
        setSent(null)
      }
      function onUp() {
        finishDrag()
      }
      root.addEventListener('mousemove', onMove, true)
      root.addEventListener('mouseleave', clearHot, true)
      root.addEventListener('mousedown', onDown, true)
      // Releasing outside the body still finalizes; leaving the body ends the
      // hover paint but keeps the drag until the release.
      idoc.addEventListener('mouseup', onUp, true)
      return function () {
        clearHot()
        root.removeEventListener('mousemove', onMove, true)
        root.removeEventListener('mouseleave', clearHot, true)
        root.removeEventListener('mousedown', onDown, true)
        idoc.removeEventListener('mouseup', onUp, true)
        if (style && style.parentNode) style.parentNode.removeChild(style)
        var marked = root.querySelectorAll('[data-jobcv-noted]')
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-jobcv-noted')
        var picked = root.querySelectorAll('[data-jobcv-picked]')
        for (var j = 0; j < picked.length; j++) picked[j].removeAttribute('data-jobcv-picked')
      }
    },
    [annotating, loadTick, commentVersion],
  )

  // Everything queued, including a note still being typed.
  function collectNotes() {
    var pending =
      picked && squish(draft) !== '' ? [Object.assign({}, picked, { comment: draft })] : []
    return notes.concat(pending)
  }

  function addNote() {
    if (!picked || squish(draft) === '') return
    if (pickedElsRef.current) {
      for (var i = 0; i < pickedElsRef.current.length; i++) {
        pickedElsRef.current[i].setAttribute('data-jobcv-noted', '')
        pickedElsRef.current[i].removeAttribute('data-jobcv-picked')
      }
    } else if (pickedElRef.current) {
      pickedElRef.current.setAttribute('data-jobcv-noted', '')
      pickedElRef.current.removeAttribute('data-jobcv-picked')
    }
    setNotes(notes.concat([Object.assign({}, picked, { comment: draft })]))
    setPicked(null)
    setDraft('')
    pickedElRef.current = null
    pickedElsRef.current = null
  }

  function sendNotes() {
    var batch = collectNotes()
    if (batch.length === 0) return
    // The LIVE version of that document, not commentVersion: each note already
    // carries the version it was marked on, and the difference between the two
    // is exactly what prints "marked on v3, before your latest save".
    var message = buildRevisionMessage(batch, {
      target: commentTarget,
      version: showingLetter ? doc.letter.version : doc.version,
      jobUrl: doc.jobUrl,
    })
    var via = deliverToComposer(props.inputActions, message, props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({
        target: commentTarget,
        anchors: anchorPathsFor(batch),
      })
    if (via !== null) {
      if (pickedElsRef.current) {
        for (var i = 0; i < pickedElsRef.current.length; i++) {
          pickedElsRef.current[i].removeAttribute('data-jobcv-picked')
        }
      } else if (pickedElRef.current) {
        pickedElRef.current.removeAttribute('data-jobcv-picked')
      }
      setNotes([])
      setPicked(null)
      setDraft('')
      pickedElRef.current = null
      pickedElsRef.current = null
      setAnnotating(false)
    }
  }

  // The post body: fetched when the Post tab is opened, and re-fetched when
  // the document poll reports a newer one (the agent re-storing what it
  // fetched, or another window pasting it). Never on the poll interval —
  // this is thousands of characters.
  React.useEffect(
    function () {
      if (!showingPost) return undefined
      var stopped = false
      setPostLoading(true)
      fetchPost(props.sessionId)
        .then(function (body) {
          if (stopped) return
          setPostLoading(false)
          setPost(
            body && typeof body.text === 'string' && body.text !== ''
              ? {
                  text: body.text,
                  source: body.source,
                  updatedAt: body.updatedAt,
                  html: typeof body.html === 'string' ? body.html : '',
                  htmlUpdatedAt: body.htmlUpdatedAt || 0,
                }
              : null,
          )
        })
        .catch(function () {
          if (stopped) return
          setPostLoading(false)
          // Keep whatever was already shown; the empty state explains itself.
        })
      return function () {
        stopped = true
      }
    },
    [
      showingPost,
      props.sessionId,
      doc.postUpdatedAt,
      doc.postChars,
      doc.postHtmlUpdatedAt,
      postTick,
    ],
  )

  // Same marker pattern as the post body: briefUpdatedAt moves, we refetch.
  React.useEffect(
    function () {
      if (!showingPost) return undefined
      var stopped = false
      setBriefLoading(true)
      fetchBrief(props.sessionId)
        .then(function (body) {
          if (stopped) return
          setBriefLoading(false)
          setBrief(body && body.brief ? body.brief : null)
        })
        .catch(function () {
          if (stopped) return
          setBriefLoading(false)
        })
      return function () {
        stopped = true
      }
    },
    [showingPost, props.sessionId, doc.briefUpdatedAt, postTick],
  )

  function askForPostFetch() {
    var via = deliverToComposer(props.inputActions, buildPostFetchRequest(doc), props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: 'post' })
  }

  function askForBrief() {
    var via = deliverToComposer(props.inputActions, buildBriefRequest(doc), props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: 'post' })
  }

  function askForFit() {
    var via = deliverToComposer(props.inputActions, buildFitRequest(doc), props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: 'fit' })
  }

  function askToCloseGaps(gaps) {
    if (!gaps || gaps.length === 0) return
    var via = deliverToComposer(props.inputActions, buildGapMessage(gaps, doc), props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: 'cv' })
  }

  // The loading treatment for marked parts has TWO phases, one rule per
  // element in both:
  //
  //   queued  — while comment mode is open, the parts already added to the
  //             batch carry [data-jobcv-noted], so they are the selector;
  //             they dim and pulse the moment they are queued, not when the
  //             batch is sent.
  //   working — once the batch is on its way to the agent, the same
  //             treatment rides the anchor paths, so it keeps pointing at
  //             the same parts even after comment mode closes.
  //
  // The frame is same-origin, which is what lets the parent paint into it —
  // the same mechanism comment mode picks with.
  React.useEffect(
    function () {
      var queuedPhase = annotating && notes.length > 0
      if ((!workingParts && !queuedPhase) || showingPost) return undefined
      var idoc = null
      try {
        idoc = iframeRef.current && iframeRef.current.contentDocument
      } catch (e) {
        idoc = null
      }
      if (!idoc || !idoc.head) return undefined
      var css = workingParts ? buildWorkingCss(working.anchors) : buildQueuedCss()
      if (css === '') return undefined
      var style = idoc.createElement('style')
      style.id = 'dsh-job-cv-working'
      style.textContent = css
      idoc.head.appendChild(style)
      return function () {
        try {
          if (style.parentNode) style.parentNode.removeChild(style)
        } catch (e) {
          /* the frame may have been replaced already */
        }
      }
    },
    [workingParts, annotating, notes, showingPost, loadTick, working],
  )

  // A save while looking at an old version would leave the pane showing
  // something the timeline no longer describes — for either document.
  React.useEffect(
    function () {
      setLooking(null)
    },
    [doc.version, doc.letter ? doc.letter.version : 0],
  )

  // Switching tabs leaves the open timeline describing the document you just
  // left — including the Post tab, which has no timeline at all.
  React.useEffect(
    function () {
      setHistoryOpen(false)
      setLooking(null)
      setRestoreStatus(null)
    },
    [view],
  )

  function askForLetter() {
    var via = deliverToComposer(props.inputActions, buildLetterRequest(doc), props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: 'letter' })
  }

  // Comments belong to the document they were marked on: the highlights are
  // painted into the other iframe document and do not survive the switch, and
  // a batch that mixed the two would be sent under one heading naming one of
  // them. Dropping them silently is what would be unkind, so it is said.
  function switchView(next) {
    setSwipeHint(false)
    if (next === view) return
    var pending = collectNotes().length
    setView(next)
    setPicked(null)
    setDraft('')
    setNotes([])
    pickedElRef.current = null
    setSent(
      pending > 0
        ? pending +
            (pending === 1 ? ' note was' : ' notes were') +
            ' dropped — a comment belongs to the document it was marked on'
        : null,
    )
  }

  // Swipe between the CV / letter / post tabs on touch devices. The iframe
  // swallows the gesture, so attachSwipe (in the deck) detects it inside the
  // document and forwards it here; the ref carries the latest view list so
  // the handler stays registered once instead of churning every render.
  var swipeRef = React.useRef(function () {})
  swipeRef.current = function (dir) {
    var next = views[views.indexOf(view) + dir]
    if (next) switchView(next)
  }
  React.useEffect(function () {
    setSwipeHandler(function (dir) {
      swipeRef.current(dir)
    })
    return function () {
      setSwipeHandler(null)
    }
  }, [])

  function toggleAnnotating() {
    var next = !annotating
    setAnnotating(next)
    setSent(null)
    if (!next) {
      if (pickedElsRef.current) {
        for (var i = 0; i < pickedElsRef.current.length; i++) {
          pickedElsRef.current[i].removeAttribute('data-jobcv-picked')
        }
      } else if (pickedElRef.current) {
        pickedElRef.current.removeAttribute('data-jobcv-picked')
      }
      setPicked(null)
      setDraft('')
      setNotes([])
      pickedElRef.current = null
      pickedElsRef.current = null
    }
  }

  function exportPdf() {
    // The dialog's "Save as" name is the printed document's title, so the
    // title becomes the filename convention just before printing. It is not
    // restored afterwards: the print dialog reads it asynchronously in some
    // browsers, the next srcdoc render resets it anyway, and this document's
    // title is shown nowhere else.
    var fileName = exportFileName({
      name: candidateNameFrom(html),
      kind: showingLetter ? 'letter' : 'cv',
      jobTitle: doc.jobTitle,
      company: doc.company,
    })
    var win = null
    try {
      win = iframeRef.current && iframeRef.current.contentWindow
      if (win) {
        if (fileName !== '' && win.document) win.document.title = fileName
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
      if (fileName !== '') {
        try {
          w.document.title = fileName
        } catch (e) {
          /* the tab still opens; only its default filename is the old one */
        }
      }
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
    ? 'viewing ' + commentWhat + ' v' + looking.version + ' of ' + liveVersion
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

  // The swipe hint is for fingers, not mice — a coarse primary pointer is
  // the honest proxy for a touch device.
  var touchCoarse = false
  try {
    touchCoarse =
      typeof window !== 'undefined' &&
      !!window.matchMedia &&
      window.matchMedia('(pointer: coarse)').matches
  } catch (e) {
    touchCoarse = false
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
          flexDirection: 'column',
          borderBottom: '1px solid ' + pal.panelBorder,
          flex: 'none',
        },
      },
      // Row one is the document switcher, and ONLY the switcher: its own
      // centered row, so it stays put no matter what arrives on the action
      // row below it — a fit score, a new tab, a history panel.
      createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '6px 12px 0',
          },
        },
        !onboarding && views.length > 1
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
              views.map(function (which) {
                var active = view === which
                return createElement(
                  'button',
                  {
                    key: which,
                    type: 'button',
                    onClick: function () {
                      switchView(which)
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
                  which === 'cv'
                    ? 'CV'
                    : which === 'post'
                      ? 'Post'
                      : 'Letter v' + doc.letter.version,
                )
              }),
            )
          : !onboarding && !doc.letter
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
      ),
      swipeHint && !onboarding && views.length > 1 && touchCoarse
        ? createElement(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '3px 12px 0',
                fontSize: 10,
                color: pal.text,
                opacity: 0.75,
              },
            },
            createElement('span', { 'aria-hidden': 'true' }, '‹'),
            'swipe to switch',
            createElement('span', { 'aria-hidden': 'true' }, '›'),
          )
        : null,

      // Row two: status on the left, actions on the right, wrapping as it
      // must on a narrow pane.
      createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 12px 8px',
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
        // The letter has its own version line, so it has its own timeline.
        !onboarding && !showingPost && !(showingLetter && doc.letter.version < 2 && !historyOpen)
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: toggleHistory,
                title: 'Restore an earlier saved version of the ' + commentWhat,
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
        // The score sits in the toolbar rather than behind the panel: "how
        // close am I" should be answered without opening anything.
        !onboarding
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  if (doc.fit) setFitOpen(!fitOpen)
                  else askForFit()
                },
                title: doc.fit
                  ? 'What this CV answers in the post, and what it does not' +
                    (fitStale(doc.fit, doc) ? ' (scored against an older version)' : '')
                  : 'Ask the agent to score this CV against the job post',
                style: doc.fit
                  ? Object.assign({}, toolbarBtn, {
                      color: fitColor(doc.fit.score, pal.dark),
                      borderColor: fitColor(doc.fit.score, pal.dark),
                      fontWeight: 600,
                    })
                  : toolbarBtn,
              },
              doc.fit
                ? doc.fit.score + '% fit' + (fitStale(doc.fit, doc) ? ' ·' : '')
                : 'Score fit',
            )
          : null,
        !onboarding && !doc.letter && views.length > 1
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
        !onboarding && !showingPost
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: toggleAnnotating,
                title: annotating
                  ? 'Stop marking parts of the ' + commentWhat
                  : 'Click a line in the ' + commentWhat + ' to say what needs fixing',
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
        !onboarding && !showingPost
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
    ),
    // history panel
    historyOpen && !showingPost
      ? createElement(HistoryPanel, {
          pal: pal,
          what: commentWhat,
          versions: versions,
          currentVersion: liveVersion,
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
            'Looking at ' +
              commentWhat +
              ' v' +
              looking.version +
              ' — nothing is changed until you restore it.',
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
    // fit panel — the score, and the gaps to close before the first interview
    fitOpen && doc.fit
      ? createElement(FitPanel, {
          pal: pal,
          fit: doc.fit,
          doc: doc,
          onRescore: askForFit,
          onAskGaps: askToCloseGaps,
          onClose: function () {
            setFitOpen(false)
          },
        })
      : null,
    // comment panel
    annotating
      ? createElement(CommentPanel, {
          pal: pal,
          what: commentWhat,
          picked: picked,
          draft: draft,
          notes: notes,
          setDraft: setDraft,
          onAdd: addNote,
          onSend: sendNotes,
          onDropPicked: function () {
            if (pickedElsRef.current) {
              for (var i = 0; i < pickedElsRef.current.length; i++) {
                pickedElsRef.current[i].removeAttribute('data-jobcv-picked')
              }
            } else if (pickedElRef.current) {
              pickedElRef.current.removeAttribute('data-jobcv-picked')
            }
            setPicked(null)
            setDraft('')
            pickedElRef.current = null
            pickedElsRef.current = null
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
    // document surface — or the job post, which is text, not a printed page
    showingPost
      ? createElement(PostSurface, {
          pal: pal,
          post: post,
          brief: brief,
          briefLoading: briefLoading,
          working: workingHere ? working : null,
          doc: doc,
          loading: postLoading,
          sessionId: props.sessionId,
          onSaved: function () {
            bumpPostTick(function (n) {
              return n + 1
            })
          },
          onAskFetch: askForPostFetch,
          onAskBrief: askForBrief,
        })
      : createElement(
          'div',
          {
            ref: surfaceRef,
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
          workingHere && !showingPost
            ? createElement(WorkingBadge, {
                pal: pal,
                label: starter
                  ? 'Writing your CV…'
                  : workingParts
                    ? 'Working on ' +
                      working.anchors.length +
                      (working.anchors.length === 1 ? ' marked part…' : ' marked parts…')
                    : working.target === 'letter'
                      ? 'Working on the cover letter…'
                      : 'Revising v' + doc.version + '…',
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
            : workingHere && starter
              ? // Nothing to blur yet, and the starter template is not the user's
                // document — show the shape of what is coming instead.
                createElement(CvSkeleton, { pal: pal })
              : createElement(
                  'div',
                  {
                    style: {
                      position: 'relative',
                      flex: 'none',
                      margin: '0 auto',
                      width: Math.round(SHEET_W * scale) + 'px',
                      height: Math.round((frameH + 2) * scale) + 'px',
                    },
                  },
                  createElement('iframe', {
                    key: doc.version,
                    ref: iframeRef,
                    srcDoc: html,
                    title: 'CV document',
                    sandbox: 'allow-same-origin allow-modals',
                    onLoad: function () {
                      // The page deck comes FIRST: it changes the layout the
                      // measurement below reads. srcdoc + allow-same-origin makes
                      // the frame same-origin, so the document height is readable:
                      // stretch the iframe to the full multi-page height and let
                      // the outer pane scroll.
                      injectPageDeck(iframeRef.current, pal)
                      measureFrame()
                      // Data-URI images and any late reflow land after onLoad;
                      // a second pass catches a multi-page document that is
                      // still settling, so its last page is never cut off.
                      setTimeout(measureFrame, 300)
                      bumpLoad(function (n) {
                        return n + 1
                      })
                    },
                    style: {
                      // TRUE A4, always: the document lays out at the same
                      // 210mm the PDF prints at. A pane narrower than the sheet
                      // scales the whole thing down (transform below) instead
                      // of reflowing it.
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '210mm',
                      height: frameH + 'px',
                      background: '#fff',
                      border: '1px solid ' + pal.panelBorder,
                      borderRadius: 3,
                      boxShadow: pal.dark
                        ? '0 2px 14px rgba(0,0,0,0.45)'
                        : '0 2px 14px rgba(0,0,0,0.13)',
                      transform: 'scale(' + scale + ')',
                      transformOrigin: 'top left',
                      // The version on screen is about to be replaced: softened so it
                      // reads as superseded, still legible enough to keep your place.
                      filter: workingWholeDoc ? 'blur(2.5px) saturate(0.85)' : 'none',
                      opacity: workingWholeDoc ? 0.62 : 1,
                      transition: 'filter 240ms ease, opacity 240ms ease',
                      pointerEvents: workingWholeDoc ? 'none' : 'auto',
                    },
                  }),
                ),
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
        (props.what || 'CV') + ' history',
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

// ------------------------- comment panel -------------------------
// Sits under the toolbar while comment mode is on: what you picked, what you
// want changed, and the queue of notes waiting to go to the chat as one
// message (one message, not one per note — each send costs the agent a full
// turn and a document rewrite).
function CommentPanel(props) {
  var pal = props.pal
  var picked = props.picked
  var notes = props.notes

  var field = {
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
    minHeight: 52,
    fontFamily: 'inherit',
    fontSize: 12,
    lineHeight: '17px',
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid ' + pal.controlBorder,
    background: pal.dark ? 'rgba(0,0,0,0.25)' : '#fff',
    color: pal.textStrong,
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
  var primaryBtn = Object.assign({}, btn, {
    background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
    borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
  })

  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      props.onSend()
    }
  }

  return createElement(
    'div',
    {
      style: {
        flex: 'none',
        padding: '8px 12px 10px',
        borderBottom: '1px solid ' + pal.panelBorder,
        background: pal.panelBg,
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        maxHeight: '46%',
        overflow: 'auto',
      },
    },
    picked === null
      ? createElement(
          'div',
          { style: { fontSize: 12, color: pal.text } },
          notes.length === 0
            ? 'Click any line, bullet or heading in the ' +
                props.what +
                ' below to mark it — or drag across several to mark the whole range.'
            : 'Click another line to add to the batch, or send the ' +
                notes.length +
                (notes.length === 1 ? ' note' : ' notes') +
                ' below.',
        )
      : createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          createElement(
            'div',
            { style: { fontSize: 11, color: pal.text } },
            picked.section
              ? 'In “' +
                  picked.section +
                  '”' +
                  (picked.parts && picked.parts.length > 1
                    ? ' — ' + picked.parts.length + ' parts, one range'
                    : '')
              : picked.parts && picked.parts.length > 1
                ? picked.parts.length + ' parts — one range'
                : 'Selected',
          ),
          createElement(
            'blockquote',
            {
              style: {
                margin: 0,
                padding: '5px 9px',
                borderLeft: '3px solid ' + pal.accent,
                background: pal.dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                fontSize: 12,
                color: pal.textStrong,
                borderRadius: '0 4px 4px 0',
              },
            },
            picked.text || '(no text — an empty block)',
          ),
          createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
            COMMENT_PRESETS.map(function (preset) {
              return createElement(
                'button',
                {
                  key: preset,
                  type: 'button',
                  onClick: function () {
                    props.setDraft(preset)
                  },
                  style: Object.assign({}, btn, { fontSize: 11, padding: '2px 8px' }),
                },
                preset,
              )
            }),
          ),
          createElement('textarea', {
            value: props.draft,
            autoFocus: true,
            placeholder: 'What needs to change here? (⌘/Ctrl+Enter sends)',
            onChange: function (e) {
              props.setDraft(e.target.value)
            },
            onKeyDown: onKeyDown,
            style: field,
          }),
          createElement(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            createElement(
              'button',
              {
                type: 'button',
                onClick: props.onAdd,
                style: btn,
                title: 'Queue this and mark another spot',
              },
              'Add another',
            ),
            createElement(
              'button',
              { type: 'button', onClick: props.onDropPicked, style: btn },
              'Cancel',
            ),
          ),
        ),
    notes.length > 0
      ? createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          notes.map(function (note, index) {
            return createElement(
              'div',
              {
                key: index,
                style: {
                  display: 'flex',
                  gap: 6,
                  alignItems: 'baseline',
                  fontSize: 11,
                  color: pal.text,
                },
              },
              createElement('span', { style: { color: pal.accent } }, String(index + 1) + '.'),
              createElement(
                'span',
                {
                  style: {
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                  title: note.text,
                },
                squish(note.comment) + ' — “' + clip(note.text, 60) + '”',
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    props.onRemoveNote(index)
                  },
                  title: 'Drop this note',
                  style: Object.assign({}, btn, { fontSize: 11, padding: '1px 6px' }),
                },
                '×',
              ),
            )
          }),
        )
      : null,
    props.pendingCount > 0
      ? createElement(
          'div',
          { style: { display: 'flex', gap: 6 } },
          createElement(
            'button',
            { type: 'button', onClick: props.onSend, style: primaryBtn },
            props.pendingCount === 1
              ? 'Send to chat'
              : 'Send ' + props.pendingCount + ' notes to chat',
          ),
        )
      : null,
  )
}

// ------------------------- job layout -------------------------
// The preview shows up in one of two shapes, both driven by the same dock
// button:
//
//   split   — enough room: the shell's center grid track is squeezed into a
//             chat sidebar on the RIGHT and the preview takes the whole area
//             that frees up on the left. Pure DOM surgery on the column React
//             owns, in the same self-healing style as dsh-trader's chart host.
//   overlay — too little room, or "Full screen" on a wide one: a portal over
//             the whole window. Without this, pressing the button on a small
//             screen used to do nothing at all.
//
// "Enough room" is measured on the CENTER COLUMN, not on the window. The
// shell spends width on its session sidebar and, when it is open, on the
// details panel — so a 1500px window can still leave a 640px column, and
// splitting that in two gives a chat too narrow to type in beside a CV too
// narrow to read.
var CHAT_MAX = 460 // as wide as the chat sidebar ever needs to be
var CHAT_MIN = 340 // narrower and the composer's own controls start to fold
var PREVIEW_MIN = 520 // an A4 sheet reflowed below this stops reading as a page
var SPLIT_MIN = CHAT_MIN + PREVIEW_MIN
// Stands in for the column for the frame or two before it can be measured:
// the shell's chrome around it is about one sidebar wide.
var SHELL_CHROME = 300

/**
 * The chat's share of a column `colW` wide. Everything above CHAT_MAX goes to
 * the preview — a wider window should show more CV, not more chat — and the
 * chat gives width back down to CHAT_MIN before the split is abandoned.
 */
function chatWidthFor(colW) {
  return Math.max(CHAT_MIN, Math.min(CHAT_MAX, colW - PREVIEW_MIN))
}

/** Is there room for both halves, or does the preview take the window? */
function splitFits(colW) {
  return colW >= SPLIT_MIN
}

/**
 * The chat's share when the user has DRAGGED the divider: the computed share
 * is a suggestion, the drag is a decision — clamped so the chat never folds
 * below CHAT_MIN and the preview keeps at least MIN_PREVIEW_PX, which is
 * enough for a scaled-down sheet.
 */
var MIN_PREVIEW_PX = 240
function clampChatW(w, colW) {
  return Math.max(CHAT_MIN, Math.min(w, Math.max(CHAT_MIN, colW - MIN_PREVIEW_PX)))
}

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

/** Track viewport width; only a stand-in until the column is measured. */
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
 * Resolve the shell's center column, or null while it is not there.
 *
 * Retry ticks: the scroll node may not exist for a few frames after a
 * session switch or shell boot, so the lookup re-attempts briefly instead
 * of giving up until the next re-render.
 */
function useCenterColumn(enabled) {
  var colState = React.useState(null)
  var col = colState[0]
  var setCol = colState[1]
  var tickState = React.useState(0)
  var tick = tickState[0]
  var bumpTick = tickState[1]

  React.useLayoutEffect(
    function () {
      if (!enabled) {
        setCol(null)
        // Spent ticks are reset so that reopening the preview searches again
        // rather than inheriting an exhausted retry budget.
        if (tick !== 0) bumpTick(0)
        return undefined
      }
      var scroll = document.querySelector('[data-conversation-scroll]')
      var found = null
      if (scroll) {
        found = findCenterColumn(scroll)
        if (!found)
          found =
            (scroll.parentElement &&
              scroll.parentElement.parentElement &&
              scroll.parentElement.parentElement.parentElement) ||
            scroll.parentElement
      }
      if (found && found.appendChild !== undefined) {
        setCol(found)
        return undefined
      }
      if (tick < 20) {
        var t = setTimeout(function () {
          bumpTick(tick + 1)
        }, 300)
        return function () {
          clearTimeout(t)
        }
      }
      return undefined
    },
    [enabled, tick],
  )

  return col
}

/**
 * The element's border-box width, live.
 *
 * The shape decision reads this rather than the window: the shell animates
 * its columns on a transition and lets the user drag them, so the room the
 * preview actually has changes without the window ever resizing.
 */
function useElementWidth(el) {
  var state = React.useState(0)
  var width = state[0]
  var setWidth = state[1]

  React.useLayoutEffect(
    function () {
      if (!el) {
        setWidth(0)
        return undefined
      }
      function measure() {
        try {
          // The BORDER box, which the split's own padding never moves — so
          // measuring cannot feed back into the transform that reads it.
          var w = Math.round(el.getBoundingClientRect().width)
          if (w > 0) setWidth(w)
        } catch (e) {
          /* keep the last good width */
        }
      }
      measure()
      window.addEventListener('resize', measure)
      var resize = null
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(measure)
        resize.observe(el)
      }
      var settle = setTimeout(measure, 260) // after the shell's column transition
      return function () {
        clearTimeout(settle)
        window.removeEventListener('resize', measure)
        if (resize !== null) resize.disconnect()
      }
    },
    [el],
  )

  return width
}

/**
 * Split mode: squeeze the chat into a sidebar on the right of the center
 * column and insert a pane host over the width that frees up on its left.
 * Returns the host element once attached, or null while it is not.
 */
function useSplitPane(col, enabled, pal, chatW, onChatW) {
  var hostState = React.useState(null)
  var host = hostState[0]
  var setHost = hostState[1]
  var paneRef = React.useRef(null)
  // The chat share the user has chosen, held in a ref so the drag updates the
  // layout WITHOUT rebuilding the transform: rebuilding would remount the
  // iframe and throw away where the reader had scrolled to.
  var chatWRef = React.useRef(chatW)
  chatWRef.current = chatW

  React.useLayoutEffect(
    function () {
      if (!enabled || !col) return undefined

      var prev = {
        position: col.style.position,
        paddingLeft: col.style.paddingLeft,
      }
      var pane = document.createElement('div')
      pane.setAttribute('data-dsh-job-cv-pane', '')
      // The divider: a fixed handle ON the boundary. Dragging it re-splits
      // the column live — the chat share is clamped, the preview scales to
      // whatever remains, and a double-click returns to the computed share.
      var divider = document.createElement('div')
      divider.setAttribute('data-dsh-job-cv-divider', '')
      divider.style.position = 'fixed'
      divider.style.zIndex = '6'
      divider.style.width = '7px'
      divider.style.cursor = 'col-resize'
      divider.style.touchAction = 'none'
      divider.style.background = 'transparent'
      divider.addEventListener('mouseenter', function () {
        divider.style.background = pal.dark ? 'rgba(122,184,255,0.35)' : 'rgba(46,111,219,0.30)'
      })
      divider.addEventListener('mouseleave', function () {
        divider.style.background = 'transparent'
      })
      divider.addEventListener('dblclick', function () {
        chatWRef.current = null
        if (onChatW) onChatW(null)
        syncLayout()
      })
      // A drag flag instead of pointer capture: capture needs an ACTIVE
      // pointer, and the window listeners keep the drag alive even when the
      // pointer leaves the thin handle.
      var draggingDivider = false
      function onDividerDown(e) {
        e.preventDefault()
        draggingDivider = true
      }
      function onDividerMove(e) {
        if (!draggingDivider) return
        var rect = col.getBoundingClientRect()
        var share = clampChatW(rect.right - e.clientX, rect.width)
        chatWRef.current = share
        if (onChatW) onChatW(share)
        syncLayout()
      }
      function onDividerUp() {
        draggingDivider = false
      }
      divider.addEventListener('pointerdown', onDividerDown)
      window.addEventListener('pointermove', onDividerMove)
      window.addEventListener('pointerup', onDividerUp)
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
      // The seam below is drawn INSIDE the pane's width. On the content box it
      // lands on the chat's first pixel instead, where the composer — which
      // the shell floats above us — paints over it, and the divider goes
      // missing for exactly the height of the composer.
      pane.style.boxSizing = 'border-box'
      // Paint it now as well as in the theme effect below: that effect first
      // runs a frame later, and an unpainted pane shows the chat through it.
      pane.style.borderRight = '1px solid ' + pal.panelBorder
      pane.style.background = pal.baseBg

      /**
       * Place both halves from one measurement of the column, so the chat's
       * left edge and the pane's right edge are the same number.
       */
      function syncLayout() {
        try {
          var rect = col.getBoundingClientRect()
          var viewportH = window.innerHeight || 0
          if (rect.width <= 0 || viewportH <= 0) return
          var chatShare =
            chatWRef.current === null
              ? chatWidthFor(rect.width)
              : clampChatW(chatWRef.current, rect.width)
          var previewW = Math.max(0, Math.round(rect.width - chatShare))
          // Padding on the LEFT is what moves the conversation across. Padding
          // on the right merely narrows it where it stands, which left the
          // chat sitting on top of the preview with dead space beside it.
          // Only written when it changes: the MutationObserver below watches
          // this very attribute.
          if (col.style.paddingLeft !== previewW + 'px') col.style.paddingLeft = previewW + 'px'
          var top = Math.max(0, rect.top)
          var height = Math.max(0, Math.min(viewportH, rect.bottom) - top)
          pane.style.top = top + 'px'
          pane.style.left = Math.max(0, rect.left) + 'px'
          pane.style.width = previewW + 'px'
          pane.style.height = height + 'px'
          divider.style.top = top + 'px'
          divider.style.left = Math.max(0, rect.left + previewW - 3.5) + 'px'
          divider.style.height = height + 'px'
        } catch (e) {
          /* keep the last good box rather than collapsing the pane */
        }
      }

      function applyTransform() {
        if (getComputedStyle(col).position === 'static') col.style.position = 'relative'
        syncLayout()
      }
      applyTransform()
      col.insertBefore(pane, col.firstChild)
      col.appendChild(divider)
      paneRef.current = pane
      setHost(pane)

      // Self-heal: a shell re-render that wipes the inline padding, or a
      // layout transition that drops/reorders the pane, is repaired here.
      var observer = new MutationObserver(function () {
        if (pane.parentElement !== col || col.firstChild !== pane) {
          if (pane.parentElement) pane.parentElement.removeChild(pane)
          col.insertBefore(pane, col.firstChild)
        }
        applyTransform()
      })
      observer.observe(col, { childList: true, attributes: true, attributeFilter: ['style'] })

      // The box moves with the window, with the shell's own scrollers (capture
      // catches inner ones, which do not bubble), and with layout changes —
      // and the column's width is what decides how wide the chat sidebar is,
      // so the same handlers re-divide the two halves.
      window.addEventListener('resize', syncLayout)
      window.addEventListener('scroll', syncLayout, true)
      var resize = null
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(syncLayout)
        resize.observe(col)
      }
      var settle = setTimeout(syncLayout, 60) // after the shell's own transition

      return function () {
        clearTimeout(settle)
        window.removeEventListener('resize', syncLayout)
        window.removeEventListener('scroll', syncLayout, true)
        if (resize !== null) resize.disconnect()
        observer.disconnect()
        paneRef.current = null
        setHost(null)
        divider.removeEventListener('pointerdown', onDividerDown)
        window.removeEventListener('pointermove', onDividerMove)
        window.removeEventListener('pointerup', onDividerUp)
        if (pane.parentElement) pane.parentElement.removeChild(pane)
        if (divider.parentElement) divider.parentElement.removeChild(divider)
        col.style.position = prev.position
        col.style.paddingLeft = prev.paddingLeft
      }
    },
    [col, enabled],
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
  var showing = props.active && props.open
  // Resolved whichever shape is showing: it is what the split is measured
  // against, and what lets a widening window fall back into a split.
  var col = useCenterColumn(showing)
  var colW = useElementWidth(col)
  var room = colW > 0 ? colW : viewportW - SHELL_CHROME
  var wide = splitFits(room)
  // With no room for a side-by-side split the preview takes over the window
  // rather than refusing to open.
  var asOverlay = showing && (!wide || props.fullScreen)
  var host = useSplitPane(col, showing && !asOverlay, pal, props.chatW, props.onChatW)

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
        // Esc drops full screen when there is a split to drop back to, and
        // closes the preview outright when there is not.
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

/** Extension of a file name, lowercase, or '' when there is none. */
function extOf(name) {
  var i = String(name).lastIndexOf('.')
  if (i <= 0) return ''
  return String(name)
    .slice(i + 1)
    .toLowerCase()
}

/** How the hover preview renders a file, from its extension alone. */
function kindOf(ext) {
  if (ext === 'html' || ext === 'htm') return 'html'
  if (
    ext === 'png' ||
    ext === 'jpg' ||
    ext === 'jpeg' ||
    ext === 'gif' ||
    ext === 'webp' ||
    ext === 'svg'
  )
    return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'css' || ext === 'js') {
    return 'text'
  }
  return 'other'
}

/**
 * The hover preview popover. Fixed-positioned beside the hovered chip (the
 * scrolling strip would clip an in-flow tooltip), and stays open while the
 * cursor is over it so the "Open" link stays reachable.
 */
function FilePreview(props) {
  var p = props.preview
  if (!p) return null
  var pal = props.pal
  var W = 340
  var H = 320
  var vw = window.innerWidth
  var vh = window.innerHeight
  var left = Math.max(8, Math.min(p.spot.left, vw - W - 8))
  // Below the chip when there is room, above it otherwise.
  var top =
    p.spot.chipBottom + 8 + H <= vh - 8
      ? p.spot.chipBottom + 8
      : Math.max(8, p.spot.chipTop - 8 - H)
  var header = createElement(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderBottom: '1px solid ' + pal.panelBorder,
        fontSize: 11,
        color: pal.text,
        background: pal.controlBg,
      },
    },
    createElement(
      'span',
      {
        title: p.name,
        style: {
          flex: 1,
          minWidth: 0,
          fontWeight: 600,
          color: pal.textStrong,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      },
      p.name,
    ),
    createElement(
      'span',
      { style: { fontSize: 10, color: pal.text, whiteSpace: 'nowrap' } },
      p.size + ' bytes',
    ),
    createElement(
      'a',
      {
        href: p.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        style: { color: pal.accent, textDecoration: 'none', whiteSpace: 'nowrap' },
      },
      'Open ↗',
    ),
  )
  var body
  if (p.loading) {
    body = createElement(
      'div',
      {
        style: {
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          color: pal.text,
        },
      },
      'Loading…',
    )
  } else if (p.kind === 'html') {
    body = createElement('iframe', {
      srcDoc: p.body,
      sandbox: '',
      title: p.name,
      style: { flex: 1, width: '100%', border: 'none', background: '#fff', display: 'block' },
    })
  } else if (p.kind === 'text') {
    body = createElement(
      'pre',
      {
        style: {
          margin: 0,
          padding: 12,
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 11,
          lineHeight: 1.5,
          color: pal.text,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        },
      },
      p.body,
    )
  } else if (p.kind === 'image') {
    body = createElement(
      'div',
      {
        style: {
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          background: pal.panelBg,
        },
      },
      createElement('img', {
        src: p.url,
        alt: p.name,
        style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' },
      }),
    )
  } else {
    body = createElement(
      'div',
      {
        style: {
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 12,
          boxSizing: 'border-box',
          fontSize: 11,
          color: pal.text,
        },
      },
      p.kind === 'pdf' ? 'PDF — open it to read.' : 'Binary file — open it to view.',
    )
  }
  return createElement(
    'div',
    {
      onMouseEnter: props.onEnter,
      onMouseLeave: props.onLeave,
      style: {
        position: 'fixed',
        left: left,
        top: top,
        width: W,
        height: H,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1000,
        background: pal.baseBg,
        border: '1px solid ' + pal.panelBorder,
        borderRadius: 6,
        boxShadow: pal.dark ? '0 10px 28px rgba(0,0,0,0.55)' : '0 10px 28px rgba(0,0,0,0.18)',
        overflow: 'hidden',
      },
    },
    header,
    body,
  )
}

function JobDock(props) {
  useThemeTick()
  var pal = palette()
  var sessionId = props.sessionId
  // The user's own unsent draft, mirrored out of DraftProbe. Read there, not
  // here: useInput is a HOOK and it is not always present.
  var draftState = React.useState('')
  var draft = draftState[0]
  var setDraft = draftState[1]
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
  // The chat share the user dragged the divider to; null = the computed one.
  var chatWState = React.useState(function () {
    return loadPrefs(sessionId).chatW
  })
  var chatW = chatWState[0]
  var setChatWState = chatWState[1]

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
    setChatWState(loadPrefs(sessionId).chatW)
    setFullScreenState(false)
  }

  var docState = React.useState({
    version: 0,
    html: '',
    jobUrl: '',
    updatedAt: 0,
    fit: null,
    postChars: 0,
    briefUpdatedAt: 0,
  })
  var doc = docState[0]
  var setDoc = docState[1]
  // What we handed the agent, and which surface it is about. A snapshot of
  // that surface's marker at request time: the working state ends when THAT
  // marker moves — a CV save ends a CV request, a letter save ends a letter
  // request — so a save landing while something else is in flight does not
  // clear the wrong thing. The give-up timer below still bounds it.
  var workingFromState = React.useState(null)
  var workingFrom = workingFromState[0]
  var setWorkingFrom = workingFromState[1]

  function workStarted(payload) {
    var target =
      payload && payload.target === 'letter'
        ? 'letter'
        : payload && payload.target === 'post'
          ? 'post'
          : payload && payload.target === 'fit'
            ? 'fit'
            : 'cv'
    setWorkingFrom({
      target: target,
      startedAt: Date.now(),
      version: doc.version,
      letterVersion: doc.letter ? doc.letter.version : 0,
      postUpdatedAt: doc.postUpdatedAt || 0,
      postHtmlUpdatedAt: doc.postHtmlUpdatedAt || 0,
      briefUpdatedAt: doc.briefUpdatedAt || 0,
      fitUpdatedAt: doc.fit ? doc.fit.updatedAt : 0,
      anchors: payload && Array.isArray(payload.anchors) ? payload.anchors : [],
    })
  }
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
  // The file list can be long enough to bury the status row; keep it folded
  // to a count by default (null = auto: unfold only when short) and let the
  // user unfold it into a horizontally scrolling strip on demand.
  var filesOpenState = React.useState(null)
  var filesOpen = filesOpenState[0]
  var setFilesOpen = filesOpenState[1]
  // Hover preview of a workspace file: { name, size, kind, url, body, spot,
  // loading }. null = nothing hovering. `spot` is the chip's rect so the
  // popover can pin itself beside it; the body is fetched once, on hover.
  var previewState = React.useState(null)
  var preview = previewState[0]
  var setPreview = previewState[1]
  // A monotone token so a slow fetch for a chip the cursor already left
  // cannot repaint the popover for the wrong file.
  var previewSeq = React.useRef(0)
  // The shared grace timer: entering cancels a pending hide, leaving (or the
  // popover losing the cursor) schedules one.
  var previewTimer = React.useRef(null)

  function enterFile(e, f) {
    clearTimeout(previewTimer.current)
    var seq = previewSeq.current + 1
    previewSeq.current = seq
    var rect = e.currentTarget.getBoundingClientRect()
    var url = fileUrl(sessionId, f.name)
    var kind = kindOf(extOf(f.name))
    var spot = { left: rect.left, chipTop: rect.top, chipBottom: rect.bottom }
    var base = { name: f.name, size: f.size, kind: kind, url: url, body: '', spot: spot }
    if (kind === 'html' || kind === 'text') {
      setPreview(Object.assign({}, base, { loading: true }))
      fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('preview fetch failed')
          return res.text()
        })
        .then(function (text) {
          if (previewSeq.current !== seq) return
          setPreview(Object.assign({}, base, { body: text, loading: false }))
        })
        .catch(function () {
          if (previewSeq.current !== seq) return
          setPreview(Object.assign({}, base, { kind: 'other', loading: false }))
        })
    } else {
      setPreview(Object.assign({}, base, { loading: false }))
    }
  }

  function leaveFile() {
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(function () {
      setPreview(null)
    }, 160)
  }

  function enterPreview() {
    clearTimeout(previewTimer.current)
  }

  function setOpen(v) {
    savePrefs(sessionId, { open: v, chatW: chatW || 0 })
    setOpenState(v)
    if (!v) setFullScreenState(false)
  }
  // A drag is a decision and persists with the session; null returns the
  // column to the computed split.
  function setChatW(v) {
    savePrefs(sessionId, { open: open, chatW: v || 0 })
    setChatWState(v)
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
              return sameDoc(next, prev) ? prev : next
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
              return workingDone(from, next)
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

  // Auto-unfold a short list, fold a long one; an explicit click overrides.
  // `null` means "no opinion yet", so the initial fold follows the count.
  var wsFiles = ws && Array.isArray(ws.files) ? ws.files : []
  var showFiles = wsFiles.length > 0 && (filesOpen !== null ? filesOpen : wsFiles.length <= 8)

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
            open
              ? 'working'
              : workingFrom === null
                ? 'working on your CV'
                : workingFrom.target === 'letter'
                  ? 'working on the cover letter'
                  : workingFrom.target === 'post'
                    ? 'working on the posting'
                    : workingFrom.target === 'fit'
                      ? 'working on the fit score'
                      : 'working on your CV',
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
      // The score belongs here as well as in the preview: the preview is the
      // first thing folded away when the chat needs room, and "how close am
      // I" should not fold away with it.
      doc.fit
        ? createElement(
            'span',
            {
              title:
                (doc.fit.verdict || 'match against this job post') +
                (fitStale(doc.fit, doc)
                  ? ' (scored against CV v' + doc.fit.basedOnVersion + ')'
                  : '') +
                ' — open the preview for the gaps',
              style: {
                fontSize: 11,
                fontWeight: 600,
                color: fitColor(doc.fit.score, pal.dark),
              },
            },
            doc.fit.score + '% fit' + (fitStale(doc.fit, doc) ? ' ·' : ''),
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
          wsFiles.length > 0
            ? createElement(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    setFilesOpen(!showFiles)
                  },
                  title: showFiles
                    ? 'Fold the file list'
                    : 'Show all ' + wsFiles.length + (wsFiles.length === 1 ? ' file' : ' files'),
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    border: '1px solid ' + pal.controlBorder,
                    background: pal.panelBg,
                    color: pal.textStrong,
                    borderRadius: 4,
                    padding: '1px 6px',
                    fontSize: 10,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  },
                },
                wsFiles.length +
                  (wsFiles.length === 1 ? ' file ' : ' files ') +
                  (showFiles ? '▾' : '▸'),
              )
            : createElement('span', {}, 'empty folder'),
          showFiles
            ? createElement(
                'span',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    flexBasis: '100%',
                    minWidth: 0,
                    overflowX: 'auto',
                    flexWrap: 'nowrap',
                    paddingBottom: 2,
                    scrollbarWidth: 'thin',
                  },
                },
                wsFiles.map(function (f) {
                  return createElement(
                    'button',
                    {
                      key: f.name,
                      type: 'button',
                      onMouseEnter: function (e) {
                        enterFile(e, f)
                      },
                      onMouseLeave: leaveFile,
                      onFocus: function (e) {
                        enterFile(e, f)
                      },
                      onBlur: leaveFile,
                      title: 'Preview ' + f.name + ' · ' + f.size + ' bytes',
                      style: {
                        border: '1px solid ' + pal.controlBorder,
                        background: pal.panelBg,
                        color: pal.text,
                        borderRadius: 4,
                        padding: '1px 6px',
                        fontSize: 10,
                        lineHeight: '15px',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      },
                    },
                    f.name,
                  )
                }),
              )
            : null,
        )
      : null,
    createElement(FilePreview, {
      pal: pal,
      preview: preview,
      onEnter: enterPreview,
      onLeave: leaveFile,
    }),
    props.useInput
      ? createElement(DraftProbe, { useInput: props.useInput, onDraft: setDraft })
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
      chatW: chatW,
      onChatW: setChatW,
      working: workingFrom,
      onWorkStarted: workStarted,
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

/**
 * Error boundary around the whole dock.
 *
 * A plugin injected into someone else's shell fails invisibly: React unmounts
 * the broken subtree and the row is simply not there, which the user
 * experiences as "the button is gone" with nothing to report and nothing in
 * view. A boundary turns that into a visible line naming the failure.
 */
var DockBoundary = (function () {
  function Boundary(props) {
    React.Component.call(this, props)
    this.state = { error: null }
  }
  Boundary.prototype = Object.create(React.Component.prototype)
  Boundary.prototype.constructor = Boundary
  Boundary.getDerivedStateFromError = function (error) {
    return { error: error }
  }
  Boundary.prototype.componentDidCatch = function (error) {
    try {
      console.error('[dsh-job-cv] the job dock crashed:', error)
    } catch (e) {
      /* nothing more to do */
    }
  }
  Boundary.prototype.render = function () {
    if (this.state === null || this.state.error === null) return this.props.children
    var error = this.state.error
    return createElement(
      'div',
      {
        style: {
          padding: '4px 2px 8px',
          fontSize: 11,
          color: isDark() ? '#ffb4a2' : '#b3261e',
        },
      },
      '◆ Job mode — the dock hit an error and stopped rendering: ' +
        String(error && error.message ? error.message : error) +
        ' (details in the browser console)',
    )
  }
  return Boundary
})()

/** What the slot actually mounts: the dock, behind the boundary. */
function JobDockRoot(props) {
  return createElement(DockBoundary, null, createElement(JobDock, props))
}

/**
 * Reads the composer draft and mirrors it up.
 *
 * This exists only so the hook is not called conditionally. `useInput` is a
 * standard-kit HOOK, and the dock sits in a session-maybe seat where it is
 * absent until a session is current. Calling it behind a ternary changed
 * JobDock's hook order the moment it appeared, and React answers that by
 * tearing the subtree down — which took the whole dock, preview button
 * included, off the screen. A child that is conditionally RENDERED has its
 * own hook list, so appearing and disappearing is safe.
 */
function DraftProbe(props) {
  var useInput = props.useInput
  var onDraft = props.onDraft
  var draft = useInput(function (input) {
    return input && typeof input.draft === 'string' ? input.draft : ''
  })
  React.useEffect(
    function () {
      onDraft(typeof draft === 'string' ? draft : '')
    },
    [draft, onDraft],
  )
  return null
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
        return slots.register(options, JobDockRoot)
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
      buildWorkingCss: buildWorkingCss,
      buildQueuedCss: buildQueuedCss,
      rangeNoteFrom: rangeNoteFrom,
      anchorPathsFor: anchorPathsFor,
      sanitizeAnchorPath: sanitizeAnchorPath,
      ANNOTATE_CSS: ANNOTATE_CSS,
      pageDeckCss: pageDeckCss,
      attachSwipe: attachSwipe,
      setSwipeHandler: setSwipeHandler,
    }

    // Test surface for the onboarding start form: the pure helpers (the
    // component itself needs a DOM). Same idea as __annotate above.
    exports.__review = { buildDecisionMessage: buildDecisionMessage, pickedOption: pickedOption }

    exports.__diagnostics = { offlineReason: offlineReason, sameDoc: sameDoc, workingDone: workingDone }

    // Test surface for the fit panel: the messages a gap turns into, and the
    // staleness rule that decides whether the score on screen is about the
    // document on screen.
    exports.__fit = {
      buildFitRequest: buildFitRequest,
      buildGapMessage: buildGapMessage,
      buildPostFetchRequest: buildPostFetchRequest,
      buildBriefRequest: buildBriefRequest,
      POST_GAP_CSS: POST_GAP_CSS,
      fitStale: fitStale,
      fitBand: fitBand,
    }

    // Test surface for the split: how the column is divided is arithmetic,
    // and a preview squeezed down to a sliver is invisible in review.
    exports.__layout = {
      chatWidthFor: chatWidthFor,
      splitFits: splitFits,
      clampChatW: clampChatW,
      MIN_PREVIEW_PX: MIN_PREVIEW_PX,
      SHEET_W: SHEET_W,
      CHAT_MIN: CHAT_MIN,
      CHAT_MAX: CHAT_MAX,
      PREVIEW_MIN: PREVIEW_MIN,
      SPLIT_MIN: SPLIT_MIN,
    }

    // Test surface for the panels. The browser half has no DOM in CI, but a
    // component that throws on render takes the whole dock down with it (that
    // is how a preview crash reads to the user: "the button is gone"), so the
    // components themselves are reachable and can be rendered with stub hooks.
    exports.__ui = {
      CvPane: CvPane,
      JobDock: JobDock,
      FitPanel: FitPanel,
      PostSurface: PostSurface,
      HistoryPanel: HistoryPanel,
      CommentPanel: CommentPanel,
    }

    // Test surface for the exported PDF's filename: the browser names the
    // download after the document title, and that name is what a recruiter
    // sees on the attachment.
    exports.__export = {
      exportFileName: exportFileName,
      candidateNameFrom: candidateNameFrom,
      fileSlug: fileSlug,
    }

    exports.__onboard = {
      buildStartMessage: buildStartMessage,
      intakeCv: intakeCv,
      upsertWorkspace: upsertWorkspace,
      readFileAsBase64: readFileAsBase64,
    }

    return module.exports
  },
})
