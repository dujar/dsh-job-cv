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
function useSplitPane(col, enabled, pal) {
  var hostState = React.useState(null)
  var host = hostState[0]
  var setHost = hostState[1]
  var paneRef = React.useRef(null)

  React.useLayoutEffect(
    function () {
      if (!enabled || !col) return undefined

      var prev = {
        position: col.style.position,
        paddingLeft: col.style.paddingLeft,
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
          var previewW = Math.max(0, Math.round(rect.width - chatWidthFor(rect.width)))
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
        if (pane.parentElement) pane.parentElement.removeChild(pane)
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
  var host = useSplitPane(col, showing && !asOverlay, pal)

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
