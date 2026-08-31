// ------------------------- application tracker -------------------------
// The ◆ Applications panel: every application this plugin has worked on,
// one row per candidacy, each carrying the STATUS tag the user maintains
// (drafting / applied / interview / offer / rejected) plus the latest CV,
// cover letter and stored post it can point at.
//
// The tag is the USER'S report about their own life — "I applied Tuesday",
// "they rejected me" — recorded verbatim through POST /jobcv/status. The
// host stamps the applied date and mirrors the tag into the candidacy
// folder as status.json; this side only ever shows and edits it.
//
// The overview itself is a small workbench, because past a handful of
// applications scanning stops working: a SEARCH box over every field the
// host carries (company, role, link, folder, notes, the tag's own history),
// three VIEWS over the same rows (list cards, a stage-by-stage BOARD, a
// dense sortable TABLE), FILTERS built from what a job spec actually has
// (stage, company, artifacts, fit band, recency) and a SORT on every one of
// those axes. Filtering and sorting happen client-side over the fetched
// listing — the dataset is capped well below what a browser would notice.

var STATUS_ORDER = ['drafting', 'applied', 'interview', 'offer', 'rejected']

/** The three views over the same rows. */
var TRACKER_VIEWS = [
  { key: 'list', label: 'List' },
  { key: 'board', label: 'Board' },
  { key: 'table', label: 'Table' },
]

/** Every axis the panel can be sorted on; the select lists them in this order. */
var SORT_FIELDS = [
  { key: 'activity', label: 'Recently updated' },
  { key: 'appliedAt', label: 'Applied date' },
  { key: 'fitScore', label: 'Fit score' },
  { key: 'company', label: 'Company' },
  { key: 'jobTitle', label: 'Role' },
  { key: 'status', label: 'Stage' },
]

/** Artifact-presence tokens: what a candidacy can have to show for itself. */
var HAS_TOKENS = [
  { key: 'cv', label: 'CV' },
  { key: 'letter', label: 'Letter' },
  { key: 'post', label: 'Post' },
  { key: 'note', label: 'Note' },
]

/** Fit bands ARE the fit panel's — one set of thresholds (see fitBand). */
var FIT_BAND_OPTIONS = [
  { key: 'any', label: 'any fit' },
  { key: 'scored', label: 'scored' },
  { key: 'unscored', label: 'not scored yet' },
  { key: 'strong', label: 'clears the screen · 80%+' },
  { key: 'solid', label: 'one framing risk · 60–79%' },
  { key: 'partial', label: 'a real gap · 40–59%' },
  { key: 'thin', label: 'wrong role/level · under 40%' },
]

/** How recently a row last moved, measured on its activity stamp. */
var RECENCY_OPTIONS = [
  { key: 'any', label: 'any time' },
  { key: '24h', label: 'moved today' },
  { key: '7d', label: 'moved this week' },
  { key: '30d', label: 'moved this month' },
  { key: 'older', label: 'quiet 30+ days' },
]

/** The tag's color, per theme. Drafting is not a color: it is the absence of one. */
function statusColor(status, dark) {
  if (status === 'applied') return dark ? '#7ab8ff' : '#2e6fdb'
  if (status === 'interview') return dark ? '#c792ea' : '#7c4dbe'
  if (status === 'offer') return dark ? '#7bd88f' : '#1e8e3e'
  if (status === 'rejected') return dark ? '#ffb4a2' : '#b3261e'
  return dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
}

/** "just now" → "3d ago" → a date. A timestamp nobody can read is noise. */
function relTime(ts) {
  var n = Number(ts)
  if (!isFinite(n) || n <= 0) return ''
  var diff = Date.now() - n
  if (diff < 45 * 1000) return 'just now'
  if (diff < 60 * 60 * 1000) return Math.max(1, Math.round(diff / 60000)) + 'm ago'
  if (diff < 24 * 60 * 60 * 1000) return Math.round(diff / 3600000) + 'h ago'
  if (diff < 7 * 24 * 60 * 60 * 1000) return Math.round(diff / 86400000) + 'd ago'
  try {
    return new Date(n).toLocaleDateString()
  } catch (e) {
    return ''
  }
}

/** A full date for the applied stamp ("12 Mar"), or ''. */
function shortDate(ts) {
  var n = Number(ts)
  if (!isFinite(n) || n <= 0) return ''
  try {
    return new Date(n).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  } catch (e) {
    try {
      return new Date(n).toLocaleDateString()
    } catch (e2) {
      return ''
    }
  }
}

// ------------------------- search, filters, sort -------------------------
// Pure helpers over the listing shape GET /jobcv/applications returns —
// asserted directly from node, since a filter that silently matches nothing
// reads to the user as "my applications disappeared".

/** The effective tag of a row ('drafting' when none was ever set). */
function effectiveStatus(application) {
  return application && typeof application.status === 'string' && application.status !== ''
    ? application.status
    : 'drafting'
}

/** Does the row carry this artifact? One definition, used by chips and filters alike. */
function applicationHas(app, token) {
  if (!app) return false
  if (token === 'cv') return app.cvVersion > 0
  if (token === 'letter') return app.letterVersion > 0
  if (token === 'post') return app.postChars > 0
  if (token === 'note')
    return !!(
      app.application &&
      typeof app.application.note === 'string' &&
      app.application.note.trim() !== ''
    )
  return false
}

/** Everything a search should reach, lowercased once per check. */
function applicationHaystack(app) {
  if (!app) return ''
  var bits = [app.company, app.jobTitle, app.jobUrl, app.workspace]
  var a = app.application
  if (a) {
    bits.push(effectiveStatus(a), a.note)
    if (Array.isArray(a.log)) {
      for (var i = 0; i < a.log.length; i++) {
        bits.push(a.log[i] && a.log[i].note)
      }
    }
  }
  return bits.join(' ').toLowerCase()
}

/**
 * Whitespace-split terms, ALL of which must appear somewhere on the row —
 * "acme interview" is a conjunction, the way someone actually types.
 */
function applicationMatchesQuery(app, query) {
  var q = String(query === undefined || query === null ? '' : query)
    .trim()
    .toLowerCase()
  if (q === '') return true
  var hay = applicationHaystack(app)
  var terms = q.split(/\s+/)
  for (var i = 0; i < terms.length; i++) {
    if (hay.indexOf(terms[i]) === -1) return false
  }
  return true
}

/** The quiet state: nothing narrowed, nothing hidden. */
function defaultFilters() {
  return { statuses: [], company: '', has: [], fitBand: 'any', recency: 'any' }
}

function isValidHasToken(t) {
  for (var i = 0; i < HAS_TOKENS.length; i++) if (HAS_TOKENS[i].key === t) return true
  return false
}

/** Which fit band does this row land in? The one set of thresholds (fitBand). */
function applicationFitBand(app) {
  var s = app ? app.fitScore : null
  if (typeof s !== 'number' || !isFinite(s)) return 'unscored'
  return fitBand(s).key
}

/** Did the row move inside the recency window? A never-touched row is 'older'. */
function applicationRecency(app, when) {
  var act = app && Number(app.activity) > 0 ? Number(app.activity) : 0
  var now = when || Date.now()
  if (act <= 0) return 'older'
  var age = now - act
  if (age <= 24 * 60 * 60 * 1000) return '24h'
  if (age <= 7 * 24 * 60 * 60 * 1000) return '7d'
  if (age <= 30 * 24 * 60 * 60 * 1000) return '30d'
  return 'older'
}

function applicationMatchesFilters(app, f) {
  if (!f) return true
  if (Array.isArray(f.statuses) && f.statuses.length > 0) {
    if (f.statuses.indexOf(effectiveStatus(app ? app.application : null)) === -1) return false
  }
  if (typeof f.company === 'string' && f.company !== '') {
    // Same resolution the facet chip offered (explicit company, else the
    // folder-derived one), compared case-folded like the grouping.
    var c = applicationCompanyValue(app)
    if (c.toLowerCase() !== f.company.toLowerCase()) return false
  }
  if (Array.isArray(f.has)) {
    for (var i = 0; i < f.has.length; i++) {
      if (!applicationHas(app, f.has[i])) return false
    }
  }
  if (typeof f.fitBand === 'string' && f.fitBand !== 'any') {
    var band = applicationFitBand(app)
    if (f.fitBand === 'scored') {
      if (band === 'unscored') return false
    } else if (band !== f.fitBand) {
      return false
    }
  }
  if (typeof f.recency === 'string' && f.recency !== 'any') {
    if (applicationRecency(app) !== f.recency) return false
  }
  return true
}

/** Search AND filters — the query narrows what the facets already chose. */
function filterApplications(apps, query, filters) {
  var list = Array.isArray(apps) ? apps : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (applicationMatchesQuery(list[i], query) && applicationMatchesFilters(list[i], filters)) {
      out.push(list[i])
    }
  }
  return out
}

/** Numeric sort value per field; NaN marks "nothing to sort on" (missing fit, no applied stamp). */
function applicationNumberValue(app, field) {
  if (!app) return NaN
  if (field === 'activity') {
    var act = Number(app.activity)
    return isFinite(act) ? act : NaN
  }
  if (field === 'appliedAt') {
    var at = app.application ? Number(app.application.appliedAt) : NaN
    return isFinite(at) && at > 0 ? at : NaN
  }
  if (field === 'fitScore') {
    // Number(null) is 0 — a missing score must not masquerade as a perfect
    // anti-score; only a real number sorts.
    if (app.fitScore === null || app.fitScore === undefined || app.fitScore === '') return NaN
    var s = Number(app.fitScore)
    return isFinite(s) ? s : NaN
  }
  if (field === 'status') {
    var idx = STATUS_ORDER.indexOf(effectiveStatus(app.application))
    return idx === -1 ? NaN : idx
  }
  return NaN
}

/** The company a row sorts by, falling back the way its label does. */
function applicationCompanyValue(app) {
  if (!app) return ''
  if (typeof app.company === 'string' && app.company.trim() !== '') return app.company.trim()
  if (typeof app.workspace === 'string') {
    var parts = app.workspace.split(/[\\/]/).filter(function (p) {
      return p !== ''
    })
    if (parts.length >= 2) return parts[parts.length - 2]
  }
  return ''
}

function applicationTextValue(app, field) {
  if (!app) return ''
  var v =
    field === 'company'
      ? applicationCompanyValue(app)
      : typeof app.jobTitle === 'string'
        ? app.jobTitle.trim()
        : ''
  return v.toLowerCase()
}

/**
 * Sort a copy of the rows. Direction flips the comparison, never the
 * "missing last" rule: rows with no fit score / no applied stamp sit at the
 * bottom whether the sort climbs or falls, instead of photobombing the top
 * of an ascending sort. Ties settle by activity, newest first.
 */
function sortApplications(rows, field, dir) {
  var mul = dir === 'asc' ? 1 : -1
  var textual = field === 'company' || field === 'jobTitle'
  var out = (Array.isArray(rows) ? rows : []).slice()
  out.sort(function (a, b) {
    if (textual) {
      var t = applicationTextValue(a, field).localeCompare(
        applicationTextValue(b, field),
        undefined,
        {
          sensitivity: 'base',
          numeric: true,
        },
      )
      if (t !== 0) return t * mul
      return (Number(b && b.activity) || 0) - (Number(a && a.activity) || 0)
    }
    var an = applicationNumberValue(a, field)
    var bn = applicationNumberValue(b, field)
    var am = !isFinite(an)
    var bm = !isFinite(bn)
    if (am && bm) return (Number(b && b.activity) || 0) - (Number(a && a.activity) || 0)
    if (am) return 1
    if (bm) return -1
    var c = an - bn
    if (c !== 0) return c * mul
    return (Number(b && b.activity) || 0) - (Number(a && a.activity) || 0)
  })
  return out
}

/** Per-tag counts over the FULL listing — facet counts must not shrink as they narrow. */
function countByStatus(apps) {
  var counts = {}
  for (var i = 0; i < STATUS_ORDER.length; i++) counts[STATUS_ORDER[i]] = 0
  var list = Array.isArray(apps) ? apps : []
  for (var j = 0; j < list.length; j++) {
    counts[effectiveStatus(list[j].application)] += 1
  }
  return counts
}

/** Distinct known companies, case-folded for grouping, alphabetical. */
function facetCompanies(apps) {
  var seen = {}
  var out = []
  var list = Array.isArray(apps) ? apps : []
  for (var i = 0; i < list.length; i++) {
    var c = applicationCompanyValue(list[i])
    if (c === '') continue
    var k = c.toLowerCase()
    if (seen[k]) continue
    seen[k] = true
    out.push(c)
  }
  out.sort(function (a, b) {
    return a.localeCompare(b, undefined, { sensitivity: 'base' })
  })
  return out
}

/** How many facets are away from the quiet state — drives the Reset affordance. */
function filtersActive(f) {
  if (!f) return 0
  var n = 0
  if (Array.isArray(f.statuses) && f.statuses.length > 0) n += 1
  if (Array.isArray(f.has) && f.has.length > 0) n += 1
  if (typeof f.company === 'string' && f.company !== '') n += 1
  if (typeof f.fitBand === 'string' && f.fitBand !== 'any') n += 1
  if (typeof f.recency === 'string' && f.recency !== 'any') n += 1
  return n
}

// ------------------------- workbench preferences -------------------------
// View, sort and facets survive the panel closing — a workbench you rearrange
// every time is not a workbench. The typed QUERY deliberately does not: a
// stale search is the classic "where did everything go?" trap.

function trackerPrefsKey(sessionId) {
  return 'dsh-job-cv:tracker:' + sessionId
}

function loadTrackerPrefs(sessionId) {
  var fresh = { view: 'list', sortField: 'activity', sortDir: 'desc', filters: defaultFilters() }
  try {
    var raw = localStorage.getItem(trackerPrefsKey(sessionId))
    if (raw === null) return fresh
    var p = JSON.parse(raw)
    if (p === null || typeof p !== 'object') return fresh
    var f = defaultFilters()
    if (p.filters && typeof p.filters === 'object') {
      if (Array.isArray(p.filters.statuses)) {
        f.statuses = p.filters.statuses.filter(function (s) {
          return STATUS_ORDER.indexOf(s) !== -1
        })
      }
      if (Array.isArray(p.filters.has)) {
        f.has = p.filters.has.filter(isValidHasToken)
      }
      if (typeof p.filters.company === 'string') f.company = p.filters.company
      if (typeof p.filters.fitBand === 'string') f.fitBand = p.filters.fitBand
      if (typeof p.filters.recency === 'string') f.recency = p.filters.recency
    }
    var view = 'list'
    for (var i = 0; i < TRACKER_VIEWS.length; i++) {
      if (TRACKER_VIEWS[i].key === p.view) view = p.view
    }
    var sortField = 'activity'
    for (var j = 0; j < SORT_FIELDS.length; j++) {
      if (SORT_FIELDS[j].key === p.sortField) sortField = p.sortField
    }
    return {
      view: view,
      sortField: sortField,
      sortDir: p.sortDir === 'asc' ? 'asc' : 'desc',
      filters: f,
    }
  } catch (e) {
    return fresh
  }
}

function saveTrackerPrefs(sessionId, prefs) {
  try {
    localStorage.setItem(trackerPrefsKey(sessionId), JSON.stringify(prefs))
  } catch (e) {
    /* storage full/blocked — the workbench stays ephemeral */
  }
}

// ------------------------- data access -------------------------

function fetchApplications(sessionId) {
  return fetch('/jobcv/applications?session=' + encodeURIComponent(sessionId), {
    method: 'GET',
    headers: { 'content-type': 'application/json' },
  }).then(function (res) {
    if (!res.ok) throw new Error('applications fetch failed: ' + res.status)
    return res.json()
  })
}

/** Record where an application stands. Resolves to the host's stored shape.
 *  With several applications sharing one session (the Jobs panel switches
 *  them), the tag names its job so the host can route it into that job's
 *  own record instead of whichever one happens to be active. */
function saveStatus(sessionId, status, note, jobUrl) {
  return fetch('/jobcv/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: sessionId,
      status: status,
      note: note || '',
      jobUrl: jobUrl || undefined,
    }),
  }).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok) throw new Error((body && body.error) || 'status save failed')
      return body
    })
  })
}

/**
 * One row's identity. Rows without a candidacy folder stand alone under
 * their session id; two rows never share one.
 */
function applicationKey(app) {
  return (app && app.workspace ? app.workspace : '') + '|' + (app && app.sessionId)
}

/** What the row is called: company — job title, folder fallbacks included. */
function applicationLabel(app) {
  if (!app) return 'Untitled application'
  var company = applicationCompanyValue(app)
  if (company === '') company = 'Past application'
  var title =
    app.jobTitle && typeof app.jobTitle === 'string' && app.jobTitle.trim() !== ''
      ? app.jobTitle.trim()
      : ''
  return title === '' ? company : company + ' — ' + title
}

/** The chat message "Resume here" hands to the agent. */
function buildResumeMessage(app, sessionId) {
  var lines = ['Resume my job application' + ': ' + applicationLabel(app), '']
  if (app.workspace) lines.push('Candidacy folder: ' + app.workspace)
  if (app.jobUrl) lines.push('Job post link: ' + app.jobUrl)
  if (app.cvVersion > 0) lines.push('Latest saved CV version there: v' + app.cvVersion)
  lines.push('Session id: ' + sessionId + '  (use this exact string in every /jobcv call)')
  lines.push('')
  lines.push(
    'Open that candidacy workspace from THIS session first: POST /jobcv/workspace',
    'with the same company and job link so the upsert answers created:false and',
    'adopts that folder instead of creating a new one. Read cv/latest.html from',
    'the folder before changing anything, then continue from where I left off.',
  )
  return lines.join('\n')
}

/**
 * The optimistic display shape while a change is in flight. appliedAt is
 * kept when present (the day they applied does not move because the process
 * moved on) and stamped when a row lands on applied from nothing.
 */
function optimisticApplication(previous, status, note) {
  var prior = previous || {}
  var appliedAt =
    prior.appliedAt > 0
      ? prior.appliedAt
      : status === 'applied' || status === 'interview' || status === 'offer'
        ? Date.now()
        : 0
  return {
    status: status,
    statusUpdatedAt: Date.now(),
    appliedAt: appliedAt,
    note: note || '',
    log: [{ status: status, at: Date.now(), note: note || '' }]
      .concat(Array.isArray(prior.log) ? prior.log : [])
      .slice(0, 20),
  }
}

/**
 * The colored tag as a native select: one control reads AND edits the tag,
 * and on a phone a select is the one input that always works.
 */
function StatusSelect(props) {
  var pal = props.pal
  var value = effectiveStatus(props.application)
  var color = statusColor(value, pal.dark)
  return createElement(
    'select',
    {
      value: value,
      disabled: !!props.busy,
      'aria-label': 'Application status',
      onChange: function (e) {
        props.onChange(e.target.value)
      },
      onClick: function (e) {
        e.stopPropagation()
      },
      style: {
        appearance: 'none',
        WebkitAppearance: 'none',
        border: '1px solid ' + color,
        borderRadius: 999,
        background: pal.dark ? 'rgba(128,128,128,0.10)' : 'rgba(128,128,128,0.06)',
        color: color,
        fontSize: props.compact ? 10 : 11,
        fontWeight: 600,
        lineHeight: props.compact ? '15px' : '16px',
        padding: props.compact ? '1px 16px 1px 8px' : '2px 18px 2px 9px',
        cursor: props.busy ? 'wait' : 'pointer',
        fontFamily: 'inherit',
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='6'><path d='M0 0l4 6 4-6z' fill='" +
          (pal.dark ? '%23ffffff' : '%23000000') +
          "' fill-opacity='0.55'/></svg>\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 6px center',
      },
    },
    STATUS_ORDER.map(function (s) {
      return createElement('option', { key: s, value: s }, s)
    }),
  )
}

/** Tiny bordered chip for artifact markers ("CV v3", "68% fit"). */
function MetaChip(props) {
  return createElement(
    'span',
    {
      style: {
        border: '1px solid ' + props.pal.controlBorder,
        borderRadius: 4,
        padding: '0 6px',
        fontSize: 9,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
        color: props.color || props.pal.text,
        background: props.pal.panelBg,
      },
    },
    props.children,
  )
}

/**
 * The expanded body shared by all three views: the link, the applied stamp,
 * the artifact links, the folder, the tag's path, the note editor and the
 * way back in from another session.
 */
function ApplicationDetails(props) {
  var app = props.app
  var pal = props.pal
  var application = app.application

  var noteState = React.useState(
    application && typeof application.note === 'string' ? application.note : '',
  )
  var note = noteState[0]
  var setNote = noteState[1]

  var chip = {
    border: '1px solid ' + pal.controlBorder,
    background: pal.panelBg,
    color: pal.textStrong,
    borderRadius: 4,
    padding: '1px 7px',
    fontSize: 10,
    lineHeight: '16px',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
  }

  var artifacts = []
  if (app.workspace) {
    if (app.cvVersion > 0) {
      artifacts.push({
        name: 'latest CV',
        url:
          '/jobcv/file?session=' +
          encodeURIComponent(app.sessionId) +
          '&name=' +
          encodeURIComponent('cv/latest.html'),
      })
    }
    if (app.letterVersion > 0) {
      artifacts.push({
        name: 'cover letter',
        url:
          '/jobcv/file?session=' +
          encodeURIComponent(app.sessionId) +
          '&name=' +
          encodeURIComponent('letter/latest.html'),
      })
    }
    if (app.postChars > 0) {
      artifacts.push({
        name: 'job post',
        url:
          '/jobcv/file?session=' +
          encodeURIComponent(app.sessionId) +
          '&name=' +
          encodeURIComponent('notes/job-post.txt'),
      })
    }
  }

  return createElement(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        borderTop: '1px solid ' + pal.panelBorder,
        paddingTop: 8,
      },
      onClick: function (e) {
        e.stopPropagation()
      },
    },
    app.jobUrl
      ? createElement(
          'a',
          {
            href: app.jobUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: {
              fontSize: 11,
              color: pal.accent,
              textDecoration: 'none',
              wordBreak: 'break-all',
            },
          },
          app.jobUrl + ' ↗',
        )
      : null,
    application && application.appliedAt > 0
      ? createElement(
          'div',
          { style: { fontSize: 11, color: pal.text } },
          'applied ' + shortDate(application.appliedAt),
        )
      : null,
    artifacts.length > 0
      ? createElement(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          artifacts.map(function (a) {
            return createElement(
              'a',
              {
                key: a.name,
                href: a.url,
                target: '_blank',
                rel: 'noopener noreferrer',
                style: chip,
              },
              a.name + ' ↗',
            )
          }),
        )
      : null,
    app.workspace
      ? createElement(
          'div',
          {
            title: app.workspace,
            style: {
              fontSize: 10,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              color: pal.text,
              wordBreak: 'break-all',
            },
          },
          app.workspace,
        )
      : null,
    application && Array.isArray(application.log) && application.log.length > 0
      ? createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          application.log.slice(0, 6).map(function (entry, i) {
            return createElement(
              'div',
              { key: i, style: { fontSize: 10, color: pal.text } },
              createElement(
                'span',
                {
                  style: {
                    color: statusColor(entry.status, pal.dark),
                    fontWeight: 600,
                  },
                },
                entry.status,
              ),
              entry.at > 0 ? ' · ' + relTime(entry.at) : '',
              entry.note ? ' · ' + entry.note : '',
            )
          }),
        )
      : null,
    createElement(
      'div',
      { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
      createElement('input', {
        value: note,
        placeholder: 'note — interview Friday 14:00, recruiter name…',
        onChange: function (e) {
          setNote(e.target.value)
        },
        style: {
          flex: 1,
          minWidth: 160,
          boxSizing: 'border-box',
          fontSize: 12,
          padding: '5px 8px',
          borderRadius: 6,
          border: '1px solid ' + pal.controlBorder,
          background: pal.dark ? 'rgba(0,0,0,0.25)' : '#fff',
          color: pal.textStrong,
          fontFamily: 'inherit',
        },
      }),
      createElement(
        'button',
        {
          type: 'button',
          disabled: props.busy,
          onClick: function () {
            props.onNoteSave(note)
          },
          style: Object.assign({}, chip, {
            cursor: props.busy ? 'wait' : 'pointer',
            padding: '4px 10px',
          }),
        },
        'Save note',
      ),
    ),
    !props.isCurrent && app.workspace
      ? createElement(
          'button',
          {
            type: 'button',
            onClick: props.onResume,
            style: Object.assign({}, chip, {
              cursor: 'pointer',
              padding: '4px 10px',
              alignSelf: 'flex-start',
            }),
          },
          'Resume here ↗',
        )
      : null,
  )
}

/** One LIST-view row: the collapsed summary, expanding into the shared details. */
function ApplicationRow(props) {
  var app = props.app
  var pal = props.pal
  var expanded = props.expanded
  var application = app.application
  var isCurrent = app.sessionId === props.currentSessionId

  var metaBits = []
  if (app.cvVersion > 0) metaBits.push({ text: 'CV v' + app.cvVersion })
  else metaBits.push({ text: 'no CV yet', dim: true })
  if (app.letterVersion > 0) metaBits.push({ text: 'letter v' + app.letterVersion })
  if (app.postChars > 0) metaBits.push({ text: 'post ✓' })
  if (typeof app.fitScore === 'number') {
    metaBits.push({
      text: app.fitScore + '% fit',
      color: fitColor(app.fitScore, pal.dark),
    })
  }

  return createElement(
    'div',
    {
      style: {
        border: '1px solid ' + (isCurrent ? pal.accent : pal.panelBorder),
        borderRadius: 8,
        padding: '9px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: isCurrent
          ? pal.dark
            ? 'rgba(122,184,255,0.07)'
            : 'rgba(46,111,219,0.05)'
          : 'transparent',
      },
    },
    createElement(
      'div',
      {
        onClick: props.onToggleExpand,
        style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, cursor: 'pointer' },
      },
      createElement(StatusSelect, {
        pal: pal,
        application: application,
        busy: props.busy,
        onChange: props.onStatusChange,
      }),
      createElement(
        'span',
        {
          title: app.workspace || '',
          style: {
            flex: 1,
            minWidth: 0,
            fontWeight: 600,
            fontSize: 12,
            color: pal.textStrong,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        },
        applicationLabel(app),
      ),
      isCurrent
        ? createElement(
            'span',
            {
              style: {
                fontSize: 10,
                color: pal.accent,
                border: '1px solid ' + pal.accent,
                borderRadius: 999,
                padding: '0 7px',
                whiteSpace: 'nowrap',
              },
            },
            'this session',
          )
        : null,
      createElement(
        'span',
        { style: { fontSize: 10, color: pal.text, whiteSpace: 'nowrap' } },
        relTime(app.activity),
      ),
      createElement(
        'button',
        {
          type: 'button',
          onClick: props.onToggleExpand,
          title: expanded ? 'Hide details' : 'Show details',
          style: {
            border: '1px solid ' + pal.controlBorder,
            background: pal.panelBg,
            color: pal.textStrong,
            borderRadius: 4,
            padding: '1px 6px',
            fontSize: 10,
            lineHeight: '16px',
            cursor: 'pointer',
            fontFamily: 'inherit',
          },
        },
        expanded ? '▾' : '▸',
      ),
    ),
    createElement(
      'div',
      {
        style: {
          fontSize: 11,
          color: pal.text,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          alignItems: 'center',
        },
      },
      metaBits.map(function (b, i) {
        return createElement(MetaChip, { key: i, pal: pal, color: b.color }, b.text)
      }),
      application && application.appliedAt > 0
        ? createElement(
            'span',
            { style: { fontSize: 10, color: pal.text } },
            'applied ' + shortDate(application.appliedAt),
          )
        : null,
    ),
    !expanded && application && application.note
      ? createElement(
          'div',
          {
            style: {
              fontSize: 11,
              color: pal.textStrong,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          application.note,
        )
      : null,
    expanded
      ? createElement(ApplicationDetails, {
          app: app,
          pal: pal,
          isCurrent: isCurrent,
          busy: props.busy,
          onNoteSave: props.onNoteSave,
          onResume: props.onResume,
        })
      : null,
  )
}

/** One BOARD card: the same row compressed to what a stage scan needs. */
function BoardCard(props) {
  var app = props.app
  var pal = props.pal
  var expanded = props.expanded
  var application = app.application

  return createElement(
    'div',
    {
      style: {
        border: '1px solid ' + (expanded ? pal.accent : pal.panelBorder),
        borderRadius: 8,
        padding: '8px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        background: pal.panelBg,
        cursor: 'pointer',
      },
      onClick: props.onToggleExpand,
    },
    createElement(
      'div',
      {
        title: app.workspace || '',
        style: {
          fontWeight: 600,
          fontSize: 11,
          color: pal.textStrong,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          wordBreak: 'break-word',
        },
      },
      applicationLabel(app),
    ),
    createElement(StatusSelect, {
      pal: pal,
      application: application,
      busy: props.busy,
      compact: true,
      onChange: props.onStatusChange,
    }),
    createElement(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' } },
      createElement('span', { style: { fontSize: 9, color: pal.text } }, relTime(app.activity)),
      typeof app.fitScore === 'number'
        ? createElement(
            'span',
            { style: { fontSize: 9, fontWeight: 600, color: fitColor(app.fitScore, pal.dark) } },
            app.fitScore + '%',
          )
        : null,
      application && application.appliedAt > 0
        ? createElement(
            'span',
            { style: { fontSize: 9, color: pal.text } },
            '· ' + shortDate(application.appliedAt),
          )
        : null,
    ),
    application && application.note && !expanded
      ? createElement(
          'div',
          {
            style: {
              fontSize: 10,
              color: pal.textStrong,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          application.note,
        )
      : null,
    expanded
      ? createElement(ApplicationDetails, {
          app: app,
          pal: pal,
          isCurrent: app.sessionId === props.currentSessionId,
          busy: props.busy,
          onNoteSave: props.onNoteSave,
          onResume: props.onResume,
        })
      : null,
  )
}

/** The BOARD: five stage columns, the pipeline as a glance. */
function BoardView(props) {
  var pal = props.pal

  function appsInStage(stage) {
    var out = []
    for (var i = 0; i < props.apps.length; i++) {
      if (effectiveStatus(props.apps[i].application) === stage) out.push(props.apps[i])
    }
    return out
  }

  var columns = []
  for (var i = 0; i < STATUS_ORDER.length; i++) {
    var status = STATUS_ORDER[i]
    var colApps = appsInStage(status)

    columns.push(
      createElement(
        'div',
        {
          key: status,
          style: {
            flex: '1 0 168px',
            minWidth: 168,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          },
        },
        createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: statusColor(status, pal.dark),
              paddingBottom: 2,
              borderBottom: '1px solid ' + pal.panelBorder,
            },
          },
          createElement('span', null, status),
          createElement(
            'span',
            { style: { fontWeight: 400, opacity: 0.75 } },
            String(colApps.length),
          ),
        ),
        colApps.length === 0
          ? createElement(
              'div',
              {
                style: {
                  border: '1px dashed ' + pal.panelBorder,
                  borderRadius: 8,
                  fontSize: 10,
                  color: pal.text,
                  textAlign: 'center',
                  padding: '10px 6px',
                },
              },
              '—',
            )
          : colApps.map(function (app) {
              var key = applicationKey(app)
              return createElement(BoardCard, {
                key: key,
                app: app,
                pal: pal,
                currentSessionId: props.currentSessionId,
                busy: props.busyKey === key,
                expanded: props.expandedKey === key,
                onToggleExpand: function () {
                  props.onToggleExpand(key)
                },
                onStatusChange: function (status2) {
                  props.onStatusChange(app, status2)
                },
                onNoteSave: function (text) {
                  props.onNoteSave(app, text)
                },
                onResume: function () {
                  props.onResume(app)
                },
              })
            }),
      ),
    )
  }
  return createElement(
    'div',
    {
      style: {
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        overflowX: 'auto',
        paddingBottom: 4,
      },
    },
    columns,
  )
}

/** The TABLE: every axis as a column, every header a sort button. */
function TableView(props) {
  var pal = props.pal

  function headerButton(label, field, extra) {
    var active = props.sortField === field
    return createElement(
      'button',
      {
        type: 'button',
        onClick: function () {
          props.onSortField(field)
        },
        title: 'Sort by ' + label.toLowerCase(),
        style: {
          border: 'none',
          background: 'transparent',
          color: active ? pal.textStrong : pal.text,
          fontWeight: active ? 700 : 400,
          fontSize: 10,
          cursor: 'pointer',
          fontFamily: 'inherit',
          padding: '2px 4px',
          textAlign: 'left',
          whiteSpace: 'nowrap',
        },
      },
      label,
      active ? (props.sortDir === 'asc' ? ' ▲' : ' ▼') : '',
      extra || '',
    )
  }

  var head = createElement(
    'tr',
    null,
    createElement('th', { style: thStyle(pal) }, headerButton('Role', 'jobTitle')),
    createElement('th', { style: thStyle(pal) }, headerButton('Stage', 'status')),
    createElement('th', { style: thStyle(pal) }, headerButton('Fit', 'fitScore')),
    createElement('th', { style: thStyle(pal) }, headerButton('Applied', 'appliedAt')),
    createElement('th', { style: thStyle(pal) }, headerButton('Updated', 'activity')),
  )

  var rows = props.apps.map(function (app) {
    var key = applicationKey(app)
    var expanded = props.expandedKey === key
    var isCurrent = app.sessionId === props.currentSessionId
    var application = app.application
    var cells = [
      createElement(
        'td',
        { key: 'role', style: tdStyle(pal, { maxWidth: 260 }) },
        isCurrent
          ? createElement(
              'span',
              { title: 'this session', style: { color: pal.accent, marginRight: 4 } },
              '●',
            )
          : null,
        createElement(
          'span',
          {
            title: app.workspace || '',
            style: { color: pal.textStrong, fontWeight: 600 },
          },
          applicationLabel(app),
        ),
      ),
      createElement(
        'td',
        { key: 'stage', style: tdStyle(pal) },
        createElement(StatusSelect, {
          pal: pal,
          application: application,
          busy: props.busyKey === key,
          compact: true,
          onChange: function (status) {
            props.onStatusChange(app, status)
          },
        }),
      ),
      createElement(
        'td',
        {
          key: 'fit',
          style: tdStyle(pal, {
            color: typeof app.fitScore === 'number' ? fitColor(app.fitScore, pal.dark) : pal.text,
            fontWeight: typeof app.fitScore === 'number' ? 600 : 400,
          }),
        },
        typeof app.fitScore === 'number' ? app.fitScore + '%' : '—',
      ),
      createElement(
        'td',
        { key: 'applied', style: tdStyle(pal) },
        application && application.appliedAt > 0 ? shortDate(application.appliedAt) : '—',
      ),
      createElement('td', { key: 'activity', style: tdStyle(pal) }, relTime(app.activity) || '—'),
    ]
    return [
      createElement(
        'tr',
        {
          key: key,
          onClick: function () {
            props.onToggleExpand(key)
          },
          style: { cursor: 'pointer', background: expanded ? pal.panelBg : 'transparent' },
        },
        cells,
      ),
      expanded
        ? createElement(
            'tr',
            { key: key + ':details' },
            createElement(
              'td',
              { colSpan: 5, style: Object.assign({}, tdStyle(pal), { cursor: 'default' }) },
              createElement(ApplicationDetails, {
                app: app,
                pal: pal,
                isCurrent: isCurrent,
                busy: props.busyKey === key,
                onNoteSave: function (text) {
                  props.onNoteSave(app, text)
                },
                onResume: function () {
                  props.onResume(app)
                },
              }),
            ),
          )
        : null,
    ]
  })

  return createElement(
    'div',
    { style: { overflowX: 'auto' } },
    createElement(
      'table',
      { style: { borderCollapse: 'collapse', width: '100%', minWidth: 520 } },
      createElement('thead', null, head),
      createElement('tbody', null, flatten(rows)),
    ),
  )
}

function thStyle(pal) {
  return {
    borderBottom: '1px solid ' + pal.controlBorder,
    padding: '3px 6px',
    textAlign: 'left',
    fontSize: 10,
    color: pal.text,
    fontWeight: 400,
    whiteSpace: 'nowrap',
  }
}

function tdStyle(pal, extra) {
  return Object.assign(
    {
      borderBottom: '1px solid ' + pal.panelBorder,
      padding: '5px 6px',
      fontSize: 11,
      color: pal.text,
      verticalAlign: 'middle',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    extra || {},
  )
}

/** Small helper: [[a, b], [c]] → [a, b, c] for table children. */
function flatten(lists) {
  var out = []
  for (var i = 0; i < lists.length; i++) {
    var item = lists[i]
    if (Array.isArray(item)) {
      for (var j = 0; j < item.length; j++) if (item[j] !== null) out.push(item[j])
    } else if (item !== null) {
      out.push(item)
    }
  }
  return out
}

/**
 * The Applications workbench: a dialog over everything, opened from the
 * dock. Fetches its list when it opens and after every successful change;
 * Esc, the ✕, or a backdrop click close it. Search, three views, spec-driven
 * filters and a sort live in a fixed control deck above the scrolling body;
 * the chosen arrangement persists per session (the typed query does not).
 */
function ApplicationsPanel(props) {
  var pal = props.pal
  var sessionId = props.sessionId
  var viewportW = useViewportWidth()

  var appsState = React.useState(null) // null = still loading
  var apps = appsState[0]
  var setApps = appsState[1]
  var errorState = React.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var busyKeyState = React.useState(null)
  var busyKey = busyKeyState[0]
  var setBusyKey = busyKeyState[1]
  var expandedKeyState = React.useState(null)
  var expandedKey = expandedKeyState[0]
  var setExpandedKey = expandedKeyState[1]

  // The workbench arrangement, seeded once from the session's saved layout.
  var prefsSeed = React.useState(function () {
    return loadTrackerPrefs(sessionId)
  })
  var viewState = React.useState(prefsSeed[0].view)
  var view = viewState[0]
  var setView = viewState[1]
  var sortFieldState = React.useState(prefsSeed[0].sortField)
  var sortField = sortFieldState[0]
  var setSortField = sortFieldState[1]
  var sortDirState = React.useState(prefsSeed[0].sortDir)
  var sortDir = sortDirState[0]
  var setSortDir = sortDirState[1]
  var filtersState = React.useState(prefsSeed[0].filters)
  var filters = filtersState[0]
  var setFilters = filtersState[1]
  var queryState = React.useState('')
  var query = queryState[0]
  var setQuery = queryState[1]

  var searchRef = React.useRef(null)

  // Persist the arrangement whenever it moves. The query is intentionally
  // absent — reopening to a pre-typed search reads as lost applications.
  React.useEffect(
    function () {
      saveTrackerPrefs(sessionId, {
        view: view,
        sortField: sortField,
        sortDir: sortDir,
        filters: filters,
      })
    },
    [sessionId, view, sortField, sortDir, filters],
  )

  function refresh() {
    return fetchApplications(sessionId)
      .then(function (data) {
        setApps(Array.isArray(data.applications) ? data.applications : [])
        setError(null)
        return data
      })
      .catch(function (err) {
        setApps(function (prev) {
          return prev === null ? [] : prev
        })
        setError(String(err && err.message ? err.message : err))
        return null
      })
  }

  React.useEffect(
    function () {
      var alive = true
      fetchApplications(sessionId)
        .then(function (data) {
          if (alive) setApps(Array.isArray(data.applications) ? data.applications : [])
        })
        .catch(function (err) {
          if (alive) {
            setApps([])
            setError(String(err && err.message ? err.message : err))
          }
        })
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
        // "/" reaches the search from anywhere — unless typing elsewhere.
        var t = e.target
        var typing =
          t &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.tagName === 'SELECT' ||
            t.isContentEditable === true)
        if (e.key === '/' && !typing) {
          e.preventDefault()
          if (searchRef.current) searchRef.current.focus()
        }
      }
      document.addEventListener('keydown', onKey)
      return function () {
        document.removeEventListener('keydown', onKey)
      }
    },
    [props.onClose],
  )

  function commitChange(app, status, noteOverride) {
    var key = applicationKey(app)
    var note =
      noteOverride !== undefined
        ? noteOverride
        : app.application && typeof app.application.note === 'string'
          ? app.application.note
          : ''
    setBusyKey(key)
    setApps(function (prev) {
      if (!Array.isArray(prev)) return prev
      return prev.map(function (a) {
        return applicationKey(a) === key
          ? Object.assign({}, a, {
              application: optimisticApplication(a.application, status, note),
            })
          : a
      })
    })
    saveStatus(app.sessionId, status, note, app.jobUrl)
      .then(function (body) {
        setBusyKey(null)
        setApps(function (prev) {
          if (!Array.isArray(prev)) return prev
          return prev.map(function (a) {
            return applicationKey(a) === key
              ? Object.assign({}, a, { application: body.application })
              : a
          })
        })
        setError(null)
        if (props.onBadge) props.onBadge()
      })
      .catch(function (err) {
        setBusyKey(null)
        setError(String(err && err.message ? err.message : err))
        refresh() // snap back to what the host actually has
      })
  }

  function resumeHere(app) {
    var outcome = deliverToComposer(
      props.inputActions,
      buildResumeMessage(app, sessionId),
      props.draft,
    )
    if (outcome === 'sent') {
      props.onClose()
      return
    }
    setError(deliveryNotice(outcome) || 'could not reach the composer')
  }

  function patchFilters(part) {
    setFilters(function (prev) {
      return Object.assign({}, prev, part)
    })
  }

  function toggleInList(list, value) {
    var out = []
    var had = false
    for (var i = 0; i < list.length; i++) {
      if (list[i] === value) had = true
      else out.push(list[i])
    }
    if (!had) out.push(value)
    return out
  }

  function pickSortField(field) {
    if (field === sortField) {
      // Same column again: flip it. The one gesture a sortable header owes.
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir(defaultDirFor(field))
    }
  }

  var counts = countByStatus(apps)
  var total = Array.isArray(apps) ? apps.length : 0

  var visible =
    apps === null
      ? []
      : sortApplications(filterApplications(apps, query, filters), sortField, sortDir)
  var hiddenCount = total - visible.length

  var companies = facetCompanies(apps)

  var W = Math.min(880, Math.max(280, viewportW - 16))
  var H = Math.min(720, (typeof window !== 'undefined' ? window.innerHeight : 800) - 32)
  var narrow = viewportW < 640

  var controlBorder = {
    border: '1px solid ' + pal.controlBorder,
    background: pal.controlBg,
    color: pal.textStrong,
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 11,
    lineHeight: '16px',
    padding: '4px 8px',
  }

  function selectStyle(extra) {
    return Object.assign(
      {
        appearance: 'none',
        WebkitAppearance: 'none',
        border: '1px solid ' + pal.controlBorder,
        borderRadius: 6,
        background: pal.dark ? 'rgba(0,0,0,0.25)' : '#fff',
        color: pal.textStrong,
        fontSize: 11,
        lineHeight: '16px',
        padding: '3px 20px 3px 8px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='6'><path d='M0 0l4 6 4-6z' fill='" +
          (pal.dark ? '%23ffffff' : '%23000000') +
          "' fill-opacity='0.55'/></svg>\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 7px center',
        maxWidth: 150,
      },
      extra || {},
    )
  }

  function facetChip(token, label, active, onClick, color) {
    return createElement(
      'button',
      {
        key: token,
        type: 'button',
        'aria-pressed': !!active,
        onClick: onClick,
        title: (active ? 'Stop filtering by ' : 'Filter by ') + label.toLowerCase(),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          border: '1px solid ' + (active ? color || pal.accent : pal.controlBorder),
          borderRadius: 999,
          background: active
            ? pal.dark
              ? 'rgba(128,128,128,0.18)'
              : 'rgba(128,128,128,0.10)'
            : 'transparent',
          color: active ? color || pal.textStrong : pal.text,
          fontSize: 10,
          lineHeight: '16px',
          padding: '1px 9px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
        },
      },
      color
        ? createElement('span', {
            'aria-hidden': 'true',
            style: {
              width: 7,
              height: 7,
              borderRadius: 999,
              background: color,
              flexShrink: 0,
            },
          })
        : null,
      label,
    )
  }

  var statusChips = STATUS_ORDER.map(function (s) {
    var active = filters.statuses.indexOf(s) !== -1
    return facetChip(
      s,
      s + ' ' + counts[s],
      active,
      function () {
        patchFilters({ statuses: toggleInList(filters.statuses, s) })
      },
      statusColor(s, pal.dark),
    )
  })

  var hasChips = HAS_TOKENS.map(function (h) {
    var active = filters.has.indexOf(h.key) !== -1
    return facetChip(h.key.toLowerCase(), h.label, active, function () {
      patchFilters({ has: toggleInList(filters.has, h.key) })
    })
  })

  var anyNarrowing = query.trim() !== '' || filtersActive(filters) > 0

  var viewButtons = TRACKER_VIEWS.map(function (v) {
    var active = view === v.key
    return createElement(
      'button',
      {
        key: v.key,
        type: 'button',
        'aria-pressed': !!active,
        onClick: function () {
          setView(v.key)
        },
        title: v.label + ' view',
        style: {
          border: 'none',
          background: active ? pal.controlActive : 'transparent',
          color: active ? pal.textStrong : pal.text,
          fontSize: 11,
          lineHeight: '18px',
          padding: '2px 10px',
          borderRadius: 5,
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontWeight: active ? 600 : 400,
        },
      },
      v.label,
    )
  })

  var body = null
  if (apps === null) {
    body = createElement(
      'div',
      { style: { fontSize: 11, color: pal.text, padding: '8px 2px' } },
      'Loading…',
    )
  } else if (total === 0) {
    body = createElement(
      'div',
      { style: { fontSize: 12, color: pal.text, padding: '10px 2px', lineHeight: 1.5 } },
      'No applications yet. Start one from the preview: paste a job post link and your CV, and every application lands here with its own status.',
    )
  } else if (visible.length === 0) {
    body = createElement(
      'div',
      { style: { padding: '18px 4px', textAlign: 'center' } },
      createElement(
        'div',
        { style: { fontSize: 12, color: pal.textStrong, marginBottom: 6 } },
        'Nothing matches',
      ),
      createElement(
        'div',
        { style: { fontSize: 11, color: pal.text, marginBottom: 10, lineHeight: 1.5 } },
        hiddenCount +
          ' of ' +
          total +
          ' ' +
          (total === 1 ? 'application is' : 'applications are') +
          ' hidden by the current search and filters.',
      ),
      createElement(
        'button',
        {
          type: 'button',
          onClick: function () {
            setQuery('')
            setFilters(defaultFilters())
          },
          style: controlBorder,
        },
        'Show everything',
      ),
    )
  } else if (view === 'list') {
    body = createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      visible.map(function (app) {
        var key = applicationKey(app)
        return createElement(ApplicationRow, {
          key: key,
          app: app,
          pal: pal,
          currentSessionId: sessionId,
          busy: busyKey === key,
          expanded: expandedKey === key,
          onToggleExpand: function () {
            setExpandedKey(expandedKey === key ? null : key)
          },
          onStatusChange: function (status) {
            commitChange(app, status)
          },
          onNoteSave: function (text) {
            commitChange(app, effectiveStatus(app.application), text)
          },
          onResume: function () {
            resumeHere(app)
          },
        })
      }),
    )
  } else if (view === 'board') {
    body = createElement(BoardView, {
      apps: visible,
      pal: pal,
      currentSessionId: sessionId,
      busyKey: busyKey,
      expandedKey: expandedKey,
      onToggleExpand: function (key) {
        setExpandedKey(expandedKey === key ? null : key)
      },
      onStatusChange: function (app, status) {
        commitChange(app, status)
      },
      onNoteSave: function (app, text) {
        commitChange(app, effectiveStatus(app.application), text)
      },
      onResume: function (app) {
        resumeHere(app)
      },
    })
  } else {
    body = createElement(TableView, {
      apps: visible,
      pal: pal,
      currentSessionId: sessionId,
      busyKey: busyKey,
      expandedKey: expandedKey,
      sortField: sortField,
      sortDir: sortDir,
      onSortField: pickSortField,
      onToggleExpand: function (key) {
        setExpandedKey(expandedKey === key ? null : key)
      },
      onStatusChange: function (app, status) {
        commitChange(app, status)
      },
      onNoteSave: function (app, text) {
        commitChange(app, effectiveStatus(app.application), text)
      },
      onResume: function (app) {
        resumeHere(app)
      },
    })
  }

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
          'aria-label': 'Applications',
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
        // ---- header ----
        createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px 8px',
            },
          },
          createElement(
            'span',
            { style: { fontSize: 13, fontWeight: 700, color: pal.textStrong } },
            'Applications',
          ),
          createElement(
            'span',
            { style: { fontSize: 10, color: pal.text } },
            apps === null ? '' : total === 0 ? 'nothing tracked yet' : total + ' tracked',
          ),
          createElement('span', { style: { flex: 1 } }),
          createElement(
            'button',
            {
              type: 'button',
              onClick: props.onClose,
              title: 'Close (Esc)',
              style: {
                border: '1px solid ' + pal.controlBorder,
                background: pal.controlBg,
                color: pal.textStrong,
                borderRadius: 6,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 12,
                lineHeight: '16px',
                padding: '2px 8px',
              },
            },
            '✕',
          ),
        ),
        // ---- control deck ----
        createElement(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
              padding: narrow ? '0 10px 8px' : '0 12px 9px',
              borderBottom: '1px solid ' + pal.panelBorder,
            },
          },
          // search + views
          createElement(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 } },
            createElement(
              'div',
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  border: '1px solid ' + pal.controlBorder,
                  borderRadius: 6,
                  background: pal.dark ? 'rgba(0,0,0,0.25)' : '#fff',
                  padding: '0 4px 0 8px',
                },
              },
              createElement(
                'span',
                { 'aria-hidden': 'true', style: { color: pal.text, fontSize: 11 } },
                '⌕',
              ),
              createElement('input', {
                ref: searchRef,
                value: query,
                placeholder: 'Search company, role, link, note…  ( / )',
                'aria-label': 'Search applications',
                onChange: function (e) {
                  setQuery(e.target.value)
                },
                style: {
                  flex: 1,
                  minWidth: 0,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: pal.textStrong,
                  fontSize: 12,
                  lineHeight: '26px',
                  fontFamily: 'inherit',
                },
              }),
              query !== ''
                ? createElement(
                    'button',
                    {
                      type: 'button',
                      onClick: function () {
                        setQuery('')
                        if (searchRef.current) searchRef.current.focus()
                      },
                      title: 'Clear search',
                      style: {
                        border: 'none',
                        background: 'transparent',
                        color: pal.text,
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '0 4px',
                        fontFamily: 'inherit',
                      },
                    },
                    '✕',
                  )
                : null,
            ),
            createElement(
              'div',
              {
                role: 'group',
                'aria-label': 'View',
                style: {
                  display: 'inline-flex',
                  border: '1px solid ' + pal.controlBorder,
                  borderRadius: 6,
                  padding: 1,
                  flexShrink: 0,
                },
              },
              viewButtons,
            ),
          ),
          // stages
          createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
            statusChips,
          ),
          // spec facets + sort + result count
          createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
            hasChips,
            companies.length > 1
              ? createElement(
                  'select',
                  {
                    value: filters.company,
                    'aria-label': 'Filter by company',
                    title: 'Company',
                    onChange: function (e) {
                      patchFilters({ company: e.target.value })
                    },
                    style: selectStyle(),
                  },
                  createElement('option', { value: '' }, 'all companies'),
                  companies.map(function (c) {
                    return createElement('option', { key: c, value: c }, c)
                  }),
                )
              : null,
            createElement(
              'select',
              {
                value: filters.fitBand,
                'aria-label': 'Filter by fit score',
                title: 'Fit score',
                onChange: function (e) {
                  patchFilters({ fitBand: e.target.value })
                },
                style: selectStyle(),
              },
              FIT_BAND_OPTIONS.map(function (o) {
                return createElement('option', { key: o.key, value: o.key }, o.label)
              }),
            ),
            createElement(
              'select',
              {
                value: filters.recency,
                'aria-label': 'Filter by recent activity',
                title: 'Last movement',
                onChange: function (e) {
                  patchFilters({ recency: e.target.value })
                },
                style: selectStyle(),
              },
              RECENCY_OPTIONS.map(function (o) {
                return createElement('option', { key: o.key, value: o.key }, o.label)
              }),
            ),
            createElement(
              'select',
              {
                value: sortField,
                'aria-label': 'Sort applications by',
                title: 'Sort',
                onChange: function (e) {
                  pickSortField(e.target.value)
                },
                style: selectStyle(),
              },
              SORT_FIELDS.map(function (o) {
                return createElement('option', { key: o.key, value: o.key }, o.label)
              }),
            ),
            createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
                },
                title:
                  sortDir === 'asc'
                    ? 'Ascending — flip to descending'
                    : 'Descending — flip to ascending',
                style: Object.assign({}, controlBorder, {
                  padding: '3px 7px',
                  flexShrink: 0,
                }),
              },
              sortDir === 'asc' ? '↑' : '↓',
            ),
            createElement('span', { style: { flex: 1 } }),
            anyNarrowing
              ? createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: function () {
                      setQuery('')
                      setFilters(defaultFilters())
                    },
                    title: 'Clear search and every filter',
                    style: Object.assign({}, controlBorder, {
                      border: 'none',
                      background: 'transparent',
                      color: pal.accent,
                      textDecoration: 'underline',
                      padding: '3px 4px',
                    }),
                  },
                  'reset',
                )
              : null,
            createElement(
              'span',
              { style: { fontSize: 10, color: pal.text, whiteSpace: 'nowrap' } },
              apps === null
                ? ''
                : total === 0
                  ? ''
                  : hiddenCount > 0
                    ? visible.length + ' of ' + total
                    : String(visible.length),
            ),
          ),
        ),
        // ---- body ----
        createElement(
          'div',
          {
            style: {
              overflowY: 'auto',
              padding: 10,
              overscrollBehavior: 'contain',
            },
          },
          body,
          error
            ? createElement(
                'div',
                { style: { marginTop: 8, fontSize: 11, color: pal.dark ? '#ffb4a2' : '#b3261e' } },
                error,
              )
            : null,
        ),
      ),
    ),
    document.body,
  )
}

/** Ascending reads naturally for names; recency axes start descending. */
function defaultDirFor(field) {
  if (field === 'company' || field === 'jobTitle' || field === 'status') return 'asc'
  return 'desc'
}
