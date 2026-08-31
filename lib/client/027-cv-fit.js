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

/**
 * Score bands — the SAME boundaries the contract calibrates the agent to, so
 * the number means one thing across every application in the tracker. Colour
 * carries the verdict at a glance; the text carries it properly.
 *   80+  clears the screen, the interview turns on depth
 *   60+  clears it with one framing risk
 *   40+  a real gap the screen may filter on
 *   <40  the wrong role or level
 */
function fitBand(score) {
  if (score >= 80)
    return { key: 'strong', light: '#1e7a3c', dark: '#7ddb9b', label: 'clears the screen' }
  if (score >= 60)
    return { key: 'solid', light: '#3d7a1e', dark: '#bfe08a', label: 'one framing risk' }
  if (score >= 40) return { key: 'partial', light: '#8a5a00', dark: '#f0c274', label: 'a real gap' }
  return { key: 'thin', light: '#b3261e', dark: '#ffb4a2', label: 'wrong role or level' }
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
    'Read the stored post (GET /jobcv/post) and my CV as they stand, then POST the assessment to /jobcv/fit: the percentage, a one-line verdict of what actually decides this application, "decidedBy" (stack-fit | level | domain | evidence-depth | logistics), a "levelRead" {supports, targets, gap} when the level is in question, the gaps — each with a severity, a "kind" (rewrite | supply-fact | prepare-story | structural) and the move that would close it — and the strengths, each with the CV line that evidences it and a "strength" grade (proven | claimed | adjacent).',
    'Score the evidence against the requirements, not the vocabulary. Use the bands: 80–100 clears the screen and the interview turns on depth; 60–79 clears it with one framing risk; 40–59 a real gap the screen may filter; below 40 the wrong role or level. Where closing a gap needs a fact you do not have, make the fix a question to me rather than a number you invented.',
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

  // A muted secondary tag — the gap's kind, or a strength's grade.
  function tag(label) {
    return createElement(
      'span',
      {
        style: {
          border: '1px solid ' + pal.controlBorder,
          color: pal.text,
          borderRadius: 4,
          padding: '0 5px',
          fontSize: 10,
          lineHeight: '15px',
          letterSpacing: 0.3,
          flex: 'none',
        },
      },
      label,
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
    // ---- what the score turns on: a stack miss and a level miss are not the
    // same 55 ----
    fit.decidedBy || fit.levelRead
      ? createElement(
          'div',
          {
            style: {
              fontSize: 11,
              color: pal.text,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            },
          },
          fit.decidedBy
            ? createElement(
                'div',
                null,
                createElement(
                  'span',
                  { style: { color: pal.textStrong, fontWeight: 600 } },
                  'Decided by: ',
                ),
                fit.decidedBy.replace('-', ' '),
              )
            : null,
          fit.levelRead
            ? createElement(
                'div',
                null,
                createElement(
                  'span',
                  { style: { color: pal.textStrong, fontWeight: 600 } },
                  'Level: ',
                ),
                (fit.levelRead.supports || '?') +
                  ' evidenced, ' +
                  (fit.levelRead.targets || '?') +
                  ' targeted' +
                  (fit.levelRead.gap ? ' — ' + fit.levelRead.gap : ''),
              )
            : null,
        )
      : null,
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
                'data-gap-id': gap.id || undefined,
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
                { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } },
                chip(gap.severity),
                gap.kind ? tag(gap.kind) : null,
                createElement(
                  'span',
                  {
                    style: {
                      fontSize: 12,
                      color: pal.textStrong,
                      fontWeight: 600,
                      flex: 1,
                      minWidth: 120,
                    },
                  },
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
                {
                  key: index,
                  style: { display: 'flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' },
                },
                item.strength ? tag(item.strength) : null,
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

/**
 * The callout a tap (or click) opens on a gap mark.
 *
 * What is missing lives in the mark's title attribute, and a title is a
 * hover tooltip — on a phone there is no hover, so the red marks were the
 * whole message and the explanation was unreachable. The callout is the
 * attribute itself, rendered as a small dark box under the mark. Screen-only
 * by construction: it must never print. The sheet is white in both themes,
 * so one look serves both.
 */
var GAP_OPEN_CSS = [
  '@media screen{',
  '.dsh-gap-open{position:relative}',
  '.dsh-gap-open::after{content:attr(title);position:absolute;left:0;top:calc(100% + 2px);',
  'z-index:20;background:#22252b;color:#fff;font:600 10px/1.4 system-ui,sans-serif;',
  'padding:4px 7px;border-radius:4px;max-width:52mm;white-space:normal;',
  'box-shadow:0 2px 8px rgba(0,0,0,.28);pointer-events:none}',
  '}',
].join('')

/** Paint the gap convention into the post document, once per load. */
function injectPostGapCss(frame) {
  try {
    var doc = frame && frame.contentDocument
    if (!doc || !doc.head) return
    if (doc.getElementById('dsh-job-cv-post-gap')) return
    var style = doc.createElement('style')
    style.id = 'dsh-job-cv-post-gap'
    style.textContent = POST_GAP_CSS + '\n' + GAP_OPEN_CSS
    doc.head.appendChild(style)
  } catch (e) {
    /* the marks stay unstyled; the document still reads */
  }
}

/**
 * Tap a gap mark to see what is missing.
 *
 * Same mechanics as comment picking: the post frame runs no scripts but is
 * same-origin, so the parent attaches the listeners. One callout at a time;
 * tapping the mark again, tapping anywhere else, or scrolling closes it. On
 * a touch device a drag is a scroll and never opens a callout — the same
 * tap-vs-slop rule attachTouchPicking uses. The mark's own title still works
 * for mice; a click opens the same callout, so the explanation is one
 * gesture everywhere.
 */
function attachGapTaps(doc, coarse) {
  try {
    if (!doc || !doc.body || doc.body.hasAttribute('data-dsh-job-cv-gap-taps')) {
      return function () {}
    }
    doc.body.setAttribute('data-dsh-job-cv-gap-taps', '')
    // A stale open class would paint a permanent callout — e.g. one that was
    // open when a hand edit saved the document. Each load starts clean.
    var stale = doc.querySelectorAll('.dsh-gap-open')
    for (var si = 0; si < stale.length; si++) stale[si].classList.remove('dsh-gap-open')
    var open = null
    var removers = []
    function closeAll() {
      if (open !== null) {
        try {
          open.classList.remove('dsh-gap-open')
        } catch (e) {
          /* the mark is gone; the class went with it */
        }
        open = null
      }
    }
    function toggle(mark) {
      if (open === mark) {
        closeAll()
        return
      }
      closeAll()
      open = mark
      mark.classList.add('dsh-gap-open')
    }
    function markFrom(el) {
      return el && el.closest ? el.closest('.dsh-gap') : null
    }
    // Edit mode owns the finger (and the pointer) while it is on: a callout
    // under a caret being placed is noise. The edit style tag exists only
    // while editing, so it is the flag — same convention as the swipe.
    function owned() {
      return doc.getElementById('dsh-job-cv-edit') !== null
    }
    function onScroll() {
      closeAll()
    }
    doc.addEventListener('scroll', onScroll, true)
    removers.push(function () {
      doc.removeEventListener('scroll', onScroll, true)
    })
    if (coarse) {
      var start = null
      function onStart(e) {
        var t = e.touches && e.touches[0]
        start = t ? { x: t.clientX, y: t.clientY, target: e.target } : null
      }
      function onEnd(e) {
        var from = start
        start = null
        if (!from) return
        var t = e.changedTouches && e.changedTouches[0]
        if (!t) return
        if (Math.abs(t.clientX - from.x) > TAP_SLOP || Math.abs(t.clientY - from.y) > TAP_SLOP) {
          closeAll()
          return
        }
        if (owned()) {
          closeAll()
          return
        }
        var mark = markFrom(from.target)
        if (mark) {
          // Stop a synthesized click from toggling the mark straight back
          // off again, on browsers that make one.
          if (e.cancelable) e.preventDefault()
          toggle(mark)
        } else {
          closeAll()
        }
      }
      doc.addEventListener('touchstart', onStart, true)
      doc.addEventListener('touchend', onEnd, true)
      doc.addEventListener(
        'touchcancel',
        function () {
          start = null
        },
        true,
      )
      removers.push(function () {
        doc.removeEventListener('touchstart', onStart, true)
        doc.removeEventListener('touchend', onEnd, true)
      })
    } else {
      function onClick(e) {
        if (owned()) {
          closeAll()
          return
        }
        var mark = markFrom(e.target)
        if (mark) toggle(mark)
        else closeAll()
      }
      doc.addEventListener('click', onClick, true)
      removers.push(function () {
        doc.removeEventListener('click', onClick, true)
      })
    }
    return function () {
      closeAll()
      for (var r = 0; r < removers.length; r++) {
        try {
          removers[r]()
        } catch (e) {
          /* the frame is already gone */
        }
      }
    }
  } catch (e) {
    /* the marks stay red and silent, as they were */
    return function () {}
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
  // The raw-text editor is CONTROLLED by the pane: the preview toolbar's
  // Edit opens it for a posting that has no page to type into yet, so the
  // state cannot live down here.
  var editing = props.editingText === true
  var setEditing = typeof props.onEditingText === 'function' ? props.onEditingText : function () {}
  var draftState = React.useState('')
  var draft = draftState[0]
  var setDraft = draftState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var errorState = React.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var ownFrameRef = React.useRef(null)
  // Edit mode drives whichever frame is showing, so the pane hands its own
  // ref down rather than reaching into this component for one.
  var postFrameRef = props.pageFrameRef || ownFrameRef
  // The same scaled-sheet machinery as the CV: the container width drives
  // the factor, the measured page height drives the wrapper height.
  var postSurfaceRef = React.useRef(null)
  var postScale = useSheetScale(postSurfaceRef)
  var postFrameHState = React.useState(1123)
  var postFrameH = postFrameHState[0]
  var setPostFrameH = postFrameHState[1]

  // The page is only frozen while it is being edited in place (or held on a
  // save just made), and typing makes the document taller — the frame is a
  // fixed height sized to what it loaded with, so it has to keep up or the
  // new lines fall off the bottom of it.
  React.useEffect(
    function () {
      if (!props.frozenPage) return undefined
      var frame = postFrameRef.current
      var idoc = null
      try {
        idoc = frame && frame.contentDocument
      } catch (e) {
        idoc = null
      }
      if (!idoc || !idoc.body) return undefined
      function remeasure() {
        try {
          setPostFrameH(Math.max(idoc.body.scrollHeight, 1123))
        } catch (e) {
          /* keep the floor */
        }
      }
      idoc.addEventListener('input', remeasure, true)
      return function () {
        try {
          idoc.removeEventListener('input', remeasure, true)
        } catch (e) {
          /* the frame is already gone */
        }
      }
    },
    [props.frozenPage],
  )

  var text = post && typeof post.text === 'string' ? post.text : ''
  var page = post && typeof post.html === 'string' && post.html !== '' ? post.html : ''
  // While the page is being edited in place it renders from the snapshot the
  // edit started on, so a re-fetch cannot swap the document under the caret.
  var frozen = props.frozenPage || null
  // Scripts are stripped before the string reaches the frame: the sandbox
  // logs a blocked-execution error for each one it meets at parse time, and
  // the frame never gets allow-scripts anyway (see stripScriptTags).
  var pageHtml = frozen === null ? stripScriptTags(page) : stripScriptTags(frozen.html)
  var pageKey = frozen === null ? post && (post.htmlUpdatedAt || post.updatedAt) : frozen.key
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

  // A finger cannot hover, which is what the gap marks' explanation lived
  // on — the tap handler is attached on the touch path only, so a drag is a
  // scroll and a tap opens the callout.
  var touchCoarse = false
  try {
    touchCoarse =
      typeof window !== 'undefined' &&
      !!window.matchMedia &&
      window.matchMedia('(pointer: coarse)').matches
  } catch (e) {
    touchCoarse = false
  }

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
        // Same rule as the CV surface: a scroll past the end stays here
        // instead of chaining into the page behind the pane.
        overscrollBehavior: 'contain',
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
        !editing && !empty && frozen === null
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
      !editing && pageHtml !== ''
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
              key: pageKey,
              ref: postFrameRef,
              srcDoc: pageHtml,
              title: 'Job post',
              sandbox: 'allow-same-origin allow-modals',
              onLoad: function () {
                // The red convention is painted by the PARENT, not by whatever
                // stylesheet the agent wrote — one place, one definition. The
                // page deck comes before the height measurement, same as the CV.
                injectPostGapCss(postFrameRef.current)
                injectPageDeck(postFrameRef.current, pal)
                // Tap a mark to read what is missing: on a phone there is no
                // hover, and the explanation lived in a title tooltip.
                attachGapTaps(postFrameRef.current, touchCoarse)
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
