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
  // A historical version being LOOKED AT. Declared before anything derives
  // from it: `var` hoists, so reading it above this line yields undefined —
  // and `undefined !== null` is true, which previously made the pane believe
  // it was showing a version it did not have and crash on its html.
  var lookingState = React.useState(null)
  var looking = lookingState[0]
  var setLooking = lookingState[1]

  // Which of the two documents is on screen. The letter is a second
  // document, not a section of the CV: its own version line, its own file.
  var viewState = React.useState('cv')
  var view = doc.letter ? viewState[0] : 'cv'
  var setView = viewState[1]
  var showingLetter = view === 'letter' && doc.letter
  // Truthiness, not a null test: only an actual {version, html} shows one.
  var showingOld = !!(looking && looking.html) && !showingLetter
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
