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
    var via = sendToComposer(props.inputActions, message)
    setSent(
      via === null
        ? 'could not reach the composer — nothing was sent'
        : via === 'clipboard'
          ? 'copied to the clipboard — paste it into the chat'
          : 'sent to the chat — press enter to run it',
    )
    if (via !== null) {
      setNotes([])
      setPicked(null)
      setDraft('')
      pickedElRef.current = null
      setAnnotating(false)
    }
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
      createElement(
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
      ),
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
        },
      }),
    ),
    // reopen affordance lives in the dock, not here
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
            ? 'Click any line, bullet or heading in the CV below to mark it.'
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
            picked.section ? 'In “' + picked.section + '”' : 'Selected',
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
