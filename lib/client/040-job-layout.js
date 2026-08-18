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
