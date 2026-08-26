// ------------------------- onboarding: start a job application -------------------------
// A fresh session (version 0) shows this start form in the preview instead of
// the starter CV. Two ways in, one destination:
//
//   Single job — paste the public job post link and point at your current CV.
//   From a list — point at a markdown file of postings (one job per line,
//   a link each); the host parses it (POST /jobcv/joblist) and its lines
//   become the pick surface. One chosen line starts exactly the same flow
//   as the single-job path, and the Jobs dock panel keeps the list around
//   for switching later in the session.
//
// The CV works the same in both modes: pinned at the top sits the master CV
// (the source of truth every application tailors from, mirrored by the host
// into this root so its path is real), then the latest CVs of past
// applications (GET /jobcv/cvs), then a typed path or a file dropped onto
// the form (staged through POST /jobcv/intake, whose returned path is filled
// in). Submitting hands link + CV to the chat so the agent upserts the
// candidacy workspace and tailors the CV. A company name is optional: it
// steers the agent's upsert, and — when the composer is unreachable — lets
// the form open the workspace directly as a fallback.

/** Read a File as base64 (the data:…;base64, prefix stripped). */
function readFileAsBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader()
    reader.onload = function () {
      var result = String(reader.result || '')
      var comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = function () {
      reject(new Error('could not read the file'))
    }
    reader.readAsDataURL(file)
  })
}

/** Stage a dropped CV with the host; resolve to the stored path. */
function intakeCv(sessionId, file) {
  return readFileAsBase64(file).then(function (dataBase64) {
    return fetch('/jobcv/intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId,
        filename: file.name,
        dataBase64: dataBase64,
      }),
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) {
          var detail = body && body.error ? body.error : 'intake failed'
          throw new Error(detail + ' (' + res.status + ')')
        }
        if (!body || typeof body.path !== 'string' || body.path === '') {
          throw new Error('host returned no staged path')
        }
        return body
      })
    })
  })
}

/** Upsert the candidacy workspace directly from the form (fallback path). */
function upsertWorkspace(sessionId, company, jobUrl) {
  return fetch('/jobcv/workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: sessionId,
      company: company,
      jobUrl: jobUrl,
    }),
  }).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok) {
        var detail = body && body.error ? body.error : 'workspace upsert failed'
        throw new Error(detail + ' (' + res.status + ')')
      }
      if (!body || typeof body.path !== 'string' || body.path === '') {
        throw new Error('host returned no workspace path')
      }
      return body
    })
  })
}

/** An entry the pick list can offer: it must name a file. */
function usableRecent(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.path === 'string' &&
    entry.path !== ''
  )
}

/**
 * One pick's main line: company — job title. The company is never missing
 * through POST /jobcv/workspace, but candidacy folders kept by hand exist,
 * so a folder-name fallback keeps such an entry readable instead of blank.
 */
function recentLabel(entry) {
  var company = entry && typeof entry.company === 'string' ? entry.company.trim() : ''
  if (company === '') {
    var workspace = entry && typeof entry.workspace === 'string' ? entry.workspace : ''
    var parts = workspace.split(/[\\/]/).filter(function (p) {
      return p !== ''
    })
    // The standard layout ends <root>/<company>/<job>, so the company is the
    // second-to-last segment; anything else gets an honest generic label.
    company = parts.length >= 2 ? parts[parts.length - 2] : 'Past application'
  }
  var title = entry && typeof entry.jobTitle === 'string' ? entry.jobTitle.trim() : ''
  return title === '' ? company : company + ' — ' + title
}

/** The label under the path: which version this is, and when it was saved. */
function recentSubline(entry) {
  var bits = []
  if (entry && Number.isInteger(entry.version) && entry.version > 0) bits.push('v' + entry.version)
  var ts = entry ? Number(entry.updatedAt) : NaN
  if (isFinite(ts) && ts > 0) {
    try {
      bits.push(new Date(ts).toLocaleDateString())
    } catch (e) {
      /* no date is better than a wrong one */
    }
  }
  return bits.join(' · ')
}

/**
 * The latest CV of every past application, newest first, for the pick list —
 * plus the master CV pinned above them. Every failure resolves to an empty
 * answer on purpose: the list is a convenience, and onboarding must keep
 * working — through the typed path and dropzone below it — when the host is
 * unreachable or this session has no history.
 */
function fetchRecentCvs(sessionId) {
  return fetch('/jobcv/cvs?session=' + encodeURIComponent(sessionId))
    .then(function (res) {
      return res.json().then(function (body) {
        var cvs = body && Array.isArray(body.cvs) ? body.cvs.filter(usableRecent) : []
        // The master rides the same listing (host mirrors it into this root
        // first), dressed as a pick-row so the form treats one base like any
        // other. A master without a mirror path is not offered: pointing at
        // a file that may not exist would waste the application's first
        // message, and the contract tells the agent to use the master anyway.
        var m = body && body.master ? body.master : null
        var master =
          m && typeof m.path === 'string' && m.path !== '' && Number(m.version) > 0
            ? {
                company: 'Your master CV',
                jobTitle: 'the source of truth',
                path: m.path,
                version: Number(m.version),
                updatedAt: Number(m.updatedAt) || 0,
                badge: 'master',
              }
            : null
        return { cvs: cvs, master: master }
      })
    })
    .catch(function () {
      return { cvs: [], master: null }
    })
}

/**
 * The chat message the start form hands to the agent. When the form already
 * opened the workspace (direct fallback), the message names the exact path so
 * the agent adopts that folder instead of deriving a different one.
 */
function buildStartMessage(link, cvPath, company, workspacePath, sessionId) {
  var lines = [
    'Start a new job application for me.',
    '',
    'Job post link: ' + link,
    'My CV: ' + cvPath,
  ]
  if (company) lines.push('Company: ' + company)
  // The agent cannot discover this: personas expand only {{model}} and
  // {{cwd}}, and nothing puts a session id in its environment. Left to guess
  // it saves to a document the preview is not watching, and the pane sits on
  // this form while the work lands somewhere invisible.
  if (sessionId) {
    lines.push('Session id: ' + sessionId + '  (use this exact string in every /jobcv call)')
  }
  lines.push('')
  if (workspacePath) {
    lines.push(
      'The candidacy workspace is already open at ' +
        workspacePath +
        ' (POST /jobcv/workspace with the same company and this job link returns',
      'created:false — adopt that folder, do not create a new one). Read my CV',
      'at the path above, and tailor it against the job post. Save the tailored',
      'CV through POST /jobcv/doc and tell me what you changed.',
    )
  } else {
    lines.push(
      'Open the candidacy workspace for this job first (POST /jobcv/workspace',
      'with the company name and job id from the post), read my CV at the path',
      'above, and tailor it against the job post. Save the tailored CV through',
      'POST /jobcv/doc and tell me what you changed.',
    )
  }
  return lines.join('\n')
}

function StartForm(props) {
  var pal = props.pal
  var sessionId = props.sessionId
  var inputActions = props.inputActions

  // 'single' is the classic one-link form; 'list' reads a markdown file of
  // postings and starts from a picked line. Both end in the same hand-off.
  var modeState = React.useState('single')
  var mode = modeState[0]
  var setMode = modeState[1]
  var linkState = React.useState('')
  var link = linkState[0]
  var setLink = linkState[1]
  var pathState = React.useState('')
  var path = pathState[0]
  var setPath = pathState[1]
  var companyState = React.useState('')
  var company = companyState[0]
  var setCompany = companyState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var statusState = React.useState(null)
  var status = statusState[0]
  var setStatus = statusState[1]
  // The composed message when neither the composer nor the clipboard was
  // reachable: shown inline so nothing the user typed is lost.
  var fallbackState = React.useState(null)
  var fallback = fallbackState[0]
  var setFallback = fallbackState[1]
  // The past applications whose latest CV the form offers as a starting
  // point — and the master CV pinned above them when one exists. Fetched
  // once on mount; a failure leaves the manual entry only, because the pick
  // list must never stand between the user and Start.
  var recentsState = React.useState([])
  var recents = recentsState[0]
  var setRecents = recentsState[1]
  var masterPickState = React.useState(null)
  var masterPick = masterPickState[0]
  var setMasterPick = masterPickState[1]
  React.useEffect(function () {
    var alive = true
    fetchRecentCvs(sessionId).then(function (result) {
      if (!alive) return
      setRecents(result.cvs)
      setMasterPick(result.master)
    })
    return function () {
      alive = false
    }
  }, [])
  // The parsed jobs list, the path it was read from (so Start can mention
  // it), and which line is picked.
  var jobsState = React.useState(null)
  var jobs = jobsState[0]
  var setJobs = jobsState[1]
  var listPathUsedState = React.useState('')
  var listPathUsed = listPathUsedState[0]
  var setListPathUsed = listPathUsedState[1]
  var listPathInputState = React.useState('')
  var listPathInput = listPathInputState[0]
  var setListPathInput = listPathInputState[1]
  var pickedState = React.useState(-1)
  var picked = pickedState[0]
  var setPicked = pickedState[1]
  var fileRef = React.useRef(null)
  var mdFileRef = React.useRef(null)
  // A coarse pointer is a phone or tablet: there is no drag-drop there, so
  // the drop zone says what the gesture actually is.
  var touchCoarse = false
  try {
    touchCoarse =
      typeof window !== 'undefined' &&
      !!window.matchMedia &&
      window.matchMedia('(pointer: coarse)').matches
  } catch (e) {
    touchCoarse = false
  }

  // Both paths through the same pipeline: a drag-drop and a picked file.
  function stageFile(file) {
    if (!file || busy) return
    setBusy(true)
    setStatus('staging ' + file.name + '…')
    intakeCv(sessionId, file)
      .then(function (body) {
        setBusy(false)
        setPath(body.path)
        setStatus('staged: ' + body.path)
      })
      .catch(function (err) {
        setBusy(false)
        setStatus('could not stage the file: ' + String(err && err.message ? err.message : err))
      })
  }

  function onDrop(e) {
    e.preventDefault()
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
    stageFile(file)
  }

  function onPickFile(e) {
    var file = e.target && e.target.files && e.target.files[0]
    stageFile(file)
    // Reset so picking the same file again still fires onChange.
    e.target.value = ''
  }

  /**
   * Read the markdown jobs list — from a typed path, or from a dropped
   * .md/.txt file staged as bytes (the host saves it and re-reads it there,
   * so Reload and the Jobs panel keep working after the drop). The current
   * CV path rides along: starting the NEXT job from this list pre-fills it.
   */
  function readJobList(pathValue, upload) {
    var payload = upload
      ? { filename: upload.name, dataBase64: upload.dataBase64 }
      : { path: squish(pathValue) }
    if (!upload && squish(pathValue) === '') {
      setStatus('give the markdown path first')
      return
    }
    payload.cvPath = squish(path)
    setBusy(true)
    setStatus('reading the list…')
    postJobList(sessionId, payload)
      .then(function (body) {
        setBusy(false)
        setJobs(Array.isArray(body.jobs) ? body.jobs : [])
        setListPathUsed(typeof body.path === 'string' ? body.path : '')
        setPicked(-1)
        if (upload && typeof body.path === 'string') setListPathInput(body.path)
        var n = Number(body.count) || 0
        setStatus(n === 1 ? '1 job found — pick it below' : n + ' jobs found — pick one below')
      })
      .catch(function (err) {
        setBusy(false)
        setStatus('could not read the list: ' + String(err && err.message ? err.message : err))
      })
  }

  function onDropMd(e) {
    e.preventDefault()
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
    if (!file || busy) return
    readFileAsBase64(file).then(
      function (dataBase64) {
        readJobList(null, { name: file.name, dataBase64: dataBase64 })
      },
      function () {
        setStatus('could not read the file')
      },
    )
  }

  function onPickMd(e) {
    var file = e.target && e.target.files && e.target.files[0]
    if (file && !busy) {
      readFileAsBase64(file).then(function (dataBase64) {
        readJobList(null, { name: file.name, dataBase64: dataBase64 })
      })
    }
    e.target.value = ''
  }

  /** The shared hand-off: composer first, workspace fallback, copy box last.
   *  `jobLink` (single mode only) drives the direct workspace fallback. */
  function handOff(makeMessage, companyName, jobLink) {
    var via = deliverToComposer(inputActions, makeMessage(null), props.draft)
    if (via !== null) {
      setFallback(null)
      setStatus(via === 'sent' ? 'sent — the agent is on it' : deliveryNotice(via))
      if (via === 'sent' && props.onWorkStarted) props.onWorkStarted()
      return
    }
    // Composer AND clipboard unreachable. With a company name the form can at
    // least open the workspace itself so the folder exists; without one it
    // only surfaces the message to copy. Either way nothing is silently lost.
    if (companyName !== '') {
      setBusy(true)
      setStatus('opening the candidacy workspace directly…')
      upsertWorkspace(sessionId, companyName, jobLink || '')
        .then(function (body) {
          setBusy(false)
          setStatus('workspace open at ' + body.path + ' — copy the message below into the chat')
          setFallback(makeMessage(body.path))
        })
        .catch(function (err) {
          setBusy(false)
          setStatus(
            'could not open the workspace: ' + String(err && err.message ? err.message : err),
          )
          setFallback(makeMessage(null))
        })
    } else {
      setStatus('could not reach the composer — add a company name to open the workspace directly')
      setFallback(makeMessage(null))
    }
  }

  function submit() {
    var cvPath = squish(path)
    var companyName = squish(company)
    if (mode === 'list') {
      var jobsArr = Array.isArray(jobs) ? jobs : []
      if (picked < 0 || picked >= jobsArr.length) {
        setStatus('pick a job from the list first')
        return
      }
      if (cvPath === '') {
        setStatus('give the CV path or drop the file')
        return
      }
      handOff(
        function () {
          return buildJobsStartMessage(jobsArr[picked], cvPath, listPathUsed, sessionId)
        },
        companyName,
        null,
      )
      return
    }
    var jobLink = squish(link)
    if (jobLink === '') {
      setStatus('paste the job post link first')
      return
    }
    if (cvPath === '') {
      setStatus('give the CV path or drop the file')
      return
    }
    handOff(
      function (workspacePath) {
        return buildStartMessage(jobLink, cvPath, companyName, workspacePath, sessionId)
      },
      companyName,
      jobLink,
    )
  }

  var field = {
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
  var label = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: pal.text,
    marginBottom: 4,
  }
  var btn = {
    border: '1px solid ' + pal.controlBorder,
    background: pal.controlBg,
    color: pal.textStrong,
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: '16px',
    padding: '6px 14px',
    borderRadius: 6,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  }
  var primaryBtn = Object.assign({}, btn, {
    background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
    borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
    marginTop: 4,
  })
  var pickBase = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
    cursor: 'pointer',
    border: '1px solid ' + pal.controlBorder,
    background: pal.panelBg,
    color: pal.textStrong,
    borderRadius: 6,
    padding: '8px 10px',
  }
  var pickSelected = Object.assign({}, pickBase, {
    borderColor: pal.dark ? 'rgba(122,184,255,0.55)' : 'rgba(46,111,219,0.5)',
    background: pal.dark ? 'rgba(122,184,255,0.12)' : 'rgba(46,111,219,0.08)',
  })
  var pickPathStyle = {
    fontSize: 11,
    lineHeight: '15px',
    color: pal.text,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    marginTop: 2,
  }

  // Selection lives in the path state itself — a row reads as picked exactly
  // while its file is what Start would submit. Editing the path by hand or
  // dropping a new file un-picks the row with no extra bookkeeping.
  var currentPath = squish(path)
  function recentRow(entry) {
    var selected = entry.path === currentPath
    return createElement(
      'button',
      {
        key: entry.path,
        type: 'button',
        role: 'radio',
        'aria-checked': selected ? 'true' : 'false',
        onClick: function () {
          setPath(entry.path)
        },
        style: selected ? pickSelected : pickBase,
      },
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        createElement('div', { style: { fontSize: 12, fontWeight: 600 } }, recentLabel(entry)),
        // One word of provenance: the pinned master reads differently from
        // the tailored byproducts below it.
        entry.badge
          ? createElement(
              'span',
              {
                style: {
                  border: '1px solid ' + pal.controlBorder,
                  borderRadius: 4,
                  padding: '0 5px',
                  fontSize: 9,
                  lineHeight: '14px',
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  color: pal.accent,
                  flex: 'none',
                },
              },
              entry.badge,
            )
          : null,
      ),
      createElement('div', { style: pickPathStyle }, entry.path),
      createElement(
        'div',
        { style: { fontSize: 11, color: pal.text, marginTop: 1 } },
        recentSubline(entry),
      ),
    )
  }

  /** The mode tabs: same destination, two doors into it. */
  function tabBtn(which, text) {
    var selected = mode === which
    return createElement(
      'button',
      {
        key: which,
        type: 'button',
        role: 'tab',
        'aria-selected': selected ? 'true' : 'false',
        onClick: function () {
          if (mode === which) return
          setMode(which)
          setStatus(null)
          setFallback(null)
        },
        style: selected
          ? Object.assign({}, btn, {
              background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
              borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
              fontWeight: 600,
            })
          : btn,
      },
      text,
    )
  }

  /** One parsed line of the jobs list, as a radio row. Picking fills the
   *  company field from the line (or clears it), so Start says exactly what
   *  the pick shows. */
  function jobPickRow(entry, index) {
    var selected = picked === index
    var companyText = entry && typeof entry.company === 'string' ? squish(entry.company) : ''
    return createElement(
      'button',
      {
        key: normJobUrl(entry.url) || String(index),
        type: 'button',
        role: 'radio',
        'aria-checked': selected ? 'true' : 'false',
        onClick: function () {
          setPicked(index)
          setCompany(companyText)
        },
        style: selected ? pickSelected : pickBase,
      },
      createElement('div', { style: { fontSize: 12, fontWeight: 600 } }, jobRowLabel(entry)),
      createElement(
        'div',
        { style: pickPathStyle },
        (companyText !== '' ? companyText + ' · ' : '') + shortUrl(entry && entry.url, 64),
      ),
    )
  }

  return createElement(
    'div',
    {
      style: {
        maxWidth: 520,
        margin: '0 auto',
        padding: '26px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
    },
    createElement(
      'div',
      { style: { fontSize: 15, fontWeight: 600, color: pal.textStrong } },
      'Start a job application',
    ),
    createElement(
      'div',
      { style: { fontSize: 12, color: pal.text, lineHeight: 1.5 } },
      mode === 'list'
        ? 'Point at a markdown file of postings — one job per line, like ' +
            '"- Senior Engineer — https://…" (a "## Company" heading names the ' +
            'employer). Pick a line: the agent tailors your CV for that job only.'
        : 'Paste the public link of the job post and point at your current CV. ' +
            'The agent opens a workspace for this candidacy and tailors the CV ' +
            'into the preview.',
    ),
    createElement(
      'div',
      { role: 'tablist', 'aria-label': 'How to start', style: { display: 'flex', gap: 6 } },
      tabBtn('single', 'Single job'),
      tabBtn('list', 'From a list'),
    ),
    mode === 'list'
      ? createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          createElement('label', { style: label }, 'Jobs markdown'),
          createElement(
            'div',
            { style: { display: 'flex', gap: 8 } },
            createElement('input', {
              value: listPathInput,
              type: 'text',
              autoCapitalize: 'none',
              autoCorrect: 'off',
              spellCheck: false,
              placeholder: '/path/to/jobs.md',
              onChange: function (e) {
                setListPathInput(e.target.value)
              },
              onKeyDown: function (e) {
                if (e.key === 'Enter') readJobList(listPathInput, null)
              },
              style: Object.assign({}, field, { flex: 1 }),
            }),
            createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: function () {
                  readJobList(listPathInput, null)
                },
                style: primaryBtn,
              },
              busy ? 'reading…' : 'Read list',
            ),
          ),
          createElement(
            'div',
            {
              onDragOver: function (e) {
                e.preventDefault()
              },
              onDrop: onDropMd,
              onClick: function () {
                if (!busy && mdFileRef.current) mdFileRef.current.click()
              },
              style: {
                border: '1px dashed ' + pal.controlBorder,
                borderRadius: 6,
                padding: '10px 12px',
                textAlign: 'center',
                fontSize: 11,
                color: pal.text,
                cursor: 'pointer',
                background: pal.panelBg,
              },
            },
            touchCoarse
              ? 'tap to choose the .md file'
              : 'drop the .md file here, or click to browse',
          ),
          createElement('input', {
            ref: mdFileRef,
            type: 'file',
            accept: '.md,.markdown,.txt,text/markdown,text/plain',
            onChange: onPickMd,
            style: { display: 'none' },
          }),
          Array.isArray(jobs) && jobs.length > 0
            ? createElement(
                'div',
                {
                  role: 'radiogroup',
                  'aria-label': 'Jobs from your list',
                  style: { display: 'flex', flexDirection: 'column', gap: 6 },
                },
                jobs.map(function (entry, index) {
                  return jobPickRow(entry, index)
                }),
              )
            : null,
        )
      : createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          createElement('label', { style: label }, 'Job post link'),
          createElement('input', {
            value: link,
            type: 'url',
            // A URL field that capitalizes and autocorrects fights the mobile
            // keyboard: every "Https://" has to be undone by hand.
            autoCapitalize: 'none',
            autoCorrect: 'off',
            spellCheck: false,
            placeholder: 'https://…',
            onChange: function (e) {
              setLink(e.target.value)
            },
            style: field,
          }),
        ),
    createElement('label', { style: label }, 'Your CV'),
    (masterPick !== null || recents.length > 0) && masterPick === null
      ? createElement(
          'div',
          { style: { fontSize: 11, color: pal.text, lineHeight: 1.4 } },
          'Pick one from your past applications, or point somewhere else below.',
        )
      : null,
    (masterPick !== null || recents.length > 0) && masterPick !== null
      ? createElement(
          'div',
          { style: { fontSize: 11, color: pal.text, lineHeight: 1.4 } },
          'Start from your master CV — every application tailors it — or pick a past application below.',
        )
      : null,
    masterPick !== null || recents.length > 0
      ? createElement(
          'div',
          {
            role: 'radiogroup',
            'aria-label': 'Starting points for your CV',
            style: { display: 'flex', flexDirection: 'column', gap: 6 },
          },
          (masterPick !== null ? [masterPick] : []).concat(recents).map(function (entry) {
            return recentRow(entry)
          }),
        )
      : null,
    masterPick !== null || recents.length > 0
      ? createElement(
          'label',
          { style: Object.assign({}, label, { marginTop: 2 }) },
          'Or another CV',
        )
      : null,
    createElement('input', {
      value: path,
      type: 'text',
      autoCapitalize: 'none',
      autoCorrect: 'off',
      spellCheck: false,
      placeholder: '/path/to/cv.pdf',
      onChange: function (e) {
        setPath(e.target.value)
      },
      style: field,
    }),
    createElement(
      'div',
      {
        onDragOver: function (e) {
          e.preventDefault()
        },
        onDrop: onDrop,
        onClick: function () {
          if (!busy && fileRef.current) fileRef.current.click()
        },
        style: {
          border: '1px dashed ' + pal.controlBorder,
          borderRadius: 6,
          padding: '16px 12px',
          textAlign: 'center',
          fontSize: 12,
          color: pal.text,
          cursor: 'pointer',
          background: pal.panelBg,
        },
      },
      busy
        ? 'staging…'
        : touchCoarse
          ? 'tap to choose your CV file (PDF/DOCX)'
          : 'drop the CV file here, or click to browse (PDF/DOCX)',
    ),
    createElement('input', {
      ref: fileRef,
      type: 'file',
      accept: '.pdf,.doc,.docx,application/pdf',
      onChange: onPickFile,
      style: { display: 'none' },
    }),
    createElement('label', { style: label }, 'Company (optional)'),
    createElement('input', {
      value: company,
      placeholder: 'Acme Corp — steers the workspace folder',
      onChange: function (e) {
        setCompany(e.target.value)
      },
      style: field,
    }),
    status ? createElement('div', { style: { fontSize: 12, color: pal.accent } }, status) : null,
    fallback
      ? createElement(
          'div',
          {
            style: {
              border: '1px solid ' + pal.controlBorder,
              borderRadius: 6,
              padding: '8px 10px',
              background: pal.panelBg,
            },
          },
          createElement(
            'div',
            { style: { fontSize: 11, color: pal.text, marginBottom: 4 } },
            'Copy this into the chat:',
          ),
          createElement('textarea', {
            readOnly: true,
            value: fallback,
            onFocus: function (e) {
              e.target.select()
            },
            style: Object.assign({}, field, { minHeight: 120, resize: 'vertical' }),
          }),
        )
      : null,
    createElement(
      'button',
      { type: 'button', onClick: submit, style: primaryBtn },
      mode === 'list' ? 'Start this job' : 'Start',
    ),
  )
}
