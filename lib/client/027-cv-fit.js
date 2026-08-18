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

/** Score bands. Colour carries the verdict at a glance; the text carries it properly. */
function fitBand(score) {
  if (score >= 75) return { key: 'strong', light: '#1e7a3c', dark: '#7ddb9b', label: 'strong' }
  if (score >= 50) return { key: 'partial', light: '#8a5a00', dark: '#f0c274', label: 'partial' }
  return { key: 'thin', light: '#b3261e', dark: '#ffb4a2', label: 'thin' }
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
    'Read the stored post (GET /jobcv/post) and my CV as they stand, then POST the assessment to /jobcv/fit: the percentage, a one-line verdict of what actually decides this application, the gaps — each with a severity and the move that would close it — and the strengths with the line in my CV that evidences each one.',
    'Score the evidence against the requirements, not the vocabulary. Where closing a gap needs a fact you do not have, make the fix a question to me rather than a number you invented.',
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
                { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                chip(gap.severity),
                createElement(
                  'span',
                  { style: { fontSize: 12, color: pal.textStrong, fontWeight: 600, flex: 1 } },
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
                { key: index },
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

/** Paint the gap convention into the post document, once per load. */
function injectPostGapCss(frame) {
  try {
    var doc = frame && frame.contentDocument
    if (!doc || !doc.head) return
    if (doc.getElementById('dsh-job-cv-post-gap')) return
    var style = doc.createElement('style')
    style.id = 'dsh-job-cv-post-gap'
    style.textContent = POST_GAP_CSS
    doc.head.appendChild(style)
  } catch (e) {
    /* the marks stay unstyled; the document still reads */
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
  var editingState = React.useState(false)
  var editing = editingState[0]
  var setEditing = editingState[1]
  var draftState = React.useState('')
  var draft = draftState[0]
  var setDraft = draftState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var errorState = React.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var postFrameRef = React.useRef(null)

  var text = post && typeof post.text === 'string' ? post.text : ''
  var page = post && typeof post.html === 'string' && post.html !== '' ? post.html : ''
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
      style: {
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        display: 'flex',
        justifyContent: 'center',
        padding: '14px 10px',
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
        !editing && !empty
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
      !editing && page !== ''
        ? createElement('iframe', {
            key: post.htmlUpdatedAt || post.updatedAt,
            ref: postFrameRef,
            srcDoc: page,
            title: 'Job post',
            sandbox: 'allow-same-origin allow-modals',
            onLoad: function () {
              // The red convention is painted by the PARENT, not by whatever
              // stylesheet the agent wrote — one place, one definition. The
              // page deck comes before the height measurement, same as the CV.
              injectPostGapCss(postFrameRef.current)
              injectPageDeck(postFrameRef.current, pal)
              try {
                var frame = postFrameRef.current
                var body = frame && frame.contentDocument && frame.contentDocument.body
                if (frame && body) frame.style.height = Math.max(body.scrollHeight, 1123) + 'px'
              } catch (e) {
                /* keep minHeight */
              }
            },
            style: {
              // True A4 for the posting page too — same reasoning as the CV.
              width: '210mm',
              maxWidth: 'none',
              margin: '0 auto',
              height: 'fit-content',
              minHeight: '297mm',
              flex: 'none',
              background: '#fff',
              border: '1px solid ' + pal.panelBorder,
              borderRadius: 3,
              boxShadow: pal.dark ? '0 2px 14px rgba(0,0,0,0.45)' : '0 2px 14px rgba(0,0,0,0.13)',
            },
          })
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
