// ------------------------- onboarding: start a job application -------------------------
// A fresh session (version 0) shows this start form in the preview instead of
// the starter CV. It collects the two inputs the workflow needs — the public
// job post link and the current CV — where the CV is either a typed path or a
// file dropped onto the form (staged through POST /jobcv/intake, whose
// returned path is filled in). Submitting hands both to the chat so the agent
// upserts the candidacy workspace and tailors the CV. A company name is
// optional: it steers the agent's upsert, and — when the composer is
// unreachable — lets the form open the workspace directly as a fallback.

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

/**
 * The chat message the start form hands to the agent. When the form already
 * opened the workspace (direct fallback), the message names the exact path so
 * the agent adopts that folder instead of deriving a different one.
 */
function buildStartMessage(link, cvPath, company, workspacePath) {
  var lines = [
    'Start a new job application for me.',
    '',
    'Job post link: ' + link,
    'My CV: ' + cvPath,
  ]
  if (company) lines.push('Company: ' + company)
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
  var fileRef = React.useRef(null)

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

  function submit() {
    var jobLink = squish(link)
    var cvPath = squish(path)
    var companyName = squish(company)
    if (jobLink === '') {
      setStatus('paste the job post link first')
      return
    }
    if (cvPath === '') {
      setStatus('give the CV path or drop the file')
      return
    }
    var via = sendToComposer(inputActions, buildStartMessage(jobLink, cvPath, companyName))
    if (via !== null) {
      setFallback(null)
      setStatus(
        via === 'clipboard'
          ? 'copied to the clipboard — paste it into the chat'
          : 'sent to the chat — press enter to run it',
      )
      return
    }
    // Composer AND clipboard unreachable. With a company name the form can at
    // least open the workspace itself so the folder exists; without one it
    // only surfaces the message to copy. Either way nothing is silently lost.
    if (companyName !== '') {
      setBusy(true)
      setStatus('opening the candidacy workspace directly…')
      upsertWorkspace(sessionId, companyName, jobLink)
        .then(function (body) {
          setBusy(false)
          setStatus('workspace open at ' + body.path + ' — copy the message below into the chat')
          setFallback(buildStartMessage(jobLink, cvPath, companyName, body.path))
        })
        .catch(function (err) {
          setBusy(false)
          setStatus(
            'could not open the workspace: ' + String(err && err.message ? err.message : err),
          )
          setFallback(buildStartMessage(jobLink, cvPath, companyName))
        })
    } else {
      setStatus('could not reach the composer — add a company name to open the workspace directly')
      setFallback(buildStartMessage(jobLink, cvPath, companyName))
    }
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
      'Paste the public link of the job post and point at your current CV. ' +
        'The agent opens a workspace for this candidacy and tailors the CV ' +
        'into the preview.',
    ),
    createElement('label', { style: label }, 'Job post link'),
    createElement('input', {
      value: link,
      placeholder: 'https://…',
      onChange: function (e) {
        setLink(e.target.value)
      },
      style: field,
    }),
    createElement('label', { style: label }, 'Your CV'),
    createElement('input', {
      value: path,
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
      busy ? 'staging…' : 'drop the CV file here, or click to browse (PDF/DOCX)',
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
    createElement('button', { type: 'button', onClick: submit, style: primaryBtn }, 'Start'),
  )
}
