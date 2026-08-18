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
      // Standard-kit composer actions: how a comment on the CV reaches chat.
      inputActions: props.inputActions,
      sessionId: sessionId,
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
