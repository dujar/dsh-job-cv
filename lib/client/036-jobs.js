// ------------------------- jobs list: pick a posting, switch between them -------------------------
// The second onboarding path, and the switcher it grows into. A markdown
// file of postings (one job per line, a link each) is parsed once by the
// host (POST /jobcv/joblist); the start form offers its lines as the pick
// list, and this panel keeps the list around for the rest of the session:
// clicking another line switches which job THIS session is working on.
//
// Switching is host-side (POST /jobcv/switch): the outgoing application is
// archived with its whole history and the incoming one takes over the
// session document, so every job keeps its own versions, letter, post and
// fit score. Nothing is overwritten; the preview simply swaps.

// Must stay in lockstep with lib/store/joblist.js urlMatchKey — the panel
// matches list lines against the host's stored candidacies on the MATCHING
// form of a URL (tracking dust AND sometimes-functional tokens like ?ref=
// are noise for identity), while stored links themselves keep the STORAGE
// form. test/joblist.test.mjs runs a fixture through both and fails when
// they drift.
var TRACKING_PARAMS = {
  gclid: 1,
  fbclid: 1,
  dclid: 1,
  msclkid: 1,
  twclid: 1,
  ttclid: 1,
  yclid: 1,
  li_fat_id: 1,
  trk: 1,
  trkinfo: 1,
  trk_info: 1,
  lid: 1,
  origin: 1,
  mc_cid: 1,
  mc_eid: 1,
  igshid: 1,
  spm: 1,
  _hsenc: 1,
  _hsmi: 1,
  mkt_tok: 1,
}
var MATCH_ONLY_PARAMS = { ref: 1 }

/** Two spellings of one posting are one job: compare without noise. */
function normJobUrl(url) {
  var raw = String(url === undefined || url === null ? '' : url)
    .trim()
    .replace(/\s+/g, ' ')
  var parsed
  try {
    parsed = new URL(raw)
  } catch (e) {
    return raw.replace(/#.*$/, '').replace(/\/+$/, '')
  }
  if (parsed.protocol === 'http:') parsed.protocol = 'https:'
  parsed.hostname = parsed.hostname.toLowerCase()
  parsed.hash = ''
  var drop = []
  parsed.searchParams.forEach(function (value, key) {
    var lower = key.toLowerCase()
    if (TRACKING_PARAMS[lower] || MATCH_ONLY_PARAMS[lower] || lower.lastIndexOf('utm_', 0) === 0) {
      drop.push(key)
    }
  })
  for (var i = 0; i < drop.length; i++) parsed.searchParams.delete(drop[i])
  var out = parsed.toString()
  if (out.charAt(out.length - 1) === '?') out = out.slice(0, -1)
  return out.replace(/\/+$/, '')
}

function usableJobList(body) {
  var safe = body && typeof body === 'object' ? body : {}
  var jobs = Array.isArray(safe.jobs) ? safe.jobs : []
  return {
    path: typeof safe.path === 'string' ? safe.path : '',
    cvPath: typeof safe.cvPath === 'string' ? safe.cvPath : '',
    updatedAt: Number(safe.updatedAt) || 0,
    jobs: jobs.filter(function (j) {
      return j !== null && typeof j === 'object' && typeof j.url === 'string' && j.url !== ''
    }),
  }
}

function fetchJobList(sessionId) {
  return fetch('/jobcv/joblist?session=' + encodeURIComponent(sessionId)).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok) {
        throw new Error((body && body.error) || 'jobs list fetch failed (' + res.status + ')')
      }
      return usableJobList(body)
    })
  })
}

function fetchCandidacies(sessionId) {
  return fetch('/jobcv/candidacies?session=' + encodeURIComponent(sessionId)).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok) {
        throw new Error((body && body.error) || 'candidacies fetch failed (' + res.status + ')')
      }
      return {
        candidacies: Array.isArray(body && body.candidacies) ? body.candidacies : [],
        active: body && body.active ? body.active : null,
      }
    })
  })
}

/**
 * Parse a markdown file into the pick list. Payload carries ONE of
 * {path}, {dataBase64 + filename} or {text}; cvPath rides along so the
 * next job started from this list can pre-fill it.
 */
function postJobList(sessionId, payload) {
  var body = Object.assign({ sessionId: sessionId }, payload)
  return fetch('/jobcv/joblist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (res) {
    return res.json().then(function (parsed) {
      if (!res.ok) {
        throw new Error((parsed && parsed.error) || 'jobs list parse failed (' + res.status + ')')
      }
      return parsed
    })
  })
}

/** Make another posting this session's active candidacy. */
function postSwitch(sessionId, payload) {
  return fetch('/jobcv/switch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ sessionId: sessionId }, payload)),
  }).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok) {
        throw new Error((body && body.error) || 'the switch failed (' + res.status + ')')
      }
      return body
    })
  })
}

/** The row's main line: the posting's title, or an honest fallback. */
function jobRowLabel(entry) {
  var title = entry && typeof entry.title === 'string' ? squish(entry.title) : ''
  if (title !== '') return title
  var url = entry && typeof entry.url === 'string' ? entry.url : ''
  try {
    var u = new URL(url)
    var parts = u.pathname.split('/').filter(function (p) {
      return p !== ''
    })
    var last = parts[parts.length - 1] || ''
    var derived = last.replace(/[-_]+/g, ' ').trim()
    return derived !== '' ? derived : u.hostname.replace(/^www\./, '')
  } catch (e) {
    return url === '' ? 'Untitled posting' : url
  }
}

/** A URL short enough for a row's subline. */
function shortUrl(url, max) {
  var text = String(url === undefined || url === null ? '' : url)
  var cap = max || 72
  return text.length <= cap ? text : text.slice(0, cap - 1) + '…'
}

/** The candidacy record of this session that matches a list line, if any. */
function findCandidacyFor(candidacies, url) {
  var want = normJobUrl(url)
  if (want === '' || !Array.isArray(candidacies)) return null
  for (var i = 0; i < candidacies.length; i++) {
    if (normJobUrl(candidacies[i] && candidacies[i].jobUrl) === want) return candidacies[i]
  }
  return null
}

/**
 * What a list line offers: 'active' (working on it now), 'resume' (this
 * session already worked on it — switching brings that work back), or
 * 'start' (never opened here).
 */
function jobsRowState(entry, candidacies) {
  var hit = findCandidacyFor(candidacies, entry && entry.url)
  if (hit === null || hit.started !== true) return 'start'
  return hit.active === true ? 'active' : 'resume'
}

/**
 * The chat message starting one line of the list hands to the agent. Unlike
 * the plain start message, the switch has ALREADY run host-side — saying so
 * stops the agent from switching again and, worse, from saving into whatever
 * candidacy happened to be active.
 */
function buildJobsStartMessage(job, cvPath, listPath, sessionId) {
  var lines = [
    'Start a new job application for me, picked from my jobs list.',
    '',
    'Job post link: ' + ((job && job.url) || ''),
    'My CV: ' + cvPath,
  ]
  var company = job && typeof job.company === 'string' ? squish(job.company) : ''
  if (company !== '') lines.push('Company: ' + company)
  if (listPath) lines.push('Jobs list file: ' + listPath)
  lines.push('Session id: ' + sessionId + '  (use this exact string in every /jobcv call)')
  lines.push('')
  lines.push(
    'This session is already switched to this job (POST /jobcv/switch ran), so do',
    'NOT switch again. Open the candidacy workspace for it (POST /jobcv/workspace',
    'with the company name and job id from the post). If the upsert answers',
    'created:false I worked this posting before, maybe in another session — then',
    'read cv/latest.html from that folder FIRST and continue from there instead',
    'of starting over. Otherwise read my CV at the path above, tailor it against',
    'the job post, save through POST /jobcv/doc (include this jobUrl), and tell',
    'me what you changed.',
  )
  return lines.join('\n')
}

/**
 * The Jobs panel: the loaded markdown list as a switcher. Each line shows
 * what it is here — working on it now, resumable, or not started — and one
 * click moves the session. Started jobs of this session that are NOT on the
 * loaded list get their own section below, so nothing worked on here is
 * ever unreachable through the panel.
 */
function JobListPanel(props) {
  var pal = props.pal
  var sessionId = props.sessionId
  var viewportW = useViewportWidth()

  var listState = React.useState(null) // null = still loading
  var list = listState[0]
  var setList = listState[1]
  var candsState = React.useState([])
  var candidacies = candsState[0]
  var setCands = candsState[1]
  var errorState = React.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var busyKeyState = React.useState(null)
  var busyKey = busyKeyState[0]
  var setBusyKey = busyKeyState[1]
  // Changing the source file: an open edit box with a path field.
  var editOpenState = React.useState(false)
  var editOpen = editOpenState[0]
  var setEditOpen = editOpenState[1]
  var editPathState = React.useState('')
  var editPath = editPathState[0]
  var setEditPath = editPathState[1]
  // Starting a never-opened line expands a CV confirm inline.
  var startUrlState = React.useState(null)
  var startUrl = startUrlState[0]
  var setStartUrl = startUrlState[1]
  var startCvState = React.useState('')
  var startCv = startCvState[0]
  var setStartCv = startCvState[1]

  function refresh() {
    return Promise.all([fetchJobList(sessionId), fetchCandidacies(sessionId)])
      .then(function (results) {
        setList(results[0])
        setCands(results[1].candidacies)
        setError(null)
        return results[0]
      })
      .catch(function (err) {
        setError(String(err && err.message ? err.message : err))
        return null
      })
  }

  React.useEffect(
    function () {
      var alive = true
      refresh()
      return function () {
        alive = false
      }
    },
    [sessionId],
  )

  React.useEffect(
    function () {
      function onKey(e) {
        if (e.key === 'Escape') props.onClose()
      }
      document.addEventListener('keydown', onKey)
      return function () {
        document.removeEventListener('keydown', onKey)
      }
    },
    [props.onClose],
  )

  function parseFrom(pathValue) {
    var p = squish(pathValue)
    if (p === '') {
      setError('give the markdown path first')
      return
    }
    setBusyKey('parse')
    setError(null)
    postJobList(sessionId, { path: p, cvPath: list ? list.cvPath : '' })
      .then(function () {
        setBusyKey(null)
        setEditOpen(false)
        return refresh().then(function () {
          if (props.onBadge) props.onBadge()
        })
      })
      .catch(function (err) {
        setBusyKey(null)
        setError(String(err && err.message ? err.message : err))
      })
  }

  function stageFile(file) {
    if (!file || busyKey) return
    setBusyKey('parse')
    setError(null)
    readFileAsBase64(file)
      .then(function (dataBase64) {
        return postJobList(sessionId, {
          filename: file.name,
          dataBase64: dataBase64,
          cvPath: list ? list.cvPath : '',
        })
      })
      .then(function () {
        setBusyKey(null)
        setEditOpen(false)
        return refresh().then(function () {
          if (props.onBadge) props.onBadge()
        })
      })
      .catch(function (err) {
        setBusyKey(null)
        setError(String(err && err.message ? err.message : err))
      })
  }

  function reload() {
    if (!list || !list.path || busyKey) return
    parseFrom(list.path)
  }

  /** Resume an already-started job: swap the archive in, close, done. */
  function resume(job) {
    if (busyKey) return
    setBusyKey(normJobUrl(job.url))
    setError(null)
    postSwitch(sessionId, { jobUrl: job.url })
      .then(function () {
        props.onClose()
      })
      .catch(function (err) {
        setBusyKey(null)
        setError(String(err && err.message ? err.message : err))
      })
  }

  function beginStart(job) {
    setStartUrl(job.url)
    setStartCv(list && list.cvPath ? list.cvPath : '')
    setError(null)
  }

  /** Start a fresh job: switch first, then hand the standard flow to chat. */
  function confirmStart(job) {
    if (busyKey) return
    var cvPath = squish(startCv)
    if (cvPath === '') {
      setError('give the CV path for this application')
      return
    }
    setBusyKey(normJobUrl(job.url))
    setError(null)
    postSwitch(sessionId, {
      jobUrl: job.url,
      company: job.company,
      jobTitle: job.title,
      cvPath: cvPath,
    })
      .then(function () {
        var outcome = deliverToComposer(
          props.inputActions,
          buildJobsStartMessage(job, cvPath, list ? list.path : '', sessionId),
          props.draft,
        )
        if (outcome === 'sent' || outcome === 'queued') {
          if (props.onStarted) props.onStarted({ target: 'cv' })
          props.onClose()
          return
        }
        setBusyKey(null)
        setError(deliveryNotice(outcome) || 'could not reach the composer')
      })
      .catch(function (err) {
        setBusyKey(null)
        setError(String(err && err.message ? err.message : err))
      })
  }

  var W = Math.min(680, Math.max(280, viewportW - 16))
  var H = Math.min(600, (typeof window !== 'undefined' ? window.innerHeight : 800) - 32)

  var fieldStyle = {
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: '18px',
    padding: '7px 9px',
    borderRadius: 6,
    border: '1px solid ' + pal.controlBorder,
    background: pal.dark ? 'rgba(0,0,0,0.25)' : '#fff',
    color: pal.textStrong,
  }
  var btnStyle = {
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
  var primaryBtn = Object.assign({}, btnStyle, {
    background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
    borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
  })

  function stateChip(state) {
    if (state === 'active') {
      return createElement(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            fontWeight: 600,
            color: pal.accent,
            whiteSpace: 'nowrap',
          },
        },
        createElement('span', {
          style: {
            width: 6,
            height: 6,
            borderRadius: 999,
            background: pal.accent,
            display: 'inline-block',
          },
        }),
        'working on this',
      )
    }
    return null
  }

  function jobRow(entry, index) {
    var key = normJobUrl(entry.url) || String(index)
    var state = jobsRowState(entry, candidacies)
    var busyHere = busyKey === key
    var subBits = []
    var company = entry && typeof entry.company === 'string' ? squish(entry.company) : ''
    if (company !== '') subBits.push(company)
    if (entry.url) subBits.push(shortUrl(entry.url, 58))
    return createElement(
      'div',
      {
        key: key,
        style: {
          border: '1px solid ' + pal.controlBorder,
          borderRadius: 8,
          padding: '9px 11px',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          background: state === 'active' ? pal.panelBg : 'transparent',
        },
      },
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        createElement(
          'div',
          {
            style: {
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              fontWeight: state === 'active' ? 600 : 500,
              color: pal.textStrong,
            },
          },
          jobRowLabel(entry),
        ),
        stateChip(state),
        state === 'resume'
          ? createElement(
              'button',
              {
                type: 'button',
                disabled: !!busyKey,
                onClick: function () {
                  resume(entry)
                },
                title:
                  'Switch this session to ' +
                  jobRowLabel(entry) +
                  ' — its earlier work comes back with it',
                style: btnStyle,
              },
              busyHere ? 'switching…' : 'Resume ▸',
            )
          : null,
        state === 'start'
          ? createElement(
              'button',
              {
                type: 'button',
                disabled: !!busyKey,
                onClick: function () {
                  beginStart(entry)
                },
                title: 'Start tailoring my CV for ' + jobRowLabel(entry),
                style: btnStyle,
              },
              busyHere ? 'starting…' : 'Start ▸',
            )
          : null,
      ),
      subBits.length > 0
        ? createElement(
            'div',
            {
              style: {
                fontSize: 11,
                color: pal.text,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            subBits.join(' · '),
          )
        : null,
      startUrl === entry.url
        ? createElement(
            'div',
            {
              style: {
                marginTop: 5,
                paddingTop: 7,
                borderTop: '1px solid ' + pal.controlBorder,
                display: 'flex',
                flexDirection: 'column',
                gap: 7,
              },
            },
            createElement(
              'div',
              { style: { fontSize: 11, color: pal.text } },
              'This switches the session to a FRESH start for this job, then asks the agent to tailor your CV for it.',
            ),
            createElement('input', {
              value: startCv,
              type: 'text',
              autoCapitalize: 'none',
              autoCorrect: 'off',
              spellCheck: false,
              placeholder: '/path/to/cv.pdf — the CV to tailor',
              onChange: function (e) {
                setStartCv(e.target.value)
              },
              style: fieldStyle,
            }),
            createElement(
              'div',
              { style: { display: 'flex', gap: 8 } },
              createElement(
                'button',
                {
                  type: 'button',
                  disabled: !!busyKey,
                  onClick: function () {
                    confirmStart(entry)
                  },
                  style: primaryBtn,
                },
                busyHere ? 'starting…' : 'Tailor this one',
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    setStartUrl(null)
                  },
                  style: btnStyle,
                },
                'Cancel',
              ),
            ),
          )
        : null,
    )
  }

  // Started candidacies that the loaded list does not name — started via the
  // plain start form, or under an older list. They stay reachable here.
  var extras = []
  if (Array.isArray(candidacies)) {
    for (var i = 0; i < candidacies.length; i++) {
      var c = candidacies[i]
      if (!c || c.started !== true || !c.jobUrl) continue
      if (Array.isArray(list && list.jobs) && findCandidacyFor(list.jobs, c.jobUrl) !== null) {
        continue
      }
      extras.push(c)
    }
  }

  var jobs = list && Array.isArray(list.jobs) ? list.jobs : []

  return ReactDOM.createPortal(
    createElement(
      'div',
      {
        'data-dsh-job-cv-overlay': '',
        onClick: function (e) {
          if (e.target === e.currentTarget) props.onClose()
        },
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 9100,
          background: pal.dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.28)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 8,
          overscrollBehavior: 'contain',
        },
      },
      createElement(
        'div',
        {
          role: 'dialog',
          'aria-label': 'Jobs list',
          style: {
            width: W,
            maxHeight: H,
            background: pal.baseBg,
            border: '1px solid ' + pal.panelBorder,
            borderRadius: 10,
            boxShadow: pal.dark ? '0 18px 50px rgba(0,0,0,0.6)' : '0 18px 50px rgba(0,0,0,0.22)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        },
        createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              borderBottom: '1px solid ' + pal.panelBorder,
            },
          },
          createElement(
            'span',
            { style: { fontSize: 13, fontWeight: 700, color: pal.textStrong, flex: 1 } },
            'Jobs',
          ),
          createElement(
            'button',
            {
              type: 'button',
              onClick: props.onClose,
              title: 'Close (Esc)',
              style: btnStyle,
            },
            '✕',
          ),
        ),
        createElement(
          'div',
          { style: { padding: '10px 12px', overflowY: 'auto', flex: 1, minHeight: 0 } },
          list === null
            ? createElement('div', { style: { fontSize: 12, color: pal.text } }, 'Loading…')
            : createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                createElement(
                  'div',
                  { style: { fontSize: 11, color: pal.text, lineHeight: 1.5 } },
                  list.path
                    ? 'Pick which posting this session works on. Switching archives the current job with its whole history — nothing is overwritten.'
                    : 'Point at a markdown file of postings — one job per line, like "- Senior Engineer — https://…" (a "## Company" heading names the employer). Pick a line and this session works on that job.',
                ),
                editOpen || !list.path
                  ? createElement(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
                      createElement('input', {
                        value: editPath,
                        type: 'text',
                        autoCapitalize: 'none',
                        autoCorrect: 'off',
                        spellCheck: false,
                        placeholder: '/path/to/jobs.md',
                        onChange: function (e) {
                          setEditPath(e.target.value)
                        },
                        onKeyDown: function (e) {
                          if (e.key === 'Enter') parseFrom(editPath)
                        },
                        style: fieldStyle,
                      }),
                      createElement(
                        'div',
                        {
                          onDragOver: function (e) {
                            e.preventDefault()
                          },
                          onDrop: function (e) {
                            e.preventDefault()
                            var f =
                              e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
                            stageFile(f)
                          },
                          onClick: function () {},
                          style: {
                            border: '1px dashed ' + pal.controlBorder,
                            borderRadius: 6,
                            padding: '9px 10px',
                            fontSize: 11,
                            textAlign: 'center',
                            color: pal.text,
                          },
                        },
                        '…or drop the .md file here',
                      ),
                      createElement(
                        'div',
                        { style: { display: 'flex', gap: 8 } },
                        createElement(
                          'button',
                          {
                            type: 'button',
                            disabled: !!busyKey,
                            onClick: function () {
                              parseFrom(editPath)
                            },
                            style: primaryBtn,
                          },
                          busyKey === 'parse' ? 'reading…' : 'Read the list',
                        ),
                        editOpen && list.path
                          ? createElement(
                              'button',
                              {
                                type: 'button',
                                onClick: function () {
                                  setEditOpen(false)
                                },
                                style: btnStyle,
                              },
                              'Cancel',
                            )
                          : null,
                      ),
                    )
                  : createElement(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                      createElement(
                        'span',
                        {
                          title: list.path,
                          style: {
                            flex: 1,
                            minWidth: 0,
                            fontSize: 11,
                            color: pal.text,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          },
                        },
                        'From ' + list.path,
                      ),
                      createElement(
                        'button',
                        {
                          type: 'button',
                          disabled: !!busyKey,
                          onClick: reload,
                          title: 'Re-read the markdown — postings move and links change',
                          style: btnStyle,
                        },
                        busyKey === 'parse' ? 'reading…' : 'Reload',
                      ),
                      createElement(
                        'button',
                        {
                          type: 'button',
                          disabled: !!busyKey,
                          onClick: function () {
                            setEditPath(list.path)
                            setEditOpen(true)
                          },
                          style: btnStyle,
                        },
                        'Change file',
                      ),
                    ),
                jobs.map(function (entry, idx) {
                  return jobRow(entry, idx)
                }),
                extras.length > 0
                  ? createElement(
                      'div',
                      { style: { marginTop: 4 } },
                      createElement(
                        'div',
                        {
                          style: {
                            fontSize: 11,
                            fontWeight: 600,
                            letterSpacing: 0.5,
                            textTransform: 'uppercase',
                            color: pal.text,
                            marginBottom: 6,
                          },
                        },
                        'Also worked on in this session',
                      ),
                      createElement(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                        extras.map(function (c, idx) {
                          return createElement(
                            'div',
                            {
                              key: (c.key || String(idx)) + '-extra',
                              style: {
                                border: '1px solid ' + pal.controlBorder,
                                borderRadius: 8,
                                padding: '8px 11px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                              },
                            },
                            createElement(
                              'div',
                              {
                                style: {
                                  flex: 1,
                                  minWidth: 0,
                                  fontSize: 12,
                                  color: pal.textStrong,
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                },
                                title: c.jobUrl,
                              },
                              (c.company ? c.company + ' — ' : '') +
                                (c.jobTitle || shortUrl(c.jobUrl, 48)),
                            ),
                            c.active === true
                              ? stateChip('active')
                              : createElement(
                                  'button',
                                  {
                                    type: 'button',
                                    disabled: !!busyKey,
                                    onClick: function () {
                                      resume({ url: c.jobUrl })
                                    },
                                    style: btnStyle,
                                  },
                                  busyKey === normJobUrl(c.jobUrl) ? 'switching…' : 'Resume ▸',
                                ),
                          )
                        }),
                      ),
                    )
                  : null,
              ),
          error
            ? createElement(
                'div',
                { style: { fontSize: 12, color: pal.dark ? '#ffb4a2' : '#b3261e', marginTop: 8 } },
                error,
              )
            : null,
        ),
      ),
    ),
    document.body,
  )
}
