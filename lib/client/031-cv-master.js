// ------------------------- vs master: what tailoring changed -------------------------
// The master CV is the source of truth; every tailored application differs
// from it by exactly the parts this candidacy moved. The host computes that
// difference mechanically (normalized text blocks + LCS — see lib/store/
// cv-diff.js), so the panel costs one small GET and renders only what
// changed. This is also the compact view the agent is told to read before
// proposing a fold-back of improvements into the master.
//
// The button lives in the preview toolbar (only when a master exists — the
// /jobcv/doc projection carries masterVersion for exactly that decision),
// and the panel reads once on open: like History, it describes a moment,
// and says so when the document moves underneath it.

function fetchDelta(sessionId, kind) {
  return fetch(
    '/jobcv/delta?session=' +
      encodeURIComponent(sessionId) +
      (kind === 'letter' ? '&kind=letter' : ''),
    { method: 'GET', headers: { 'content-type': 'application/json' } },
  ).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok) throw new Error((body && body.error) || 'delta fetch failed')
      return body
    })
  })
}

function DeltaChip(op, pal) {
  var tone =
    op === 'add'
      ? pal.dark
        ? '#7fd89b'
        : '#1b7f3b'
      : op === 'del'
        ? pal.dark
          ? '#ffb4a2'
          : '#b3261e'
        : pal.text
  return createElement(
    'span',
    {
      style: {
        color: tone,
        border: '1px solid ' + tone,
        borderRadius: 4,
        padding: '0 6px',
        fontSize: 10,
        lineHeight: '15px',
        fontWeight: 700,
        flex: 'none',
        fontFamily: 'inherit',
      },
    },
    op === 'add' ? '+' : '\u2212',
  )
}

function MasterDeltaPanel(props) {
  var pal = props.pal
  var delta = props.delta
  var loading = props.loading
  var error = props.error
  var stale = props.stale

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

  var changes = delta && Array.isArray(delta.changes) ? delta.changes : []
  var empty = delta && delta.empty ? delta.empty : ''

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
        gap: 8,
        maxHeight: '58%',
        overflow: 'auto',
      },
    },
    // ---- header: what this panel is, and the way out ----
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
      createElement(
        'span',
        { style: { fontSize: 13, fontWeight: 600, color: pal.textStrong, flex: 1 } },
        'What tailoring changed against your master CV',
      ),
      createElement('button', { type: 'button', onClick: props.onClose, style: btn }, 'Close'),
    ),
    loading
      ? createElement('div', { style: { fontSize: 12, color: pal.text } }, 'Comparing…')
      : null,
    error
      ? createElement(
          'div',
          { style: { fontSize: 12, color: pal.accent, lineHeight: '18px' } },
          error,
        )
      : null,
    // ---- the two honest empty states ----
    !loading && !error && empty === 'no-master'
      ? createElement(
          'div',
          { style: { fontSize: 12, color: pal.text, lineHeight: '18px' } },
          'There is no master CV yet. Save your full, untailored CV with POST /jobcv/master' +
            ' (or ask the agent to set it up from any CV you have) and every application after' +
            ' that starts from it — with this panel showing exactly what each one changed.',
        )
      : null,
    !loading && !error && empty === 'no-document'
      ? createElement(
          'div',
          { style: { fontSize: 12, color: pal.text, lineHeight: '18px' } },
          'Nothing to compare yet — save the tailored CV first.',
        )
      : null,
    // ---- counts line: how much moved, and against which versions ----
    !loading && !error && !empty && delta
      ? createElement(
          'div',
          { style: { fontSize: 11, color: stale ? pal.accent : pal.text } },
          delta.added +
            (delta.added === 1 ? ' addition' : ' additions') +
            ' · ' +
            delta.removed +
            (delta.removed === 1 ? ' removal' : ' removals') +
            ' · ' +
            delta.same +
            ' unchanged' +
            (delta.truncated ? ' · showing the first ' + changes.length : '') +
            ' — CV v' +
            delta.targetVersion +
            ' against master v' +
            delta.masterVersion +
            (stale ? ' · the document moved since this was computed; close and reopen' : ''),
        )
      : null,
    // ---- the changes themselves: what this candidacy gained and left out ----
    !loading && !error && !empty
      ? changes.map(function (change, index) {
          return createElement(
            'div',
            {
              key: index,
              style: {
                display: 'flex',
                alignItems: 'flex-start',
                gap: 7,
                padding: '5px 8px',
                borderRadius: 6,
                border:
                  '1px solid ' +
                  (change.op === 'add'
                    ? pal.dark
                      ? 'rgba(127,216,155,0.35)'
                      : 'rgba(27,127,59,0.30)'
                    : pal.dark
                      ? 'rgba(255,180,162,0.35)'
                      : 'rgba(179,38,30,0.25)'),
                background:
                  change.op === 'add'
                    ? pal.dark
                      ? 'rgba(127,216,155,0.07)'
                      : 'rgba(27,127,59,0.05)'
                    : pal.dark
                      ? 'rgba(255,180,162,0.07)'
                      : 'rgba(179,38,30,0.04)',
              },
            },
            DeltaChip(change.op, pal),
            createElement(
              'span',
              {
                style: {
                  fontSize: 12,
                  lineHeight: '18px',
                  color: pal.textStrong,
                  wordBreak: 'break-word',
                },
              },
              change.text,
            ),
          )
        })
      : null,
    !loading && !error && !empty && changes.length === 0
      ? createElement(
          'div',
          { style: { fontSize: 12, color: pal.text, lineHeight: '18px' } },
          'Every block matches the master — nothing has been tailored yet.',
        )
      : null,
  )
}
