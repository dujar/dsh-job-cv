// ------------------------- edit: change the words yourself -------------------------
// Everything else in this mode goes through the agent: a comment becomes a
// chat message, a proposal becomes a decision, and the agent saves. That is
// right for judgement ("does this bullet land?") and wrong for a typo, a
// name, a date, or a sentence you already know how to phrase. Asking a model
// to fix "Singapore" costs a turn and a whole-document rewrite.
//
// So the document is editable in place. The preview iframe is same-origin
// (srcdoc + allow-same-origin) — the same fact that lets comment mode paint
// highlights into it — so the PARENT can flip the body to contentEditable
// and read the result back out. The frame still never gets allow-scripts.
//
// A hand edit is a save like any other: it goes through the same route the
// agent uses, so it bumps the same version line and lands in the same
// timeline, labelled with whatever note the editor wrote.

var EDIT_STYLE_ID = 'dsh-job-cv-edit'

// Injected into the document only while editing, and wrapped in @media
// screen so no edit affordance can reach the printed PDF. The hover tint is
// the whole affordance: it says "this block is yours to change" without
// putting a control on the page.
var EDIT_CSS = [
  '@media screen{',
  'body[contenteditable="true"]{cursor:text;caret-color:#2e6fdb;-webkit-user-modify:read-write}',
  'body[contenteditable="true"]:focus,body[contenteditable="true"] *:focus{outline:none}',
  'body[contenteditable="true"] ::selection{background:rgba(46,111,219,.24)}',
  'body[contenteditable="true"] :is(p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dd,dt)',
  ':hover{background:rgba(46,111,219,.07)}',
  // A page with nothing on it is hidden everywhere else — it would print as
  // a blank sheet — but edit mode is precisely where someone would want to
  // fill one in. So it comes back while editing, dashed to say it is there
  // but will not print until it has something on it.
  'body[contenteditable="true"] .page[data-dsh-job-cv-blank]{display:block!important;',
  'outline:1px dashed rgba(46,111,219,.45);outline-offset:-4px}',
  '}',
].join('')

// <style> elements the PARENT injects into a preview document: the page
// deck, the comment highlights, the working treatment, the post's red gap
// marks, and the edit affordance above. They are decoration and defense —
// none of them is the user's document, so none of them rides into a save.
var INJECTED_STYLE_IDS = {
  'dsh-job-cv-pages': 1,
  'dsh-job-cv-annotate': 1,
  'dsh-job-cv-working': 1,
  'dsh-job-cv-post-gap': 1,
  'dsh-job-cv-edit': 1,
}

// Attributes the parent writes onto the document's own elements: the
// contentEditable flag itself, the comment-mode marks, and the once-only
// guards that say a listener is already attached. Left in, they would come
// back as a document that is permanently editable and permanently "already
// bound" the next time it is opened.
var EDIT_STRIP_ATTRS = [
  'contenteditable',
  'spellcheck',
  'data-jobcv-hot',
  'data-jobcv-picked',
  'data-jobcv-noted',
  'data-dsh-job-cv-swipe',
  'data-dsh-job-cv-links',
  'data-dsh-job-cv-blank',
]

/** Is this element one the parent put there, rather than the author? */
function isInjectedNode(node) {
  var tag = String((node && node.tagName) || '').toUpperCase()
  if (tag === 'STYLE') return INJECTED_STYLE_IDS[String(node.id || '')] === 1
  // The deck declares a viewport only when the document did not, and marks
  // the one it added so exactly that one comes back out.
  if (tag === 'META' && node.hasAttribute) return node.hasAttribute('data-dsh-job-cv-viewport')
  return false
}

/**
 * Take the parent's fingerprints off a document tree, in place.
 *
 * `nodes` is every element in the tree including the root — passed in rather
 * than queried here so the rule stays a plain decision per element, testable
 * without a selector engine.
 */
function stripInjected(nodes) {
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (isInjectedNode(node)) {
      if (node.parentNode) node.parentNode.removeChild(node)
      continue
    }
    for (var a = 0; a < EDIT_STRIP_ATTRS.length; a++) {
      if (node.removeAttribute) node.removeAttribute(EDIT_STRIP_ATTRS[a])
    }
  }
  return nodes
}

/** Every element in the tree, the root included. */
function allElements(root) {
  var found = root.querySelectorAll ? root.querySelectorAll('*') : []
  var nodes = [root]
  for (var i = 0; i < found.length; i++) nodes.push(found[i])
  return nodes
}

/**
 * The edited document, as the HTML that will be saved.
 *
 * Serialized off a CLONE: stripping runs on a copy so the live frame keeps
 * its deck, its highlights and its editability while the request is in
 * flight, and a failed save leaves the user still editing what they wrote.
 *
 * Two of the deck's defenses are baked in by the time this reads the tree,
 * and saving makes them permanent: <script> elements were removed (the
 * sandbox blocks them anyway, and the contract forbids them), and an
 * embedded external page was already replaced by a link to it. Both are
 * what the document should have said in the first place.
 */
function serializeEditedDoc(idoc) {
  if (!idoc || !idoc.documentElement) return ''
  var root = idoc.documentElement.cloneNode(true)
  stripInjected(allElements(root))
  var name = idoc.doctype && idoc.doctype.name ? idoc.doctype.name : ''
  return (name === '' ? '' : '<!DOCTYPE ' + name + '>\n') + root.outerHTML
}

/** Turn the frame's body editable (or back), and paint the affordance. */
function setDocEditable(frame, on) {
  try {
    var idoc = frame && frame.contentDocument
    var body = idoc && idoc.body
    if (!idoc || !body) return false
    var style = idoc.getElementById(EDIT_STYLE_ID)
    if (on) {
      body.setAttribute('contenteditable', 'true')
      body.setAttribute('spellcheck', 'true')
      if (!style) {
        style = idoc.createElement('style')
        style.id = EDIT_STYLE_ID
        style.textContent = EDIT_CSS
        ;(idoc.head || body).appendChild(style)
      }
    } else {
      body.removeAttribute('contenteditable')
      body.removeAttribute('spellcheck')
      if (style && style.parentNode) style.parentNode.removeChild(style)
    }
    return true
  } catch (e) {
    // Cross-origin, or the frame is gone: the caller reports it rather than
    // leaving a toolbar that claims to be editing nothing.
    return false
  }
}

/** POST a JSON body and resolve to the parsed answer, throwing on an error. */
function postJson(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (res) {
    return res.json().then(function (parsed) {
      if (!res.ok) {
        throw new Error(
          (parsed && parsed.error ? parsed.error : 'save failed') + ' (' + res.status + ')',
        )
      }
      return parsed || {}
    })
  })
}

/** The note a hand edit lands in the timeline under. */
var EDIT_DEFAULT_NOTE = 'Edited by hand'

function editNote(note) {
  var trimmed = String(note === undefined || note === null ? '' : note).trim()
  return trimmed === '' ? EDIT_DEFAULT_NOTE : trimmed
}

/**
 * Save a hand-edited document through the same route the agent writes to,
 * so the edit gets the same version line and the same history entry.
 *
 * The post is the exception: it has no version line at all. Its page rides
 * with the text it renders, so the stored text goes back up unchanged — an
 * edit of the page is not a claim about what the posting said.
 */
function saveEditedDoc(sessionId, kind, html, note, post) {
  if (kind === 'post') {
    return postJson('/jobcv/post', {
      sessionId: sessionId,
      text: post && typeof post.text === 'string' ? post.text : '',
      source: post && post.source === 'you' ? 'you' : 'agent',
      html: html,
    }).then(function () {
      return null
    })
  }
  return postJson(kind === 'letter' ? '/jobcv/letter' : '/jobcv/doc', {
    sessionId: sessionId,
    html: html,
    note: editNote(note),
  }).then(function (body) {
    return typeof body.version === 'number' ? body.version : null
  })
}

/**
 * The strip that takes over while a document is being edited by hand.
 *
 * It says what is being edited, what version the save will land as, carries
 * the note the timeline will show, and holds the only two ways out. It also
 * says when the agent saved underneath the edit — the edit is still valid
 * and still saves, but it saves ON TOP of a version the editor never saw,
 * and that is worth knowing before pressing Save.
 */
function EditBar(props) {
  var pal = props.pal
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
  var primary = Object.assign({}, btn, {
    background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
    borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
    fontWeight: 600,
  })
  return createElement(
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
      'Editing the ' +
        props.what +
        ' — click into the page and type. ' +
        (props.nextVersion === null
          ? 'Saving replaces the stored page.'
          : 'Saving lands as v' + props.nextVersion + '.'),
    ),
    // The post has no version line, so it has no timeline to label.
    props.nextVersion === null
      ? null
      : createElement('input', {
          type: 'text',
          value: props.note,
          placeholder: EDIT_DEFAULT_NOTE.toLowerCase() + ' — what changed?',
          maxLength: 120,
          disabled: props.busy,
          onChange: function (e) {
            props.onNote(e.target.value)
          },
          style: {
            flex: '1 1 200px',
            minWidth: 140,
            fontFamily: 'inherit',
            fontSize: 11,
            lineHeight: '16px',
            padding: '3px 8px',
            borderRadius: 6,
            border: '1px solid ' + pal.controlBorder,
            background: pal.dark ? 'rgba(0,0,0,0.25)' : '#fff',
            color: pal.textStrong,
          },
        }),
    createElement(
      'button',
      {
        type: 'button',
        onClick: props.onSave,
        disabled: props.busy || !props.dirty,
        title: props.dirty ? 'Save your changes as a new version' : 'Nothing has been changed yet',
        style:
          props.busy || !props.dirty
            ? Object.assign({}, primary, { opacity: 0.5, cursor: 'default' })
            : primary,
      },
      props.busy ? 'Saving…' : 'Save changes',
    ),
    createElement(
      'button',
      {
        type: 'button',
        onClick: props.onDiscard,
        disabled: props.busy,
        title: 'Throw the edits away and go back to the saved document',
        style: btn,
      },
      'Discard',
    ),
    props.movedUnderneath
      ? createElement(
          'span',
          { style: { fontSize: 11, color: pal.accent } },
          'The agent saved while you were editing — your version does not include that save.',
        )
      : null,
    props.error
      ? createElement(
          'span',
          { style: { fontSize: 11, color: pal.dark ? '#ffb4a2' : '#b3261e' } },
          props.error,
        )
      : null,
  )
}
