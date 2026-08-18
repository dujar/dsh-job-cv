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
