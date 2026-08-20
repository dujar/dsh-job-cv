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
  // The latest document, always — the working state's floor re-check below
  // reads it, because a landed save may never produce the next frame.
  var docRef = React.useRef(doc)
  docRef.current = doc
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

  // Hover is how a mouse asks for the preview, and a finger has no hover —
  // iOS Safari does not even focus a button on tap, so the chips were dead
  // on a phone and Open lived inside a popover nothing could open. On a
  // touch device a tap toggles the same popover instead.
  var touchCoarse = false
  try {
    touchCoarse =
      typeof window !== 'undefined' &&
      !!window.matchMedia &&
      window.matchMedia('(pointer: coarse)').matches
  } catch (e) {
    touchCoarse = false
  }
  function tapFile(e, f) {
    if (preview !== null && preview.name === f.name) {
      clearTimeout(previewTimer.current)
      // Bump the token so an in-flight fetch for this file cannot resurrect
      // the popover the tap just closed.
      previewSeq.current += 1
      setPreview(null)
      return
    }
    enterFile(e, f)
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
      // Nothing landed in time: without a bound the badge would ride a dead
      // request forever.
      var giveUp = setTimeout(function () {
        setWorkingFrom(null)
      }, WORK_GIVE_UP_MS)
      // The stream pushes a frame when a save lands and then goes quiet, and
      // re-running workingDone on every frame is exactly what the poll used
      // to do — without a later frame, a FAST answer kept the working state
      // (badge + blur) past its own min-visible floor, up to the give-up
      // above. One check, once the floor has passed, against the latest
      // document: it clears the state if the work landed, and is a no-op if
      // nothing did. A SLOW answer needs none of this — its landing frame
      // already finds the floor passed and clears it on the spot.
      var floorMs = Math.max(
        0,
        WORKING_MIN_VISIBLE_MS - (Date.now() - (workingFrom.startedAt || 0)),
      )
      var floor = setTimeout(function () {
        setWorkingFrom(function (from) {
          return from === workingFrom ? workingDone(from, docRef.current) : from
        })
      }, floorMs)
      return function () {
        clearTimeout(giveUp)
        clearTimeout(floor)
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
      function apply(next) {
        if (stopped) return
        setOnline(true)
        setOfflineWhy(null)
        setDoc(function (prev) {
          return sameDoc(next, prev) ? prev : next
        })
        // Announce a genuinely new save, but not the first sight of an
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
      }
      function fail(error) {
        if (stopped) return
        setOnline(false)
        setOfflineWhy(offlineReason(error))
      }
      function pull() {
        fetchDoc(sessionId).then(apply).catch(fail)
      }

      // The document arrives two ways. /jobcv/stream pushes it the moment a
      // save lands — the agent writes and the preview moves, with none of the
      // up-to-2.5s lag a poll leaves. The poll stays as the fallback, because
      // an EventSource reports failure without a status: only fetchDoc can
      // tell "the host is gone" from the 403 the trust gate returns when the
      // GUI is opened on a LAN address, which is the diagnostic the user acts
      // on. So polling starts immediately and stops at the first frame that
      // proves the stream works, and any stream error starts it again.
      var timer = null
      function startPolling() {
        if (timer === null) timer = setInterval(pull, 2500)
      }
      function stopPolling() {
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }
      pull()
      startPolling()
      var stream = null
      if (typeof EventSource === 'function') {
        try {
          stream = new EventSource('/jobcv/stream?session=' + encodeURIComponent(sessionId))
          stream.onmessage = function (event) {
            var next = null
            try {
              next = JSON.parse(event.data)
            } catch (e) {
              return // a malformed frame is skipped; the next one is whole
            }
            stopPolling()
            apply(next)
          }
          stream.onerror = function () {
            // EventSource reconnects on its own; polling covers the gap and
            // the next frame to arrive stops it again.
            startPolling()
          }
        } catch (e) {
          stream = null // no stream, and the poll is already running
        }
      }
      function onVisible() {
        if (document.visibilityState === 'visible') pull()
      }
      document.addEventListener('visibilitychange', onVisible)
      return function () {
        stopped = true
        stopPolling()
        if (stream !== null) stream.close()
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
                      // Touch only: on a mouse the click would keep the popover
                      // pinned after the cursor has left, which the hover flow
                      // already does better.
                      onClick: touchCoarse
                        ? function (e) {
                            tapFile(e, f)
                          }
                        : undefined,
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
