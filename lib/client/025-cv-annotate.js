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
// A .page division with nothing on it still draws a full A4 sheet — and
// prints a blank page into the exported PDF. That is what the user sees: a
// one-page CV that arrives as two, the second one empty.
//
// What counts as content errs hard toward SHOWING the page. A false blank
// would delete part of the document, while a false keep is only the status
// quo — so anything that draws holds a page open: an image, a signature, a
// rule, a table, a decorative background. Only a page with no words and
// nothing drawn on it is dropped.
var PAGE_DRAWS =
  'img,svg,canvas,video,picture,object,embed,iframe,hr,table,input,textarea,[style*="background"]'

function isBlankPage(el) {
  try {
    if (!el) return false
    var text = el.textContent === undefined || el.textContent === null ? '' : el.textContent
    if (String(text).trim() !== '') return false
    // The element can BE the thing that draws. A sheet is a div and never is,
    // but a stray <img> or <hr> standing beside the sheets has no descendants
    // to find itself in — and hiding one would delete it from the document.
    if (el.matches && el.matches(PAGE_DRAWS)) return false
    return !(el.querySelector && el.querySelector(PAGE_DRAWS))
  } catch (e) {
    // Unreadable is not blank: leaving the page alone is the safe direction.
    return false
  }
}

/**
 * Mark everything that would print as a blank sheet.
 *
 * A .page division is a sheet, and anything sitting BETWEEN or AFTER the
 * sheets is on none of them — the preview does not draw it as paper, so it
 * is invisible against the desk. Print does not have a desk: a stray <br>
 * or an empty spacer div after the last page still takes up space, and that
 * is enough to push a whole blank page into the exported PDF. It is the
 * reason the preview can show the right number of pages and the PDF still
 * come out one too long.
 *
 * One pass over the sheets and their siblings, the same blank test for
 * both. A wrapper that HOLDS sheets is structure, not a stray.
 */
function markBlankSheets(doc, pageEls) {
  var parents = doc.body ? [doc.body] : []
  for (var i = 0; i < pageEls.length; i++) {
    var parent = pageEls[i].parentNode
    if (parent && parent.nodeType === 1 && parents.indexOf(parent) === -1) parents.push(parent)
  }
  for (var p = 0; p < parents.length; p++) {
    var kids = parents[p].children || []
    for (var k = 0; k < kids.length; k++) {
      var kid = kids[k]
      if (kid.querySelector && kid.querySelector('.page')) continue
      // Re-decided every time rather than remembered: a save that filled the
      // page in takes the mark straight back off.
      if (isBlankPage(kid)) kid.setAttribute('data-dsh-job-cv-blank', '')
      else kid.removeAttribute('data-dsh-job-cv-blank')
    }
  }
}

var A4_MM = 297

/**
 * How far each sheet runs past A4, in millimetres.
 *
 * A .page taller than the paper does not only lose its own tail. The
 * overflow pushes everything after it down by that much, so the next sheet
 * starts partway down a printed page and the last few millimetres of the
 * document land on a page of their own. ONE page 17mm too long is what
 * turns a two-page CV into a three-page PDF with a list broken across the
 * break — and the preview cannot show it, because on screen a sheet simply
 * grows.
 *
 * Measured against a probe rather than a constant: 297mm is whatever the
 * document's own layout makes it, and comparing rendered pixels to a
 * hand-computed 96dpi figure is how a rounding error becomes a false
 * warning on every page.
 */
function pageOverflows(doc) {
  var out = []
  try {
    if (!doc || !doc.body) return out
    var probe = doc.createElement('div')
    probe.setAttribute('style', 'position:absolute;left:-9999px;top:0;width:1px;height:297mm')
    doc.body.appendChild(probe)
    var a4 = probe.getBoundingClientRect().height
    if (probe.parentNode) probe.parentNode.removeChild(probe)
    if (!(a4 > 0)) return out
    var pages = doc.querySelectorAll('.page')
    var ordinal = 0
    for (var i = 0; i < pages.length; i++) {
      // A sheet that does not print cannot overflow, and it does not take a
      // page number either.
      if (pages[i].hasAttribute && pages[i].hasAttribute('data-dsh-job-cv-blank')) continue
      ordinal += 1
      var over = pages[i].getBoundingClientRect().height - a4
      var mm = Math.round((over / a4) * A4_MM)
      // Under a millimetre is layout rounding, not a page that will break.
      if (mm >= 1) out.push({ page: ordinal, over: mm, el: pages[i] })
    }
  } catch (e) {
    /* the warning is a nicety; the document still renders */
  }
  return out
}

/**
 * Everything the printed page needs decided: which sheets are blank, which
 * start on fresh paper, and which run past A4.
 *
 * The break matters as much as the blank. A .page division MEANS a sheet of
 * paper, so every one after the first starts on a new one — without that, a
 * single overflowing page shifts every page below it and the document prints
 * out of register from that point on, which is what "it broke my formatting"
 * looks like. With it, an overflow costs its own page and nothing else moves.
 */
function markSheets(doc, pageEls) {
  markBlankSheets(doc, pageEls)
  var first = true
  for (var i = 0; i < pageEls.length; i++) {
    var el = pageEls[i]
    if (el.hasAttribute && el.hasAttribute('data-dsh-job-cv-blank')) continue
    if (first) {
      el.removeAttribute('data-dsh-job-cv-break')
      first = false
    } else {
      el.setAttribute('data-dsh-job-cv-break', '')
    }
  }
  for (var j = 0; j < pageEls.length; j++) pageEls[j].removeAttribute('data-dsh-job-cv-over')
  var overs = pageOverflows(doc)
  for (var k = 0; k < overs.length; k++) {
    overs[k].el.setAttribute('data-dsh-job-cv-over', String(overs[k].over))
  }
  return overs
}

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
  // Deliberately in EVERY medium: a sheet the preview drops has to be a page
  // the PDF does not print, or the two are disagreeing again — which is the
  // one thing this deck exists to prevent. injectPageDeck decides which
  // pages wear the mark.
  // Unqualified on purpose: it hides a blank .page AND the stray between the
  // sheets, which is the one the preview cannot show you.
  var blankFix = '[data-dsh-job-cv-blank]{display:none!important}'
  // A .page division means a sheet of paper. Making every one after the first
  // start on fresh paper is what stops a single overflowing page shifting
  // everything below it out of register for the rest of the document.
  var breakFix =
    '@media print{[data-dsh-job-cv-break]{break-before:page!important;' +
    'page-break-before:always!important}}'
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
      // The sheet that will break: its A4 boundary goes red, and the sheet
      // wears a red edge, so the page that costs the extra sheet is the one
      // that looks wrong. Same screen block — opening a second one here is
      // how the closing brace below stopped closing anything.
      '.page[data-dsh-job-cv-over]{' +
      'background-image:repeating-linear-gradient(to bottom,' +
      'transparent 0,transparent calc(297mm - 2px),' +
      'rgba(211,47,47,.9) calc(297mm - 2px),rgba(211,47,47,.9) 297mm)!important;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.16),0 0 0 2px rgba(211,47,47,.5)!important}' +
      '}' +
      printFix +
      blankFix +
      breakFix
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
    printFix +
    blankFix +
    breakFix
  )
}

/**
 * Pick a part of the document with a FINGER.
 *
 * Comment mode was mouse-only — mousedown, mousemove, mouseup. A phone
 * synthesizes those from a tap only sometimes: iOS Safari does it for
 * elements it considers clickable and not for a paragraph inside a frame,
 * so tapping a line of the CV did nothing at all and there was no way to
 * comment on a phone. Touch is handled directly instead, which is the same
 * lesson attachSwipe already learned about this iframe.
 *
 * A tap picks one part. Dragging a RANGE stays a mouse affordance: on a
 * phone a drag is how you scroll, and taking that away would trap the
 * reader on the first screen of their own CV. Several parts are still one
 * batch — tap, write, Add, tap the next.
 */
var TAP_SLOP = 10

function attachTouchPicking(idoc, root, onPick) {
  var start = null
  function onStart(e) {
    var t = e.touches && e.touches[0]
    start = t ? { x: t.clientX, y: t.clientY, target: e.target } : null
  }
  function forget() {
    start = null
  }
  function onEnd(e) {
    var from = start
    start = null
    if (!from) return
    var t = e.changedTouches && e.changedTouches[0]
    if (!t) return
    // A tap, not a scroll: the finger has to have stayed put.
    if (Math.abs(t.clientX - from.x) > TAP_SLOP || Math.abs(t.clientY - from.y) > TAP_SLOP) return
    var el = pickableFrom(from.target, root)
    if (!el) return
    // Stop the browser making a mouse sequence out of this tap where it
    // would have: the mouse path would then pick the same part again.
    if (e.cancelable) e.preventDefault()
    onPick(el)
  }
  root.addEventListener('touchstart', onStart, true)
  idoc.addEventListener('touchend', onEnd, true)
  idoc.addEventListener('touchcancel', forget, true)
  return function () {
    try {
      root.removeEventListener('touchstart', onStart, true)
      idoc.removeEventListener('touchend', onEnd, true)
      idoc.removeEventListener('touchcancel', forget, true)
    } catch (e) {
      /* the frame is already gone */
    }
  }
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
      // Comment mode owns the finger while it is on (a swipe would switch
      // tabs and drop the notes marked on this document), and so does edit
      // mode (it would drop unsaved words). Each mode's style tag exists
      // only while that mode does, so it is the flag — same as the link
      // interceptor in injectPageDeck.
      if (doc.getElementById(ANNOTATE_STYLE_ID) || doc.getElementById(EDIT_STYLE_ID)) {
        start = null
        return
      }
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
    if (!doc || !doc.head) return []
    var style = doc.getElementById('dsh-job-cv-pages')
    if (!style) {
      style = doc.createElement('style')
      style.id = 'dsh-job-cv-pages'
      doc.head.appendChild(style)
    }
    var pageEls = doc.querySelectorAll('.page')
    style.textContent = pageDeckCss(pageEls.length > 0, pal)
    var overs = pageEls.length > 0 ? markSheets(doc, pageEls) : []
    // Second defense against mobile font boosting — the text-size-adjust pin
    // in pageDeckCss is the first. Declaring a viewport stops the browser
    // treating the fixed-width A4 document as a zoomed-out desktop page, so
    // it never inflates the type and re-wraps the content. Leave an existing
    // one alone: the document may already say what it wants.
    if (!doc.querySelector('meta[name="viewport"]')) {
      var viewport = doc.createElement('meta')
      viewport.name = 'viewport'
      viewport.content = 'width=device-width, initial-scale=1'
      // Marked as ours, so a hand edit saved back out drops exactly the one
      // the deck added and keeps one the document declared itself.
      viewport.setAttribute('data-dsh-job-cv-viewport', '')
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
          // Comment mode owns every click while it is on, and edit mode
          // owns every click while IT is on — a click in an editable document
          // places the caret, it does not follow the link. Each mode's style
          // tag exists only while that mode does, so it is the flag.
          if (doc.getElementById(ANNOTATE_STYLE_ID)) return
          if (doc.getElementById(EDIT_STYLE_ID)) return
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
    return overs
  } catch (e) {
    /* the document still reads; the deck is decoration */
    return []
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
/**
 * Ask the agent to make the document fit the paper it prints on.
 *
 * Names the page and the millimetres, because "it is too long" is not
 * actionable and "page 1 runs 17mm past A4" is — and says what NOT to do,
 * since the cheap way to make a page fit is to shrink the type until it is
 * unreadable, or to cut the evidence that was doing the work.
 */
function buildOverflowRequest(overs, doc, what) {
  var lines = overs.map(function (o) {
    return '  - page ' + o.page + ' runs ' + o.over + 'mm past the bottom of A4'
  })
  return ['My ' + what + ' does not fit the pages it is laid out in:', '']
    .concat(lines)
    .concat([
      '',
      'Each <div class="page"> has to fit inside 297mm INCLUDING its padding.',
      'Right now the overflow pushes every page below it down, so the PDF',
      'comes out with an extra sheet and a section broken across the break.',
      '',
      'Fix it by moving content to the next page or tightening the writing —',
      'not by shrinking the type until it is hard to read, and not by cutting',
      'the numbers and evidence that make the case. If the material genuinely',
      'needs another page, say so and lay out a full one rather than letting',
      'it spill.',
      '',
      'Save the corrected document (' +
        (what === 'cover letter' ? 'POST /jobcv/letter' : 'POST /jobcv/doc') +
        ') with a note saying what you moved.',
    ])
    .join('\n')
}

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
