// ------------------------- review: decide before it changes -------------------------
// A wording change is the user's call — it is their CV and their claims about
// themselves. So the agent proposes content edits instead of saving them, and
// this panel is where they are accepted, swapped for an alternative, rewritten
// by hand, or dropped. One comment often implicates several parts, so a
// proposal is reviewed as a set and answered in one message.

/** The decision message: what the agent should now write, per change. */
function buildDecisionMessage(proposal, decisions) {
  var lines = []
  var changes = proposal && Array.isArray(proposal.changes) ? proposal.changes : []
  var kept = 0
  for (var i = 0; i < changes.length; i++) {
    if ((decisions[changes[i].id] || {}).skipped !== true) kept += 1
  }
  lines.push(
    'Here are my decisions on your proposed changes (' +
      String(kept) +
      ' of ' +
      String(changes.length) +
      ' to apply):',
  )
  lines.push('')
  for (var c = 0; c < changes.length; c++) {
    var change = changes[c]
    var decision = decisions[change.id] || {}
    var where = change.section ? 'section "' + change.section + '"' : 'no section heading'
    lines.push(String(c + 1) + '. In ' + where + (change.path ? ' — ' + change.path : ''))
    if (change.current) lines.push('   Currently: "' + clip(change.current, 200) + '"')
    if (decision.skipped === true) {
      lines.push('   SKIP — leave this exactly as it is.')
    } else if (squish(decision.refined || '') !== '') {
      lines.push('   USE MY WORDING, verbatim: "' + squish(decision.refined) + '"')
    } else {
      var chosen = pickedOption(change, decision)
      lines.push(
        '   USE your option "' + chosen.label + '", verbatim: "' + squish(chosen.text) + '"',
      )
    }
    lines.push('')
  }
  lines.push(
    'Apply exactly these — do not re-word what I chose or fold in edits I skipped. Save the full document with POST /jobcv/doc, then tell me in a sentence what changed and flag anything that now reads inconsistently elsewhere in the CV.',
  )
  return lines.join('\n')
}

/** The option a decision points at, defaulting to the first. */
function pickedOption(change, decision) {
  var options = Array.isArray(change.options) ? change.options : []
  for (var i = 0; i < options.length; i++) {
    if (options[i].id === (decision || {}).optionId) return options[i]
  }
  return options[0] || { id: '', label: 'option', text: '' }
}

/** Tell the host the pending set has been answered. */
function clearProposal(sessionId) {
  return fetch('/jobcv/proposal/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId }),
  }).then(function (res) {
    if (!res.ok) throw new Error('could not clear the proposal: ' + res.status)
    return res.json()
  })
}

function ReviewPanel(props) {
  var pal = props.pal
  var proposal = props.proposal
  var changes = Array.isArray(proposal.changes) ? proposal.changes : []
  var decisionsState = React.useState({})
  var decisions = decisionsState[0]
  var setDecisions = decisionsState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var noteState = React.useState(null)
  var note = noteState[0]
  var setNote = noteState[1]

  function decide(changeId, patch) {
    var next = {}
    for (var key in decisions) next[key] = decisions[key]
    next[changeId] = Object.assign({}, next[changeId] || {}, patch)
    setDecisions(next)
  }

  var applying = 0
  for (var i = 0; i < changes.length; i++) {
    if ((decisions[changes[i].id] || {}).skipped !== true) applying += 1
  }

  function apply() {
    if (applying === 0) {
      setNote('nothing selected — skip them all, or pick at least one')
      return
    }
    setBusy(true)
    var message = buildDecisionMessage(proposal, decisions)
    var via = deliverToComposer(props.inputActions, message, props.draft)
    if (via === null) {
      setBusy(false)
      setNote(deliveryNotice(via))
      return
    }
    // Retire the pending set only once the decision is on its way, so a failed
    // send never leaves the user with nothing to decide and nothing sent.
    clearProposal(props.sessionId)
      .then(function () {
        setBusy(false)
        setNote(deliveryNotice(via))
        if (via === 'sent' && props.onWorkStarted) props.onWorkStarted()
      })
      .catch(function (error) {
        setBusy(false)
        setNote(String(error && error.message ? error.message : error))
      })
  }

  function dismissAll() {
    setBusy(true)
    clearProposal(props.sessionId)
      .then(function () {
        setBusy(false)
      })
      .catch(function () {
        setBusy(false)
      })
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

  return createElement(
    'div',
    {
      style: {
        flex: 'none',
        maxHeight: '58%',
        overflow: 'auto',
        padding: '10px 12px 12px',
        borderBottom: '1px solid ' + pal.panelBorder,
        background: pal.panelBg,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
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
            color: pal.accent,
          },
        },
        changes.length === 1 ? '1 proposed change' : changes.length + ' proposed changes',
      ),
      createElement(
        'span',
        { style: { fontSize: 11, color: pal.text } },
        'nothing is saved until you apply',
      ),
    ),
    proposal.summary
      ? createElement(
          'div',
          { style: { fontSize: 12, color: pal.textStrong, lineHeight: '17px' } },
          proposal.summary,
        )
      : null,
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      changes.map(function (change, index) {
        var decision = decisions[change.id] || {}
        var skipped = decision.skipped === true
        var chosen = pickedOption(change, decision)
        return createElement(
          'div',
          {
            key: change.id,
            style: {
              border: '1px solid ' + pal.panelBorder,
              borderRadius: 8,
              padding: '8px 10px',
              opacity: skipped ? 0.55 : 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            },
          },
          createElement(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } },
            createElement(
              'span',
              { style: { fontSize: 11, color: pal.accent } },
              String(index + 1) + '.',
            ),
            createElement(
              'span',
              { style: { fontSize: 11, fontWeight: 600, color: pal.textStrong } },
              change.section || 'CV',
            ),
            createElement('span', { style: { flex: 1 } }),
            createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  decide(change.id, { skipped: !skipped })
                },
                style: Object.assign({}, btn, { fontSize: 11, padding: '2px 8px' }),
              },
              skipped ? 'include' : 'skip',
            ),
          ),
          change.why
            ? createElement(
                'div',
                { style: { fontSize: 11, color: pal.text, fontStyle: 'italic' } },
                change.why,
              )
            : null,
          change.current
            ? createElement(
                'div',
                {
                  style: {
                    fontSize: 12,
                    color: pal.text,
                    textDecoration: skipped ? 'none' : 'line-through',
                    opacity: 0.8,
                  },
                },
                clip(change.current, 220),
              )
            : null,
          skipped
            ? null
            : createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                change.options.map(function (option) {
                  var active = option.id === chosen.id
                  return createElement(
                    'button',
                    {
                      key: option.id,
                      type: 'button',
                      onClick: function () {
                        decide(change.id, { optionId: option.id, refined: '' })
                      },
                      style: {
                        textAlign: 'left',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 12,
                        lineHeight: '17px',
                        padding: '6px 9px',
                        borderRadius: 6,
                        color: pal.textStrong,
                        border: '1px solid ' + (active ? pal.accent : pal.controlBorder),
                        background: active
                          ? pal.dark
                            ? 'rgba(122,184,255,0.14)'
                            : 'rgba(46,111,219,0.09)'
                          : 'transparent',
                      },
                    },
                    createElement(
                      'div',
                      {
                        style: {
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          color: active ? pal.accent : pal.text,
                          marginBottom: 2,
                        },
                      },
                      option.label,
                    ),
                    option.text,
                  )
                }),
              ),
          skipped
            ? null
            : createElement('textarea', {
                value: decision.refined || '',
                placeholder: 'or write it yourself — this wins over the options above',
                onChange: function (e) {
                  decide(change.id, { refined: e.target.value })
                },
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  minHeight: 34,
                  fontFamily: 'inherit',
                  fontSize: 12,
                  padding: '5px 8px',
                  borderRadius: 6,
                  border: '1px solid ' + pal.controlBorder,
                  background: pal.dark ? 'rgba(0,0,0,0.25)' : '#fff',
                  color: pal.textStrong,
                },
              }),
        )
      }),
    ),
    note !== null
      ? createElement('div', { style: { fontSize: 11, color: pal.accent } }, note)
      : null,
    createElement(
      'div',
      { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      createElement(
        'button',
        {
          type: 'button',
          onClick: apply,
          disabled: busy,
          style: Object.assign({}, btn, {
            background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
            borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
          }),
        },
        busy ? 'sending…' : applying === changes.length ? 'Apply all' : 'Apply ' + applying,
      ),
      createElement(
        'button',
        { type: 'button', onClick: dismissAll, disabled: busy, style: btn },
        'Dismiss',
      ),
    ),
  )
}
