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
        if (!res.ok) throw new Error('doc fetch failed: ' + res.status)
        return res.json()
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
function CvPane(props) {
  useThemeTick()
  var pal = palette()
  var doc = props.doc
  var iframeRef = React.useRef(null)
  var starter = doc.version === 0
  var html = starter ? starterDoc() : doc.html

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

  // What the version chip says: the starter template, a live version, a
  // just-landed save, or a preview that has lost contact with the host.
  var statusText = starter ? 'starter template' : 'v' + doc.version
  var statusColor = pal.text
  if (!props.online) {
    statusText = starter ? 'host unreachable' : 'v' + doc.version + ' · host unreachable'
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
      createElement(
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
      ),
    ),
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
        },
      },
      createElement('iframe', {
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
        },
      }),
    ),
    // reopen affordance lives in the dock, not here
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
      pane.style.position = 'absolute'
      pane.style.top = '0'
      pane.style.bottom = '0'
      pane.style.left = '0'
      pane.style.right = CHAT_W + 'px'
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
      applyTransform()
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
      })
      observer.observe(col, { childList: true, attributes: true, attributeFilter: ['style'] })

      return function () {
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
function JobDock(props) {
  useThemeTick()
  var pal = palette()
  var sessionId = props.sessionId
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
  var onlineState = React.useState(true)
  var online = onlineState[0]
  var setOnline = onlineState[1]
  var flashState = React.useState(false)
  var flash = flashState[0]
  var setFlash = flashState[1]

  function setOpen(v) {
    savePrefs(sessionId, { open: v })
    setOpenState(v)
    if (!v) setFullScreenState(false)
  }

  // Poll the host document while Job mode is active; the agent saves a
  // new version and the preview follows within a poll interval.
  React.useEffect(
    function () {
      if (!active) return undefined
      var stopped = false
      var seenVersion = -1
      var flashTimer = null
      function pull() {
        fetchDoc(sessionId)
          .then(function (next) {
            if (stopped) return
            setOnline(true)
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
          })
          .catch(function () {
            if (!stopped) setOnline(false)
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
          title: doc.jobUrl || 'No job post link yet — paste it in the chat',
          style: {
            maxWidth: 300,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        },
        doc.jobUrl || 'paste the job post link + your CV in the chat',
      ),
      createElement('span', { style: { flex: 1 } }),
      !online
        ? createElement(
            'span',
            {
              title: 'The plugin host is not answering — restart `dsh web`',
              style: { fontSize: 11, color: pal.dark ? '#ffb4a2' : '#b3261e' },
            },
            'host unreachable',
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
    createElement(JobLayout, {
      active: active,
      open: open,
      doc: doc,
      online: online,
      flash: flash,
      fullScreen: fullScreen,
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

    return module.exports
  },
})
