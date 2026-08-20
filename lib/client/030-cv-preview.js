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
// Inline styles cannot express keyframes, so the two animations the working
// state needs are injected once into the host page.
var ANIM_STYLE_ID = 'dsh-job-cv-anim'
function ensureAnimations() {
  try {
    if (typeof document === 'undefined' || document.getElementById(ANIM_STYLE_ID)) return
    var style = document.createElement('style')
    style.id = ANIM_STYLE_ID
    style.textContent =
      '@keyframes dsh-job-cv-shimmer{0%{background-position:-480px 0}100%{background-position:480px 0}}' +
      '@keyframes dsh-job-cv-pulse{0%,100%{opacity:.55}50%{opacity:.95}}' +
      // Each dot swells and settles in turn, so the row reads left to right
      // as one motion rather than three things blinking.
      '@keyframes dsh-job-cv-dot{0%,70%,100%{transform:scale(.55);opacity:.35}' +
      '30%{transform:scale(1);opacity:1}}' +
      // The letter's arrival: the finished sheet rises into place, so the
      // skeleton-for-document swap reads as a landing rather than a pop.
      '@keyframes dsh-job-cv-sheet-in{from{opacity:0;transform:translateY(30px)}' +
      'to{opacity:1;transform:translateY(0)}}'
    ;(document.head || document.body).appendChild(style)
  } catch (e) {
    /* the working state degrades to a static placeholder */
  }
}

/** One shimmering placeholder bar on the skeleton page. */
function bar(width, height, top) {
  return createElement('div', {
    key: String(top) + '-' + String(width),
    style: {
      height: height,
      width: width,
      marginBottom: 9,
      borderRadius: 3,
      background:
        'linear-gradient(90deg, rgba(0,0,0,0.06) 25%, rgba(0,0,0,0.12) 37%, rgba(0,0,0,0.06) 63%)',
      backgroundSize: '480px 100%',
      animation: 'dsh-job-cv-shimmer 1.4s ease-in-out infinite',
    },
  })
}

/** The skeleton sheet's box: an A4 page with nothing on it yet. */
function skeletonSheetStyle(pal) {
  return {
    width: '210mm',
    maxWidth: '100%',
    minHeight: '297mm',
    flex: 'none',
    background: '#fff',
    border: '1px solid ' + pal.panelBorder,
    borderRadius: 3,
    boxShadow: pal.dark ? '0 2px 14px rgba(0,0,0,0.45)' : '0 2px 14px rgba(0,0,0,0.13)',
    padding: '18mm 17mm',
    boxSizing: 'border-box',
  }
}

/**
 * The A4 sheet shown while the FIRST CV is being written. There is nothing to
 * blur yet, and the starter template would be a lie — it is not the user's
 * document and never was.
 */
function CvSkeleton(props) {
  var pal = props.pal
  return createElement(
    'div',
    {
      style: skeletonSheetStyle(pal),
    },
    bar('52%', 26, 0),
    bar('72%', 11, 1),
    createElement('div', { key: 'gap1', style: { height: 18 } }),
    bar('34%', 12, 2),
    bar('100%', 10, 3),
    bar('96%', 10, 4),
    bar('88%', 10, 5),
    createElement('div', { key: 'gap2', style: { height: 16 } }),
    bar('28%', 12, 6),
    bar('64%', 10, 7),
    bar('92%', 10, 8),
    bar('80%', 10, 9),
    createElement('div', { key: 'gap3', style: { height: 16 } }),
    bar('30%', 12, 10),
    bar('86%', 10, 11),
    bar('70%', 10, 12),
  )
}

/**
 * The A4 sheet shown while the cover letter is being written: the same
 * shimmer as the first-CV skeleton, laid out like a letter (a header, a
 * salutation, two paragraphs, a sign-off) so it reads as the thing that is
 * coming rather than a generic wait.
 */
function LetterSkeleton(props) {
  var pal = props.pal
  return createElement(
    'div',
    { style: skeletonSheetStyle(pal) },
    bar('46%', 26, 0),
    bar('30%', 10, 1),
    createElement('div', { key: 'gap1', style: { height: 24 } }),
    bar('22%', 12, 2),
    createElement('div', { key: 'gap2', style: { height: 12 } }),
    bar('100%', 10, 3),
    bar('94%', 10, 4),
    bar('98%', 10, 5),
    bar('70%', 10, 6),
    createElement('div', { key: 'gap3', style: { height: 12 } }),
    bar('100%', 10, 7),
    bar('90%', 10, 8),
    bar('96%', 10, 9),
    bar('58%', 10, 10),
    createElement('div', { key: 'gap4', style: { height: 26 } }),
    bar('30%', 12, 11),
    bar('40%', 10, 12),
  )
}

/**
 * Three dots swelling in sequence: the plugin's one "something is happening"
 * mark. Used over the document AND in the dock, because the work continues
 * whether or not the preview is folded away — and a folded preview with no
 * sign of life reads as nothing happening at all.
 */
function WorkingDots(props) {
  ensureAnimations()
  var size = props.size || 6
  var color = props.color
  return createElement(
    'span',
    {
      'aria-label': 'working',
      style: { display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.6) },
    },
    [0, 1, 2].map(function (i) {
      return createElement('span', {
        key: i,
        style: {
          width: size,
          height: size,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
          animation: 'dsh-job-cv-dot 1.1s ease-in-out infinite',
          animationDelay: i * 0.16 + 's',
        },
      })
    }),
  )
}

// The printed sheet at 96dpi: 210mm plus its two 1px borders. The scale
// factor divides the PANE into this — below a full sheet, the document
// shrinks as a whole instead of reflowing, so the preview stays exactly the
// layout the PDF prints, just smaller.
var SHEET_W = (210 * 96) / 25.4 + 2

/**
 * Fit the sheet to its container: 1 while the pane is wide enough, and a
 * scale factor below 1 when it is not. Scaling, not reflow — the document
 * still lays out at 210mm internally, so preview and print keep agreeing.
 */
function useSheetScale(containerRef) {
  var state = React.useState(1)
  var scale = state[0]
  var setScale = state[1]
  React.useEffect(
    function () {
      var ro = null
      var host = null
      var recheck = null
      // The width the sheet must fit into. On a phone the LAYOUT viewport
      // (what a fixed overlay spans) can be wider than what is actually
      // visible — no/odd viewport meta, or a pinch-zoom in — so the sheet
      // has to fit the VISIBLE screen width, or it renders at full A4 width
      // and spills off the right edge. visualViewport is the honest number.
      function visibleWidth(el) {
        var w = el.clientWidth
        var vv =
          typeof window !== 'undefined' && window.visualViewport && window.visualViewport.width
        if (vv) {
          // Prefer the visible screen when the box is not yet measurable, or
          // wider than it (layout viewport > visual viewport on a phone).
          w = w > 0 ? Math.min(w, vv) : vv
        }
        return w
      }
      function measure() {
        // The ref is read FRESH every time: the pane mounts through a portal
        // a beat after this effect, and an element captured early would be
        // the wrong one forever.
        var el = containerRef.current
        if (!el) return
        // clientWidth excludes the scrollbar; the container padding is the
        // breathing room around the sheet.
        var avail = visibleWidth(el) - 22
        setScale(avail > 0 ? Math.min(1, avail / SHEET_W) : 1)
      }
      function bind() {
        var el = containerRef.current
        if (!el) return false
        measure()
        window.addEventListener('resize', measure)
        // Mobile rotation, pinch-zoom and the browser chrome showing/hiding
        // resize the VISUAL viewport without resizing the window — follow it
        // so the sheet re-scales instead of going stale.
        if (typeof window !== 'undefined' && window.visualViewport) {
          window.visualViewport.addEventListener('resize', measure)
        }
        if (typeof ResizeObserver === 'undefined') return true
        ro = new ResizeObserver(measure)
        ro.observe(el)
        // The pane host is the element the divider actually resizes; it is a
        // stable DOM node that survives React re-renders, so observing it as
        // well makes the scale follow the drag deterministically.
        host = el.closest && el.closest('[data-dsh-job-cv-pane]')
        if (host) ro.observe(host)
        return true
      }
      // The container may not exist yet at effect time — retry briefly.
      var bound = bind()
      if (!bound) {
        var retry = setInterval(function () {
          if (bind()) clearInterval(retry)
        }, 200)
        var stopRetry = function () {
          clearInterval(retry)
        }
      }
      // If the split rebuilds the pane host, the observed node is replaced;
      // a cheap periodic re-bind follows it.
      recheck = setInterval(function () {
        var el = containerRef.current
        if (!el || ro === null) return
        var currentHost = el.closest && el.closest('[data-dsh-job-cv-pane]')
        if (currentHost && currentHost !== host) {
          host = currentHost
          ro.observe(host)
        }
      }, 1000)
      return function () {
        if (stopRetry) stopRetry()
        clearInterval(recheck)
        window.removeEventListener('resize', measure)
        if (typeof window !== 'undefined' && window.visualViewport) {
          window.visualViewport.removeEventListener('resize', measure)
        }
        if (ro !== null) ro.disconnect()
      }
    },
    [containerRef],
  )
  return scale
}

/** The "the agent is on it" badge floating over the document surface. */
function WorkingBadge(props) {
  var pal = props.pal
  return createElement(
    'div',
    {
      style: {
        position: 'absolute',
        top: 18,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 3,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 13px',
        borderRadius: 999,
        fontSize: 12,
        color: pal.textStrong,
        background: pal.dark ? 'rgba(28,30,34,0.92)' : 'rgba(255,255,255,0.94)',
        border: '1px solid ' + pal.panelBorder,
        boxShadow: '0 3px 14px rgba(0,0,0,0.18)',
        pointerEvents: 'none',
      },
    },
    createElement(WorkingDots, { color: pal.accent, size: 6 }),
    props.label,
  )
}

// ---- what the exported PDF is called -------------------------------------
// "Save as PDF" takes its default filename from the printed document's title,
// so the title is set to the name we want just before print(). One
// convention for both documents — Firstname_Lastname_CV_Job_Company.pdf and
// Firstname_Lastname_Cover_Letter_Job_Company.pdf — so a candidacy's two
// files sort together in the downloads folder, and a recruiter reading only
// the attachment name still knows who applied and for what.

// How long the shell's tab may wear the export name when 'afterprint' never
// arrives. Long enough to outlast someone reading the print preview, short
// enough that a tab left renamed heals on its own.
var PRINT_TITLE_MAX_MS = 120000

/** A title of "CV" is the template's, not the candidate's. */
var GENERIC_TITLE = /^(cv|resum[eé]|curriculum vitae|cover letter|letter|document|untitled)$/i

/**
 * The candidate's name as the document itself states it: its first <h1>,
 * which both the CV and the letter carry as the header (one personal brand).
 * Falls back to <title>, unless that is the generic template title.
 */
function candidateNameFrom(html) {
  var s = String(html === undefined || html === null ? '' : html)
  var m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(s)
  var raw = m ? m[1] : ''
  if (squish(stripTags(raw)) === '') {
    var t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)
    raw = t ? t[1] : ''
  }
  var name = squish(stripTags(raw))
  return GENERIC_TITLE.test(name) ? '' : name
}

/** Markup out, entities that matter decoded, so an &amp; is not "amp". */
function stripTags(html) {
  return String(html === undefined || html === null ? '' : html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&(?:lt|gt|quot|#39|apos|middot|ndash|mdash);/gi, ' ')
}

/**
 * One filename segment: accents folded to ASCII (a downloads folder is a
 * worse place for encoding surprises than a CV is), everything that is not a
 * letter or a digit collapsed to a single underscore.
 */
function fileSlug(part, max) {
  var s = String(part === undefined || part === null ? '' : part)
  try {
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  } catch (e) {
    /* an engine without NFD normalization just keeps the original letters */
  }
  return s
    .replace(/['\u2018\u2019]/g, '') // O'Brien reads better than O_Brien
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max || 48)
    .replace(/_+$/, '')
}

/**
 * Firstname_Lastname_CV_Job_Company — with whatever is not known yet simply
 * left out, so an unnamed candidacy exports as "Jane_Doe_CV" rather than
 * carrying empty gaps.
 */
function exportFileName(parts) {
  var p = parts || {}
  var kind = p.kind === 'letter' ? 'Cover_Letter' : 'CV'
  var segs = [fileSlug(p.name), kind, fileSlug(p.jobTitle), fileSlug(p.company)]
  var out = []
  for (var i = 0; i < segs.length; i++) {
    if (segs[i] !== '') out.push(segs[i])
  }
  // Long job titles plus a long company can outrun a filesystem's name limit;
  // the tail is what gets cut, so the name and the kind always survive.
  return out.join('_').slice(0, 150).replace(/_+$/, '')
}

/**
 * Wear the export filename as the HOST page's title for the duration of the
 * print dialog, and hand back the undo.
 *
 * The frame's own title is not what names the download: Chrome takes the
 * suggested filename from the TOP-LEVEL document even when a subframe is what
 * prints — which is why an unpatched export lands as "<session> — DeepSeek
 * Harness.pdf". The title is put back when the dialog closes (afterprint
 * fires on cancel too), with a timer behind it so a browser that never sends
 * the event cannot leave the shell's tab renamed.
 */
function wearPrintTitle(fileName) {
  var noop = function () {}
  if (fileName === '' || typeof document === 'undefined') return noop
  var previous = document.title
  try {
    document.title = fileName
  } catch (e) {
    return noop
  }
  var timer = null
  var done = false
  function restore() {
    if (done) return
    done = true
    if (timer !== null) clearTimeout(timer)
    try {
      document.title = previous
    } catch (e) {
      /* nothing left to do: the tab keeps the export name until navigation */
    }
    try {
      window.removeEventListener('afterprint', restore)
    } catch (e) {
      /* the listener was never attached */
    }
  }
  timer = setTimeout(restore, PRINT_TITLE_MAX_MS)
  try {
    window.addEventListener('afterprint', restore)
  } catch (e) {
    /* the timer above is the whole safety net then */
  }
  return restore
}

function CvPane(props) {
  useThemeTick()
  var pal = palette()
  var doc = props.doc
  var iframeRef = React.useRef(null)
  // A historical version being LOOKED AT. Declared before anything derives
  // from it: `var` hoists, so reading it above this line yields undefined —
  // and `undefined !== null` is true, which previously made the pane believe
  // it was showing a version it did not have and crash on its html.
  var lookingState = React.useState(null)
  var looking = lookingState[0]
  var setLooking = lookingState[1]

  var working = props.working === null || props.working === undefined ? null : props.working
  // Which surface is on screen: the CV, the cover letter (a second document
  // with its own version line and its own file), or the job post itself.
  var viewState = React.useState('cv')
  var rawView = viewState[0]
  var setView = viewState[1]
  // A letter that was asked for but has not landed yet. It has no document
  // and no version, but it DOES have a surface: a skeleton sheet under the
  // working badge, and a tab in the switcher — so the request is visible in
  // the preview itself, not only as a disabled button.
  var letterPending = working !== null && working.target === 'letter' && !doc.letter
  // A view whose subject no longer exists falls back to the CV rather than
  // rendering a tab into nothing — except while the letter asked for is
  // still on its way, which keeps its own loading surface.
  var view = rawView === 'letter' && !doc.letter && !letterPending ? 'cv' : rawView
  var showingLetter = view === 'letter' && doc.letter
  var showingLetterPending = view === 'letter' && letterPending
  var showingPost = view === 'post'
  // A one-time hint that the surface can be swiped between views on touch
  // devices; dismissed on the first switch (swipe or tab click) and then
  // remembered per session, so it does not reappear on every reload.
  var swipeHintState = React.useState(!loadPrefs(props.sessionId).swipeHintSeen)
  var swipeHint = swipeHintState[0]
  var setSwipeHint = swipeHintState[1]

  // The post body is fetched on demand: the /jobcv/doc projection carries
  // only a marker for it (postChars/postUpdatedAt).
  var postState = React.useState(null)
  var post = postState[0]
  var setPost = postState[1]
  var postLoadingState = React.useState(false)
  var postLoading = postLoadingState[0]
  var setPostLoading = postLoadingState[1]
  // Bumped after a paste, so the fetch below re-runs against what was saved.
  var postTickState = React.useState(0)
  var postTick = postTickState[0]
  var bumpPostTick = postTickState[1]
  // The structured brief of the posting, fetched beside the raw text.
  var briefState = React.useState(null)
  var brief = briefState[0]
  var setBrief = briefState[1]
  var briefLoadingState = React.useState(false)
  var briefLoading = briefLoadingState[0]
  var setBriefLoading = briefLoadingState[1]

  // The tabs that exist right now. The post earns one as soon as there is
  // text to show or a posting to paste in from, and the letter earns one
  // from the moment it is asked for — its tab shows the working dots while
  // the letter is still on its way.
  var views = ['cv']
  if (doc.letter || letterPending) views.push('letter')
  if (doc.postChars > 0 || doc.jobUrl) views.push('post')

  // ---- fit: the score and the gaps ----
  var fitOpenState = React.useState(false)
  var fitOpen = fitOpenState[0]
  var setFitOpen = fitOpenState[1]
  // Truthiness, not a null test: only an actual {version, html} shows one.
  // An old version is only "on screen" while the tab it belongs to is: the CV
  // and the letter each count from v1, so a letter draft shown under the CV
  // tab would be a different document wearing the same number.
  var showingOld =
    !!(looking && looking.html) &&
    !showingPost &&
    looking.kind === (showingLetter ? 'letter' : 'cv')
  var starter = doc.version === 0 && !showingLetter && !showingOld
  var html = showingOld
    ? looking.html
    : showingLetter
      ? doc.letter.html
      : starter
        ? starterDoc()
        : doc.html
  // What a comment is ABOUT. The letter is a second document with its own
  // version line and its own route, and an old version being looked at is not
  // the live one — a mark that cites neither reads as a mark on the current CV.
  var commentTarget = showingLetter ? 'letter' : 'cv'
  var commentWhat = showingLetter ? 'cover letter' : 'CV'
  // The live version of the document on screen — what History lists against,
  // what a restore lands on top of, and what a mark cites when it is current.
  var liveVersion = showingLetter ? doc.letter.version : doc.version
  var commentVersion = showingOld ? looking.version : liveVersion
  // The loading shows only on the surface that was asked for: a letter
  // request does not dim the CV, a post request does not dim anything that
  // prints, and a comment batch dims exactly the parts that were marked.
  // The pending letter surface counts as the letter for this: it is the
  // surface the letter request was asked on.
  var workingHere =
    working !== null &&
    (showingPost
      ? working.target === 'post'
      : showingLetter || showingLetterPending
        ? working.target === 'letter'
        : working.target === 'cv')
  var workingParts = workingHere && Array.isArray(working.anchors) && working.anchors.length > 0
  var workingWholeDoc =
    workingHere && !workingParts && (working.target === 'cv' || working.target === 'letter')
  // One-shot "the letter just landed" moment, for both arrival marks: the
  // sheet rises into place (further down) and the Letter tab pulses. Held
  // long enough for the animation to finish, then dropped so a later
  // revision does not replay it. Detected with a layout effect so the
  // animation is in place BEFORE the browser paints the landed document —
  // detecting it after paint would flash the final sheet for a frame and
  // then jump back to the start of the animation.
  var hadLetterRef = React.useRef(!!doc.letter)
  var letterArrivedState = React.useState(false)
  var letterArrived = letterArrivedState[0]
  var setLetterArrived = letterArrivedState[1]
  React.useLayoutEffect(
    function () {
      if (doc.letter && !hadLetterRef.current) {
        setLetterArrived(true)
        var timer = setTimeout(function () {
          setLetterArrived(false)
        }, 640)
        hadLetterRef.current = true
        return function () {
          clearTimeout(timer)
        }
      }
      hadLetterRef.current = !!doc.letter
      return undefined
    },
    [doc.letter],
  )
  ensureAnimations()
  // A fresh session has no document yet: the pane shows the onboarding
  // start form (job link + CV path/file) instead of a CV surface.
  var onboarding = starter && !doc.workspace

  // ---- edit mode: change the words yourself ----
  // The document is editable in place (the frame is same-origin, so the
  // parent can flip its body to contentEditable), and a hand edit saves
  // through the same route the agent uses — same version line, same
  // timeline. See 029-doc-edit.js for the machinery.
  var editingState = React.useState(false)
  var editing = editingState[0]
  var setEditing = editingState[1]
  var editNoteState = React.useState('')
  var editNoteText = editNoteState[0]
  var setEditNoteText = editNoteState[1]
  var editBusyState = React.useState(false)
  var editBusy = editBusyState[0]
  var setEditBusy = editBusyState[1]
  var editErrorState = React.useState(null)
  var editError = editErrorState[0]
  var setEditError = editErrorState[1]
  var editDirtyState = React.useState(false)
  var editDirty = editDirtyState[0]
  var setEditDirty = editDirtyState[1]
  // What the document looked like when editing started: the frame renders
  // FROM this while edit mode is on, so a save landing underneath cannot
  // swap the srcdoc out and take the half-typed edit with it.
  var editBaseRef = React.useRef(null)
  // And what was just saved, held on screen until the store's own copy of it
  // comes back down the stream. Leaving edit mode unfreezes the frame, and
  // unfreezing before the new version has landed would remount it on the
  // PRE-edit document — a flash that reads as "it did not save".
  var editSavedState = React.useState(null)
  var editSaved = editSavedState[0]
  var setEditSaved = editSavedState[1]
  // The post's page lives in PostSurface's own iframe; edit mode drives
  // whichever frame is showing, so PostSurface hands its frame up through
  // this ref rather than owning a second copy of the machinery.
  var postFrameRef = React.useRef(null)
  // PostSurface's raw-text editor, lifted so the toolbar's Edit can open it:
  // a posting with no page yet IS its text, and that textarea is what
  // editing it means.
  var postTextEditState = React.useState(false)
  var postTextEdit = postTextEditState[0]
  var setPostTextEdit = postTextEditState[1]

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
  // The elements of a dragged range, so Add marks them all as noted.
  var pickedElsRef = React.useRef(null)
  // The scaled-sheet machinery: the container width drives the factor, and
  // the measured document height drives the wrapper's height.
  var surfaceRef = React.useRef(null)
  var scale = useSheetScale(surfaceRef)
  var frameHState = React.useState(1123)
  var frameH = frameHState[0]
  var setFrameH = frameHState[1]
  // Which sheets run past A4, and by how much. On screen a page that is too
  // long simply grows, so nothing about the preview says the PDF is about to
  // come out a sheet longer with a section broken across the break — this is
  // what says it.
  var overflowState = React.useState([])
  var overflow = overflowState[0]
  var setOverflow = overflowState[1]
  // Measure the FULL document, not just the body: documentElement grows past
  // the body when the last page's bottom margin collapses, and body is the
  // one that grows when the agent put everything in body. Take whichever is
  // taller, floored at one A4 page, so a multi-page CV is never clipped to
  // the first sheet.
  function measureFrame() {
    try {
      var frame = iframeRef.current
      var idoc = frame && frame.contentDocument
      if (!idoc) return
      var height = Math.max(
        (idoc.documentElement && idoc.documentElement.scrollHeight) || 0,
        (idoc.body && idoc.body.scrollHeight) || 0,
        1123,
      )
      setFrameH(height)
    } catch (e) {
      /* keep the floor */
    }
  }

  // The deck is re-run rather than remembered: it is idempotent, and the
  // measurement it returns has to follow the document — a late-loading image,
  // a save, a line typed in edit mode all change which page overflows.
  function refreshDeck() {
    try {
      var overs = injectPageDeck(iframeRef.current, pal)
      setOverflow(Array.isArray(overs) ? overs : [])
    } catch (e) {
      /* the document still renders; the warning is what is lost */
    }
  }

  // ---- version history / rollback ----
  var historyOpenState = React.useState(false)
  var historyOpen = historyOpenState[0]
  var setHistoryOpen = historyOpenState[1]
  var versionsState = React.useState([])
  var versions = versionsState[0]
  var setVersions = versionsState[1]
  var restoreBusyState = React.useState(false)
  var restoreBusy = restoreBusyState[0]
  var setRestoreBusy = restoreBusyState[1]
  var restoreStatusState = React.useState(null)
  var restoreStatus = restoreStatusState[0]
  var setRestoreStatus = restoreStatusState[1]
  function lookAt(version) {
    if (version === liveVersion) {
      setLooking(null)
      return
    }
    setRestoreStatus(null)
    fetchVersion(props.sessionId, version, commentTarget)
      .then(function (body) {
        // Tagged with the document it came off: the two timelines both count
        // from v1, and a letter body rendered as the CV is just wrong.
        setLooking({ version: version, html: body.html, kind: commentTarget })
      })
      .catch(function (error) {
        setRestoreStatus(String(error && error.message ? error.message : error))
      })
  }

  function toggleHistory() {
    var next = !historyOpen
    setHistoryOpen(next)
    setRestoreStatus(null)
    if (next) {
      fetchHistory(props.sessionId, commentTarget)
        .then(function (body) {
          setVersions((body && body.versions) || [])
        })
        .catch(function () {
          setVersions([])
          setRestoreStatus('could not load the version history')
        })
    }
  }

  function restoreTo(version) {
    if (restoreBusy) return
    var kind = looking && looking.kind ? looking.kind : commentTarget
    setRestoreBusy(true)
    setRestoreStatus('restoring v' + version + '…')
    restoreVersion(props.sessionId, version, kind)
      .then(function (newVersion) {
        setRestoreBusy(false)
        setHistoryOpen(false)
        // The doc poll picks the restored document up within a poll interval.
        setRestoreStatus('restored v' + version + ' — now v' + newVersion)
      })
      .catch(function (err) {
        setRestoreBusy(false)
        setRestoreStatus('could not restore: ' + String(err && err.message ? err.message : err))
      })
  }

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

      // The picked part(s) stay boxed in the preview while the comment is
      // being written — without this the panel quotes text and the document
      // shows nothing, and the user cannot see what they are commenting on.
      function clearPickedPaint() {
        var old = []
        if (pickedElsRef.current) old = pickedElsRef.current.slice()
        else if (pickedElRef.current) old = [pickedElRef.current]
        for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-jobcv-picked')
      }
      function paintPicked(els) {
        for (var i = 0; i < els.length; i++) els[i].setAttribute('data-jobcv-picked', '')
      }

      // Click marks ONE part; dragging across parts grows the selection into
      // a range — everything the pointer touches joins the note, and the note
      // quotes each part separately so the agent can find all of them.
      var hot = []
      var dragItems = []
      var dragging = false
      function clearHot() {
        for (var i = 0; i < hot.length; i++) hot[i].removeAttribute('data-jobcv-hot')
        hot = []
      }
      function paintHot(el) {
        if (hot.indexOf(el) !== -1) return
        el.setAttribute('data-jobcv-hot', '')
        hot.push(el)
      }
      function onMove(e) {
        var el = pickableFrom(e.target, root)
        if (!el) return
        if (dragging) {
          paintHot(el)
          if (dragItems.indexOf(el) === -1) dragItems.push(el)
          return
        }
        clearHot()
        paintHot(el)
      }
      function onDown(e) {
        var el = pickableFrom(e.target, root)
        if (!el) return
        // Comment mode owns the pointer: no link navigates, and no native
        // text selection starts, under it.
        e.preventDefault()
        e.stopPropagation()
        dragging = true
        dragItems = [el]
        paintHot(el)
      }
      function finishDrag() {
        if (!dragging) return
        dragging = false
        // Document order, not the order the pointer happened to touch them.
        if (dragItems.length > 1 && typeof dragItems[0].compareDocumentPosition === 'function') {
          dragItems.sort(function (a, b) {
            return a.compareDocumentPosition(b) & 2 ? 1 : -1
          })
        }
        clearPickedPaint()
        if (dragItems.length === 1) {
          pickedElRef.current = dragItems[0]
          pickedElsRef.current = null
          setPicked(noteFrom(dragItems[0], root, commentVersion))
          paintPicked([dragItems[0]])
        } else {
          pickedElRef.current = null
          pickedElsRef.current = dragItems
          setPicked(rangeNoteFrom(dragItems, root, commentVersion))
          paintPicked(dragItems)
        }
        dragItems = []
        setSent(null)
      }
      function onUp() {
        finishDrag()
      }
      // A finger cannot use any of the above: a phone does not reliably make
      // mouse events out of a tap, which is why comment mode did nothing at
      // all on mobile. One tap picks one part; a drag stays a scroll.
      var detachTouch = attachTouchPicking(idoc, root, function (el) {
        clearHot()
        clearPickedPaint()
        pickedElRef.current = el
        pickedElsRef.current = null
        setPicked(noteFrom(el, root, commentVersion))
        paintPicked([el])
        setSent(null)
      })
      root.addEventListener('mousemove', onMove, true)
      root.addEventListener('mouseleave', clearHot, true)
      root.addEventListener('mousedown', onDown, true)
      // Releasing outside the body still finalizes; leaving the body ends the
      // hover paint but keeps the drag until the release.
      idoc.addEventListener('mouseup', onUp, true)
      return function () {
        clearHot()
        detachTouch()
        root.removeEventListener('mousemove', onMove, true)
        root.removeEventListener('mouseleave', clearHot, true)
        root.removeEventListener('mousedown', onDown, true)
        idoc.removeEventListener('mouseup', onUp, true)
        if (style && style.parentNode) style.parentNode.removeChild(style)
        var marked = root.querySelectorAll('[data-jobcv-noted]')
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-jobcv-noted')
        var picked = root.querySelectorAll('[data-jobcv-picked]')
        for (var j = 0; j < picked.length; j++) picked[j].removeAttribute('data-jobcv-picked')
      }
    },
    [annotating, loadTick, commentVersion],
  )

  // Everything queued, including a note still being typed.
  function collectNotes() {
    var pending =
      picked && squish(draft) !== '' ? [Object.assign({}, picked, { comment: draft })] : []
    return notes.concat(pending)
  }

  function addNote() {
    if (!picked || squish(draft) === '') return
    if (pickedElsRef.current) {
      for (var i = 0; i < pickedElsRef.current.length; i++) {
        pickedElsRef.current[i].setAttribute('data-jobcv-noted', '')
        pickedElsRef.current[i].removeAttribute('data-jobcv-picked')
      }
    } else if (pickedElRef.current) {
      pickedElRef.current.setAttribute('data-jobcv-noted', '')
      pickedElRef.current.removeAttribute('data-jobcv-picked')
    }
    setNotes(notes.concat([Object.assign({}, picked, { comment: draft })]))
    setPicked(null)
    setDraft('')
    pickedElRef.current = null
    pickedElsRef.current = null
  }

  function sendNotes() {
    var batch = collectNotes()
    if (batch.length === 0) return
    // The LIVE version of that document, not commentVersion: each note already
    // carries the version it was marked on, and the difference between the two
    // is exactly what prints "marked on v3, before your latest save".
    var message = buildRevisionMessage(batch, {
      target: commentTarget,
      version: showingLetter ? doc.letter.version : doc.version,
      jobUrl: doc.jobUrl,
    })
    var via = deliverToComposer(props.inputActions, message, props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({
        target: commentTarget,
        anchors: anchorPathsFor(batch),
      })
    if (via !== null) {
      if (pickedElsRef.current) {
        for (var i = 0; i < pickedElsRef.current.length; i++) {
          pickedElsRef.current[i].removeAttribute('data-jobcv-picked')
        }
      } else if (pickedElRef.current) {
        pickedElRef.current.removeAttribute('data-jobcv-picked')
      }
      setNotes([])
      setPicked(null)
      setDraft('')
      pickedElRef.current = null
      pickedElsRef.current = null
      setAnnotating(false)
    }
  }

  // The post body: fetched when the Post tab is opened, and re-fetched when
  // the document poll reports a newer one (the agent re-storing what it
  // fetched, or another window pasting it). Never on the poll interval —
  // this is thousands of characters.
  React.useEffect(
    function () {
      if (!showingPost) return undefined
      var stopped = false
      setPostLoading(true)
      fetchPost(props.sessionId)
        .then(function (body) {
          if (stopped) return
          setPostLoading(false)
          setPost(
            body && typeof body.text === 'string' && body.text !== ''
              ? {
                  text: body.text,
                  source: body.source,
                  updatedAt: body.updatedAt,
                  html: typeof body.html === 'string' ? body.html : '',
                  htmlUpdatedAt: body.htmlUpdatedAt || 0,
                }
              : null,
          )
        })
        .catch(function () {
          if (stopped) return
          setPostLoading(false)
          // Keep whatever was already shown; the empty state explains itself.
        })
      return function () {
        stopped = true
      }
    },
    [
      showingPost,
      props.sessionId,
      doc.postUpdatedAt,
      doc.postChars,
      doc.postHtmlUpdatedAt,
      postTick,
    ],
  )

  // Same marker pattern as the post body: briefUpdatedAt moves, we refetch.
  React.useEffect(
    function () {
      if (!showingPost) return undefined
      var stopped = false
      setBriefLoading(true)
      fetchBrief(props.sessionId)
        .then(function (body) {
          if (stopped) return
          setBriefLoading(false)
          setBrief(body && body.brief ? body.brief : null)
        })
        .catch(function () {
          if (stopped) return
          setBriefLoading(false)
        })
      return function () {
        stopped = true
      }
    },
    [showingPost, props.sessionId, doc.briefUpdatedAt, postTick],
  )

  function askForPostFetch() {
    var via = deliverToComposer(props.inputActions, buildPostFetchRequest(doc), props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: 'post' })
  }

  function askForBrief() {
    var via = deliverToComposer(props.inputActions, buildBriefRequest(doc), props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: 'post' })
  }

  function askToFitPages() {
    if (overflow.length === 0) return
    var message = buildOverflowRequest(overflow, doc, commentWhat)
    var via = deliverToComposer(props.inputActions, message, props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: commentTarget })
  }

  function askForFit() {
    var via = deliverToComposer(props.inputActions, buildFitRequest(doc), props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: 'fit' })
  }

  function askToCloseGaps(gaps) {
    if (!gaps || gaps.length === 0) return
    var via = deliverToComposer(props.inputActions, buildGapMessage(gaps, doc), props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: 'cv' })
  }

  // The loading treatment for marked parts has TWO phases, one rule per
  // element in both:
  //
  //   queued  — while comment mode is open, the parts already added to the
  //             batch carry [data-jobcv-noted], so they are the selector;
  //             they dim and pulse the moment they are queued, not when the
  //             batch is sent.
  //   working — once the batch is on its way to the agent, the same
  //             treatment rides the anchor paths, so it keeps pointing at
  //             the same parts even after comment mode closes.
  //
  // The frame is same-origin, which is what lets the parent paint into it —
  // the same mechanism comment mode picks with.
  React.useEffect(
    function () {
      var queuedPhase = annotating && notes.length > 0
      if ((!workingParts && !queuedPhase) || showingPost) return undefined
      var idoc = null
      try {
        idoc = iframeRef.current && iframeRef.current.contentDocument
      } catch (e) {
        idoc = null
      }
      if (!idoc || !idoc.head) return undefined
      var css = workingParts ? buildWorkingCss(working.anchors) : buildQueuedCss()
      if (css === '') return undefined
      var style = idoc.createElement('style')
      style.id = 'dsh-job-cv-working'
      style.textContent = css
      idoc.head.appendChild(style)
      return function () {
        try {
          if (style.parentNode) style.parentNode.removeChild(style)
        } catch (e) {
          /* the frame may have been replaced already */
        }
      }
    },
    [workingParts, annotating, notes, showingPost, loadTick, working],
  )

  // A save while looking at an old version would leave the pane showing
  // something the timeline no longer describes — for either document.
  React.useEffect(
    function () {
      setLooking(null)
    },
    [doc.version, doc.letter ? doc.letter.version : 0],
  )

  // Switching tabs leaves the open timeline describing the document you just
  // left — including the Post tab, which has no timeline at all.
  React.useEffect(
    function () {
      setHistoryOpen(false)
      setLooking(null)
      setRestoreStatus(null)
    },
    [view],
  )

  function askForLetter() {
    // One letter request at a time: while one is in flight the button is
    // disabled, and this guard is the backstop for a double-activation in
    // the same frame the disabled state would not have rendered yet.
    if (working !== null && working.target === 'letter') return
    // Land the user on the letter's own surface immediately: the skeleton
    // under the working badge IS the preview's loading state for the request.
    setView('letter')
    var via = deliverToComposer(props.inputActions, buildLetterRequest(doc), props.draft)
    setSent(deliveryNotice(via))
    if ((via === 'sent' || via === 'queued') && props.onWorkStarted)
      props.onWorkStarted({ target: 'letter' })
  }

  // Comments belong to the document they were marked on: the highlights are
  // painted into the other iframe document and do not survive the switch, and
  // a batch that mixed the two would be sent under one heading naming one of
  // them. Dropping them silently is what would be unkind, so it is said.
  function switchView(next) {
    if (swipeHint) {
      setSwipeHint(false)
      savePrefs(props.sessionId, { swipeHintSeen: true })
    }
    if (next === view) return
    // Edits only exist in the frame until they are saved, and the other tab
    // renders a different document into it. Unsaved words are not something
    // to drop with a notice the way a queued comment is.
    if (editing) {
      if (editDirty) {
        setSent('Save or discard your edits first — they only exist in this preview.')
        return
      }
      discardEdit()
    }
    setPostTextEdit(false)
    var pending = collectNotes().length
    setView(next)
    setPicked(null)
    setDraft('')
    setNotes([])
    pickedElRef.current = null
    setSent(
      pending > 0
        ? pending +
            (pending === 1 ? ' note was' : ' notes were') +
            ' dropped — a comment belongs to the document it was marked on'
        : null,
    )
  }

  // Swipe between the CV / letter / post tabs on touch devices. The iframe
  // swallows the gesture, so attachSwipe (in the deck) detects it inside the
  // document and forwards it here; the ref carries the latest view list so
  // the handler stays registered once instead of churning every render.
  var swipeRef = React.useRef(function () {})
  swipeRef.current = function (dir) {
    var next = views[views.indexOf(view) + dir]
    if (next) switchView(next)
  }
  React.useEffect(function () {
    setSwipeHandler(function (dir) {
      swipeRef.current(dir)
    })
    return function () {
      setSwipeHandler(null)
    }
  }, [])

  function toggleAnnotating() {
    var next = !annotating
    setAnnotating(next)
    setSent(null)
    if (!next) {
      if (pickedElsRef.current) {
        for (var i = 0; i < pickedElsRef.current.length; i++) {
          pickedElsRef.current[i].removeAttribute('data-jobcv-picked')
        }
      } else if (pickedElRef.current) {
        pickedElRef.current.removeAttribute('data-jobcv-picked')
      }
      setPicked(null)
      setDraft('')
      setNotes([])
      pickedElRef.current = null
      pickedElsRef.current = null
    }
  }

  // ---- edit mode ----
  // What edit mode is about on the surface showing now. The post joins the
  // two documents here: it carries no version line, but it has a page, and a
  // wrong salary line in it is still wrong.
  var editKind = showingPost ? 'post' : showingLetter ? 'letter' : 'cv'
  var editWhat = showingPost ? 'job post page' : commentWhat
  var editNextVersion = showingPost ? null : liveVersion + 1
  var postPage = post && typeof post.html === 'string' ? post.html : ''
  // The post with no page yet is not a document, it is text — and PostSurface
  // already edits it as text. Edit points at that editor rather than
  // pretending there is a page to type into.
  var postTextEditing = showingPost && postTextEdit
  // Nothing to edit until there is something of the user's to edit: the start
  // form and the starter template are not their words, and an old version is
  // LOOKED at, not changed — the banner above it offers Restore, which is the
  // honest way back to editable. A document the agent is mid-rewrite of is
  // not worth typing into either: the save that lands replaces all of it.
  // The post is measured on its own terms — it exists before the first CV
  // does, so the CV's starter state says nothing about it.
  var canEdit = showingPost
    ? !onboarding && !workingHere
    : !onboarding && !starter && !showingOld && !showingLetterPending && !workingWholeDoc
  // A save that landed under the edit. The edit still applies and still
  // saves; it just saves on top of a version its author never saw.
  var editMovedUnderneath =
    editing &&
    editBaseRef.current !== null &&
    !showingPost &&
    editBaseRef.current.version !== liveVersion

  // Is the save still on its way back? Each document is caught up by its own
  // version line; the post has none, so it is caught up when the page the tab
  // re-fetched is the page that was saved.
  var editHolding =
    editSaved !== null &&
    (editSaved.kind === 'cv'
      ? doc.version < editSaved.version
      : editSaved.kind === 'letter'
        ? !doc.letter || doc.letter.version < editSaved.version
        : postPage !== editSaved.html)

  // Once the store's copy has landed the hold is over; keeping it would pin
  // the preview to one save forever.
  React.useEffect(
    function () {
      if (editSaved !== null && !editHolding) setEditSaved(null)
    },
    [editHolding, editSaved],
  )

  function editFrame() {
    return showingPost ? postFrameRef.current : iframeRef.current
  }

  function startEdit() {
    if (editing || !canEdit) return
    if (showingPost && postPage === '') {
      setPostTextEdit(true)
      return
    }
    var idoc = null
    try {
      var frame = editFrame()
      idoc = frame && frame.contentDocument
    } catch (e) {
      idoc = null
    }
    if (!idoc || !idoc.body) {
      setSent('The document is still loading — try Edit again in a moment.')
      return
    }
    // Comment mode and edit mode both own the pointer inside the document,
    // and the timeline describes a document that is about to change.
    setAnnotating(false)
    setHistoryOpen(false)
    setSent(null)
    setEditError(null)
    setEditDirty(false)
    setEditNoteText('')
    // Freeze what the frame renders from. Without this an agent save landing
    // mid-edit swaps the srcdoc and takes the half-typed edit with it.
    editBaseRef.current = {
      kind: editKind,
      version: showingPost ? 0 : liveVersion,
      key:
        'edit:' + editKind + ':' + String(showingPost ? post && post.htmlUpdatedAt : liveVersion),
      html: showingPost ? postPage : html,
    }
    setEditing(true)
  }

  function discardEdit() {
    // Leaving edit mode unfreezes the frame's key, which remounts it and
    // reloads the SAVED document — that is what throws the edits away.
    editBaseRef.current = null
    setEditing(false)
    setEditDirty(false)
    setEditBusy(false)
    setEditError(null)
    setEditNoteText('')
  }

  function commitEdit() {
    if (editBusy) return
    var idoc = null
    try {
      var frame = editFrame()
      idoc = frame && frame.contentDocument
    } catch (e) {
      idoc = null
    }
    var next = idoc ? serializeEditedDoc(idoc) : ''
    if (next.trim() === '') {
      setEditError('could not read the edited document — nothing was saved')
      return
    }
    var kind = editKind
    var what = editWhat
    setEditBusy(true)
    setEditError(null)
    saveEditedDoc(props.sessionId, kind, next, editNoteText, post)
      .then(function (version) {
        setEditBusy(false)
        discardEdit()
        setEditSaved({ kind: kind, version: version, html: next })
        setSent(
          version === null
            ? 'Saved your edit to the job post page.'
            : 'Saved as ' + what + ' v' + version + '.',
        )
        // The post has no version line for the stream to announce, so the
        // tab is told to re-read what it just wrote.
        if (kind === 'post')
          bumpPostTick(function (n) {
            return n + 1
          })
      })
      .catch(function (err) {
        setEditBusy(false)
        setEditError(String(err && err.message ? err.message : err))
      })
  }

  // Flip the showing frame's body to contentEditable while edit mode is on,
  // and watch it for the first keystroke — Save stays inert until there is
  // something to save. Same-origin access is what makes this possible without
  // ever granting the frame allow-scripts.
  React.useEffect(
    function () {
      if (!editing) return undefined
      var frame = showingPost ? postFrameRef.current : iframeRef.current
      if (!setDocEditable(frame, true)) {
        setEditError('this document cannot be edited in place')
        return undefined
      }
      var idoc = null
      try {
        idoc = frame.contentDocument
      } catch (e) {
        idoc = null
      }
      if (!idoc) return undefined
      function onInput() {
        setEditDirty(true)
        // The sheet is a fixed-height frame sized to the document it loaded
        // with. Typing makes the document taller, and without re-measuring
        // the new lines fall off the bottom of the frame and vanish — and a
        // line too many is exactly what pushes a page past A4.
        if (!showingPost) {
          measureFrame()
          refreshDeck()
        }
      }
      idoc.addEventListener('input', onInput, true)
      try {
        if (frame.contentWindow) frame.contentWindow.focus()
      } catch (e) {
        /* the caret lands on the first click instead */
      }
      return function () {
        try {
          idoc.removeEventListener('input', onInput, true)
        } catch (e) {
          /* the frame is already gone */
        }
        setDocEditable(frame, false)
      }
    },
    [editing, showingPost, loadTick],
  )

  function exportPdf() {
    // The dialog's "Save as" name is a document title, so the title becomes
    // the filename convention for as long as the dialog is up.
    var fileName = exportFileName({
      name: candidateNameFrom(html),
      kind: showingLetter ? 'letter' : 'cv',
      jobTitle: doc.jobTitle,
      company: doc.company,
    })
    // Both titles: the host page is what Chrome reads for the filename, the
    // frame's own is what a browser printing the subframe on its own terms
    // would read.
    var undoTitle = wearPrintTitle(fileName)
    var win = null
    try {
      win = iframeRef.current && iframeRef.current.contentWindow
      if (win) {
        if (fileName !== '' && win.document) win.document.title = fileName
        win.focus()
        win.print()
        return
      }
    } catch (e) {
      /* fall through to the standalone-window fallback */
    }
    // The frame was unreachable, so nothing will print from this page and no
    // 'afterprint' is coming: give the shell its own title back now.
    undoTitle()
    // Reached only when the frame is genuinely unreachable (detached, or a
    // browser that refuses same-origin srcdoc access).
    var w = window.open('', '_blank')
    if (w) {
      w.document.open()
      w.document.write(html)
      w.document.close()
      if (fileName !== '') {
        try {
          w.document.title = fileName
        } catch (e) {
          /* the tab still opens; only its default filename is the old one */
        }
      }
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

  // What the version chip says: the start form, the starter template, a
  // live version, a just-landed save, or a preview that has lost contact
  // with the host.
  var statusText = showingOld
    ? 'viewing ' + commentWhat + ' v' + looking.version + ' of ' + liveVersion
    : showingLetterPending
      ? 'cover letter — writing…'
      : showingLetter
        ? 'cover letter v' + doc.letter.version
        : onboarding
          ? 'start form'
          : starter
            ? 'starter template'
            : 'v' + doc.version
  var statusColor = pal.text
  if (!props.online) {
    statusText = onboarding
      ? 'host unreachable'
      : starter
        ? 'host unreachable'
        : 'v' + doc.version + ' · host unreachable'
    statusColor = pal.dark ? '#ffb4a2' : '#b3261e'
  } else if (props.flash && !starter) {
    statusText = 'v' + doc.version + ' · just updated'
    statusColor = pal.accent
  }

  // The swipe hint is for fingers, not mice — a coarse primary pointer is
  // the honest proxy for a touch device.
  var touchCoarse = false
  try {
    touchCoarse =
      typeof window !== 'undefined' &&
      !!window.matchMedia &&
      window.matchMedia('(pointer: coarse)').matches
  } catch (e) {
    touchCoarse = false
  }

  // What the sheet renders from. Normally the live document; frozen on the
  // snapshot while it is being edited, and held on the just-saved bytes until
  // the store's copy of them arrives — unfreezing any earlier would remount
  // the frame on the PRE-edit version, a flash that reads as "it did not
  // save".
  var frameKey = doc.version
  var frameHtml = html
  if (editing && editBaseRef.current !== null) {
    frameKey = editBaseRef.current.key
    frameHtml = editBaseRef.current.html
  } else if (editHolding && editSaved.kind !== 'post') {
    frameKey = 'saved:' + editSaved.kind + ':' + String(editSaved.version)
    frameHtml = editSaved.html
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
          flexDirection: 'column',
          borderBottom: '1px solid ' + pal.panelBorder,
          flex: 'none',
        },
      },
      // Row one is the document switcher, and ONLY the switcher: its own
      // centered row, so it stays put no matter what arrives on the action
      // row below it — a fit score, a new tab, a history panel.
      createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '6px 12px 0',
          },
        },
        !onboarding && views.length > 1
          ? createElement(
              'span',
              {
                style: {
                  display: 'inline-flex',
                  border: '1px solid ' + pal.controlBorder,
                  borderRadius: 6,
                  overflow: 'hidden',
                },
              },
              views.map(function (which) {
                var active = view === which
                return createElement(
                  'button',
                  {
                    key: which,
                    type: 'button',
                    onClick: function () {
                      switchView(which)
                    },
                    style: {
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 12,
                      lineHeight: '16px',
                      padding: '4px 10px',
                      color: active ? pal.accent : pal.text,
                      background: active
                        ? pal.dark
                          ? 'rgba(122,184,255,0.18)'
                          : 'rgba(46,111,219,0.12)'
                        : 'transparent',
                      // The letter tab pulses the moment the letter lands, so
                      // the arrival is noticed even from the CV tab.
                      animation:
                        which === 'letter' && letterArrived
                          ? 'dsh-job-cv-pulse 640ms ease'
                          : 'none',
                    },
                  },
                  which === 'cv'
                    ? 'CV'
                    : which === 'post'
                      ? 'Post'
                      : doc.letter
                        ? 'Letter v' + doc.letter.version
                        : // On its way: the tab carries the working dots until
                          // the letter lands and the version can be named.
                          createElement(
                            'span',
                            { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
                            'Letter',
                            createElement(WorkingDots, {
                              color: active ? pal.accent : pal.text,
                              size: 4,
                            }),
                          ),
                )
              }),
            )
          : !onboarding && !doc.letter && !editing
            ? createElement(
                'button',
                {
                  type: 'button',
                  onClick: askForLetter,
                  title: 'Ask for a one-page cover letter to go with this CV',
                  style: toolbarBtn,
                },
                '+ Cover letter',
              )
            : null,
      ),
      swipeHint && !onboarding && views.length > 1 && touchCoarse
        ? createElement(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '3px 12px 0',
                fontSize: 10,
                color: pal.text,
                opacity: 0.75,
              },
            },
            createElement('span', { 'aria-hidden': 'true' }, '‹'),
            'swipe to switch',
            createElement('span', { 'aria-hidden': 'true' }, '›'),
          )
        : null,

      // Row two: status on the left, actions on the right, wrapping as it
      // must on a narrow pane.
      createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 12px 8px',
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
        // The letter has its own version line, so it has its own timeline.
        !onboarding &&
          !editing &&
          !showingPost &&
          !(showingLetter && doc.letter.version < 2 && !historyOpen)
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: toggleHistory,
                title: 'Restore an earlier saved version of the ' + commentWhat,
                style: historyOpen
                  ? Object.assign({}, toolbarBtn, {
                      background: pal.dark ? 'rgba(122,184,255,0.22)' : 'rgba(46,111,219,0.16)',
                      borderColor: pal.accent,
                      color: pal.accent,
                    })
                  : toolbarBtn,
              },
              'History',
            )
          : null,
        // The score sits in the toolbar rather than behind the panel: "how
        // close am I" should be answered without opening anything.
        !onboarding && !editing
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  if (doc.fit) setFitOpen(!fitOpen)
                  else askForFit()
                },
                title: doc.fit
                  ? 'What this CV answers in the post, and what it does not' +
                    (fitStale(doc.fit, doc) ? ' (scored against an older version)' : '')
                  : 'Ask the agent to score this CV against the job post',
                style: doc.fit
                  ? Object.assign({}, toolbarBtn, {
                      color: fitColor(doc.fit.score, pal.dark),
                      borderColor: fitColor(doc.fit.score, pal.dark),
                      fontWeight: 600,
                    })
                  : toolbarBtn,
              },
              doc.fit
                ? doc.fit.score + '% fit' + (fitStale(doc.fit, doc) ? ' ·' : '')
                : 'Score fit',
            )
          : null,
        !onboarding && !editing && !doc.letter && views.length > 1
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: askForLetter,
                // While the letter is being written the trigger becomes the
                // status: disabled, dimmed, and carrying the working dots —
                // the request cannot be fired twice.
                disabled: letterPending,
                title: letterPending
                  ? 'The agent is writing the cover letter — it lands in the preview when it is done'
                  : 'Ask for a one-page cover letter to go with this CV',
                style: letterPending
                  ? Object.assign({}, toolbarBtn, { opacity: 0.55, cursor: 'default' })
                  : toolbarBtn,
              },
              letterPending
                ? createElement(
                    'span',
                    { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                    'Writing cover letter',
                    createElement(WorkingDots, { color: pal.accent, size: 4 }),
                  )
                : '+ Cover letter',
            )
          : null,
        !onboarding && !editing && !showingPost
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: toggleAnnotating,
                title: annotating
                  ? 'Stop marking parts of the ' + commentWhat
                  : (touchCoarse ? 'Tap' : 'Click') +
                    ' a line in the ' +
                    commentWhat +
                    ' to say what needs fixing',
                style: annotating
                  ? Object.assign({}, toolbarBtn, {
                      background: pal.dark ? 'rgba(122,184,255,0.22)' : 'rgba(46,111,219,0.16)',
                      borderColor: pal.accent,
                      color: pal.accent,
                    })
                  : toolbarBtn,
              },
              annotating ? 'Done commenting' : 'Comment on a part',
            )
          : null,
        // Edit: the one action here that does not go through the agent. A
        // typo, a date, a name — you already know the words, and a turn of
        // chat plus a whole-document rewrite is the wrong price for them.
        canEdit && !editing
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: postTextEditing
                  ? function () {
                      setPostTextEdit(false)
                    }
                  : startEdit,
                title: postTextEditing
                  ? 'Close the post text editor'
                  : showingPost && postPage === ''
                    ? 'Edit the stored text of the posting'
                    : 'Change the wording yourself — it saves as a new version of the ' + editWhat,
                style: postTextEditing
                  ? Object.assign({}, toolbarBtn, {
                      background: pal.dark ? 'rgba(122,184,255,0.22)' : 'rgba(46,111,219,0.16)',
                      borderColor: pal.accent,
                      color: pal.accent,
                    })
                  : toolbarBtn,
              },
              postTextEditing ? 'Done editing' : 'Edit',
            )
          : null,
        props.canFullScreen && !editing
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
        // Close and Full screen both unmount or remount the pane, and the
        // edit lives in the frame until it is saved — so while editing they
        // stand down and the two exits are the edit bar's own.
        !editing
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: props.onClose,
                title: 'Hide the preview (chat returns to full width)',
                style: toolbarBtn,
              },
              'Close',
            )
          : null,
        !onboarding && !editing && !showingPost && !showingLetterPending
          ? createElement(
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
            )
          : null,
      ),
    ),
    // the overflow strip — the PDF is about to come out longer than the
    // preview looks, and this is the only place that can say so
    overflow.length > 0 && !showingPost && !onboarding
      ? createElement(
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
              color: pal.dark ? '#ffb4a2' : '#b3261e',
              borderBottom: '1px solid ' + pal.panelBorder,
              background: pal.dark ? 'rgba(211,47,47,0.14)' : 'rgba(211,47,47,0.08)',
            },
          },
          createElement(
            'span',
            null,
            overflow
              .map(function (o) {
                return 'Page ' + o.page + ' runs ' + o.over + 'mm past A4'
              })
              .join(' · ') +
              ' — the exported PDF will be ' +
              (overflow.length === 1 ? 'a sheet' : overflow.length + ' sheets') +
              ' longer than this, with the overflow broken across the page break.',
          ),
          createElement('span', { style: { flex: 1 } }),
          createElement(
            'button',
            {
              type: 'button',
              onClick: askToFitPages,
              title: 'Ask the agent to move the overflow so each page fits A4',
              style: Object.assign({}, toolbarBtn, {
                borderColor: pal.dark ? '#ffb4a2' : '#b3261e',
                color: pal.dark ? '#ffb4a2' : '#b3261e',
              }),
            },
            'Make it fit',
          ),
        )
      : null,
    // edit bar — the mode's own strip: what is being edited, what version it
    // will land as, and the only two ways out of it.
    editing
      ? createElement(EditBar, {
          pal: pal,
          what: editWhat,
          nextVersion: editNextVersion,
          note: editNoteText,
          onNote: setEditNoteText,
          busy: editBusy,
          dirty: editDirty,
          error: editError,
          movedUnderneath: editMovedUnderneath,
          onSave: commitEdit,
          onDiscard: discardEdit,
        })
      : null,
    // history panel
    historyOpen && !showingPost
      ? createElement(HistoryPanel, {
          pal: pal,
          what: commentWhat,
          versions: versions,
          currentVersion: liveVersion,
          busy: restoreBusy,
          status: restoreStatus,
          previewingVersion: looking === null ? null : looking.version,
          onPreview: lookAt,
          onRestore: restoreTo,
          onClose: function () {
            setHistoryOpen(false)
            setRestoreStatus(null)
          },
        })
      : null,
    showingOld
      ? createElement(
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
            'Looking at ' +
              commentWhat +
              ' v' +
              looking.version +
              ' — nothing is changed until you restore it.',
          ),
          createElement('span', { style: { flex: 1 } }),
          createElement(
            'button',
            {
              type: 'button',
              onClick: function () {
                restoreTo(looking.version)
              },
              disabled: restoreBusy,
              style: Object.assign({}, toolbarBtn, {
                background: pal.dark ? 'rgba(122,184,255,0.18)' : 'rgba(46,111,219,0.12)',
                borderColor: pal.dark ? 'rgba(122,184,255,0.4)' : 'rgba(46,111,219,0.35)',
              }),
            },
            'Restore v' + looking.version,
          ),
          createElement(
            'button',
            {
              type: 'button',
              onClick: function () {
                setLooking(null)
              },
              style: toolbarBtn,
            },
            'Back to v' + doc.version,
          ),
        )
      : null,
    // review panel — a pending proposal outranks everything else here: it is
    // the one thing blocking the document from changing.
    doc.proposal
      ? createElement(ReviewPanel, {
          pal: pal,
          proposal: doc.proposal,
          sessionId: props.sessionId,
          inputActions: props.inputActions,
          draft: props.draft,
          onWorkStarted: props.onWorkStarted,
        })
      : null,
    // fit panel — the score, and the gaps to close before the first interview
    fitOpen && doc.fit
      ? createElement(FitPanel, {
          pal: pal,
          fit: doc.fit,
          doc: doc,
          onRescore: askForFit,
          onAskGaps: askToCloseGaps,
          onClose: function () {
            setFitOpen(false)
          },
        })
      : null,
    // comment panel
    annotating
      ? createElement(CommentPanel, {
          pal: pal,
          what: commentWhat,
          coarse: touchCoarse,
          picked: picked,
          draft: draft,
          notes: notes,
          setDraft: setDraft,
          onAdd: addNote,
          onSend: sendNotes,
          onDropPicked: function () {
            if (pickedElsRef.current) {
              for (var i = 0; i < pickedElsRef.current.length; i++) {
                pickedElsRef.current[i].removeAttribute('data-jobcv-picked')
              }
            } else if (pickedElRef.current) {
              pickedElRef.current.removeAttribute('data-jobcv-picked')
            }
            setPicked(null)
            setDraft('')
            pickedElRef.current = null
            pickedElsRef.current = null
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
    // document surface — or the job post, which is text, not a printed page
    showingPost
      ? createElement(PostSurface, {
          pal: pal,
          post: post,
          // Edit mode drives whichever frame is showing, so the post's page
          // frame is handed up rather than owning its own copy of it.
          pageFrameRef: postFrameRef,
          frozenPage:
            editing && editBaseRef.current !== null && editBaseRef.current.kind === 'post'
              ? editBaseRef.current
              : editHolding && editSaved.kind === 'post'
                ? { key: 'saved:post:' + String(editSaved.html.length), html: editSaved.html }
                : null,
          editingText: postTextEdit,
          onEditingText: setPostTextEdit,
          brief: brief,
          briefLoading: briefLoading,
          working: workingHere ? working : null,
          doc: doc,
          loading: postLoading,
          sessionId: props.sessionId,
          onSaved: function () {
            bumpPostTick(function (n) {
              return n + 1
            })
          },
          onAskFetch: askForPostFetch,
          onAskBrief: askForBrief,
        })
      : createElement(
          'div',
          {
            ref: surfaceRef,
            style: {
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              display: 'flex',
              justifyContent: 'center',
              padding: '14px 10px',
              position: 'relative',
            },
          },
          workingHere && !showingPost
            ? createElement(WorkingBadge, {
                pal: pal,
                label:
                  working.target === 'letter'
                    ? doc.letter
                      ? 'Working on the cover letter…'
                      : 'Writing the cover letter…'
                    : starter
                      ? 'Writing your CV…'
                      : workingParts
                        ? 'Working on ' +
                          working.anchors.length +
                          (working.anchors.length === 1 ? ' marked part…' : ' marked parts…')
                        : 'Revising v' + doc.version + '…',
              })
            : null,
          onboarding && !working
            ? createElement(StartForm, {
                pal: pal,
                sessionId: props.sessionId,
                inputActions: props.inputActions,
                draft: props.draft,
                onWorkStarted: props.onWorkStarted,
              })
            : showingLetterPending
              ? // The letter does not exist yet, so there is nothing to blur —
                // the shimmering sheet under the badge above is the loading.
                createElement(LetterSkeleton, { pal: pal })
              : workingHere && starter
                ? // Nothing to blur yet, and the starter template is not the user's
                  // document — show the shape of what is coming instead.
                  createElement(CvSkeleton, { pal: pal })
                : createElement(
                    'div',
                    {
                      style: {
                        position: 'relative',
                        flex: 'none',
                        margin: '0 auto',
                        width: Math.round(SHEET_W * scale) + 'px',
                        height: Math.round((frameH + 2) * scale) + 'px',
                        // The landing: the finished letter rises into place
                        // where the skeleton just was.
                        animation:
                          showingLetter && letterArrived
                            ? 'dsh-job-cv-sheet-in 560ms ease-out'
                            : 'none',
                      },
                    },
                    createElement('iframe', {
                      // Frozen while editing, held while the save is in
                      // flight — see frameKey/frameHtml above.
                      key: frameKey,
                      ref: iframeRef,
                      srcDoc: frameHtml,
                      title: 'CV document',
                      sandbox: 'allow-same-origin allow-modals',
                      onLoad: function () {
                        // The page deck comes FIRST: it changes the layout the
                        // measurement below reads. srcdoc + allow-same-origin makes
                        // the frame same-origin, so the document height is readable:
                        // stretch the iframe to the full multi-page height and let
                        // the outer pane scroll.
                        refreshDeck()
                        measureFrame()
                        // Data-URI images and any late reflow land after onLoad;
                        // a second pass catches a multi-page document that is
                        // still settling, so its last page is never cut off —
                        // and re-decides which page overflows now that the
                        // images have their real height.
                        setTimeout(function () {
                          refreshDeck()
                          measureFrame()
                        }, 300)
                        bumpLoad(function (n) {
                          return n + 1
                        })
                      },
                      style: {
                        // TRUE A4, always: the document lays out at the same
                        // 210mm the PDF prints at. A pane narrower than the sheet
                        // scales the whole thing down (transform below) instead
                        // of reflowing it.
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '210mm',
                        height: frameH + 'px',
                        background: '#fff',
                        border: '1px solid ' + pal.panelBorder,
                        borderRadius: 3,
                        boxShadow: pal.dark
                          ? '0 2px 14px rgba(0,0,0,0.45)'
                          : '0 2px 14px rgba(0,0,0,0.13)',
                        transform: 'scale(' + scale + ')',
                        transformOrigin: 'top left',
                        // The version on screen is about to be replaced: softened so it
                        // reads as superseded, still legible enough to keep your place.
                        filter: workingWholeDoc && !editing ? 'blur(2.5px) saturate(0.85)' : 'none',
                        opacity: workingWholeDoc && !editing ? 0.62 : 1,
                        transition: 'filter 240ms ease, opacity 240ms ease',
                        pointerEvents: workingWholeDoc && !editing ? 'none' : 'auto',
                      },
                    }),
                  ),
        ),
    // reopen affordance lives in the dock, not here
  )
}

// ------------------------- history timeline -------------------------
// A column of timestamps tells you nothing about which version you want, so
// each entry carries the note its author wrote, and clicking one SHOWS it in
// the preview. Restoring is a second, deliberate step from there: looking is
// how you decide, and it should not be the same gesture as changing.
function HistoryPanel(props) {
  var pal = props.pal
  var versions = props.versions
  var current = props.currentVersion
  var previewing = props.previewingVersion

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

  function when(ts) {
    if (!ts) return ''
    try {
      return new Date(ts).toLocaleString()
    } catch (e) {
      return ''
    }
  }

  return createElement(
    'div',
    {
      style: {
        flex: 'none',
        maxHeight: '50%',
        overflow: 'auto',
        padding: '10px 12px 12px',
        borderBottom: '1px solid ' + pal.panelBorder,
        background: pal.panelBg,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
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
            color: pal.text,
          },
        },
        (props.what || 'CV') + ' history',
      ),
      createElement(
        'span',
        { style: { fontSize: 11, color: pal.text } },
        'click a version to look at it — restoring is a separate step',
      ),
      createElement('span', { style: { flex: 1 } }),
      createElement('button', { type: 'button', onClick: props.onClose, style: btn }, 'Close'),
    ),
    versions === null
      ? createElement('div', { style: { fontSize: 12, color: pal.text } }, 'loading…')
      : versions.length === 0
        ? createElement(
            'div',
            { style: { fontSize: 12, color: pal.text } },
            'no saved versions yet',
          )
        : createElement(
            'div',
            { style: { position: 'relative', paddingLeft: 20 } },
            // the rail the dots sit on
            createElement('div', {
              style: {
                position: 'absolute',
                left: 5,
                top: 10,
                bottom: 10,
                width: 2,
                background: pal.panelBorder,
              },
            }),
            versions.map(function (row) {
              var isCurrent = row.version === current
              var isShown = row.version === previewing || (previewing === null && isCurrent)
              return createElement(
                'div',
                {
                  key: row.version,
                  style: { position: 'relative', paddingBottom: 6 },
                },
                createElement('span', {
                  style: {
                    position: 'absolute',
                    left: -19,
                    top: 8,
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    boxSizing: 'content-box',
                    background: isShown ? pal.accent : pal.baseBg,
                    border: '2px solid ' + (isShown ? pal.accent : pal.controlBorder),
                  },
                }),
                createElement(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      flexWrap: 'wrap',
                      padding: '4px 6px',
                      borderRadius: 6,
                      background: isShown
                        ? pal.dark
                          ? 'rgba(122,184,255,0.10)'
                          : 'rgba(46,111,219,0.07)'
                        : 'transparent',
                    },
                  },
                  createElement(
                    'button',
                    {
                      type: 'button',
                      onClick: function () {
                        props.onPreview(row.version)
                      },
                      title: 'Show this version in the preview',
                      style: {
                        border: 'none',
                        background: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        textAlign: 'left',
                        flex: 1,
                        minWidth: 140,
                      },
                    },
                    createElement(
                      'span',
                      {
                        style: {
                          fontSize: 12,
                          fontWeight: 600,
                          color: isShown ? pal.accent : pal.textStrong,
                        },
                      },
                      'v' + row.version,
                    ),
                    isCurrent
                      ? createElement(
                          'span',
                          { style: { fontSize: 10, color: pal.text, marginLeft: 6 } },
                          'current',
                        )
                      : null,
                    createElement(
                      'div',
                      { style: { fontSize: 12, color: pal.textStrong, marginTop: 1 } },
                      row.note
                        ? row.note
                        : createElement('em', { style: { color: pal.text } }, 'no note'),
                    ),
                    createElement(
                      'div',
                      { style: { fontSize: 10, color: pal.text, marginTop: 1 } },
                      when(row.updatedAt),
                    ),
                  ),
                  isCurrent
                    ? null
                    : createElement(
                        'button',
                        {
                          type: 'button',
                          onClick: function () {
                            props.onRestore(row.version)
                          },
                          disabled: props.busy,
                          title: 'Make this the current version (saved as a new one)',
                          style: btn,
                        },
                        'Restore',
                      ),
                ),
              )
            }),
          ),
    props.status !== null && props.status !== undefined
      ? createElement('div', { style: { fontSize: 11, color: pal.accent } }, props.status)
      : null,
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
          // On a phone a drag is how you scroll, so the range gesture is not
          // offered there — tapping each part in turn builds the same batch.
          notes.length === 0
            ? props.coarse
              ? 'Tap any line, bullet or heading in the ' +
                props.what +
                ' below to mark it. Tap each part you want to change — they go' +
                ' to the agent as one message.'
              : 'Click any line, bullet or heading in the ' +
                props.what +
                ' below to mark it — or drag across several to mark the whole range.'
            : (props.coarse ? 'Tap' : 'Click') +
                ' another line to add to the batch, or send the ' +
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
            picked.section
              ? 'In “' +
                  picked.section +
                  '”' +
                  (picked.parts && picked.parts.length > 1
                    ? ' — ' + picked.parts.length + ' parts, one range'
                    : '')
              : picked.parts && picked.parts.length > 1
                ? picked.parts.length + ' parts — one range'
                : 'Selected',
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
