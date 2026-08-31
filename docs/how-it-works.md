# How it works

The route surface, the document rules, and the behaviour of each panel.
For the shape of the codebase see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Host half** (`lib/index.js`) seeds the `job` agent preset into
  `$DSH_HOME/.agent-presets/job` and the `/job` skill bridge, and serves
  the `/jobcv/*` surface:
  - `GET /jobcv/doc?session=<id>` — the session's current document
  - `GET /jobcv/stream?session=<id>` — the same projection as a
    server-sent stream: a save pushes, so the preview does not wait
    for a poll
  - `POST /jobcv/doc` — replace the whole document, bump the version
  - `GET /jobcv/workspace?session=<id>` — the candidacy folder path and
    the files in it (shown in the dock)
  - `POST /jobcv/workspace` — upsert the candidacy folder
    `<root>/<company>/<job-id>/` and record it on the session
  - `GET /jobcv/file?session=<id>&name=<path>` — serve one candidacy file
    (the dock's chips preview it on hover — or on tap, on a touch device —
    and `Open ↗` opens it in a new tab)
  - `POST /jobcv/intake` — stage a CV file dropped in the browser, return
    its path
  - `GET /jobcv/post?session=<id>` — the job post text (falls back to
    `notes/job-post.txt` in the candidacy folder)
  - `POST /jobcv/post` — store the fetched, or pasted, post text
  - `GET /jobcv/fit?session=<id>` — the match score and the gaps
  - `POST /jobcv/fit` — score this CV against this post
  - `GET /jobcv/history?session=<id>` — the saved versions, newest first
    (`&kind=letter` for the cover letter's own timeline, `&kind=master` for
    the master CV's)
  - `GET /jobcv/cvs?session=<id>` — the latest CV of every past application,
    newest first, deduped per candidacy folder — the onboarding pick list,
    with `master` carrying the mirrored master CV when one exists
  - `GET /jobcv/joblist?session=<id>` — the session's stored pick list: the
    parsed markdown of postings, its source path, and the default CV path
  - `POST /jobcv/joblist` — parse a markdown file into that pick list (from a
    typed path relative to the session's working directory, a dropped `.md`
    staged as bytes, or raw `text`)
  - `GET /jobcv/candidacies?session=<id>` — this session's candidacies: the
    active one plus every archived one, with version/status/activity markers
  - `POST /jobcv/switch` — make another posting this session's active
    candidacy (`{sessionId, jobUrl, company?, jobTitle?, cvPath?}`); the
    outgoing one archives whole, and the answer says whether earlier work
    came back (`resumed`)
  - `GET /jobcv/applications?session=<id>` — every application: latest
    CV/letter/post per candidacy with its status tag and activity time, plus
    the per-status counts the panel header shows
  - `POST /jobcv/status` — record where an application stands
    (`drafting | applied | interview | offer | rejected`, plus a note);
    moving to `applied` stamps the date, and the tag mirrors into the
    candidacy folder as `status.json`
  - `POST /jobcv/restore` — roll the document back to an earlier version
    (a restore is itself a save, so the rollback is never destructive;
    `{"kind":"letter"}` rolls the cover letter back instead, and
    `{"kind":"master"}` the master CV)
  - `GET /jobcv/master?session=<id>` — the master CV: the full source-of-
    truth document plus its mirrored path (`<root>/master/cv/latest.html`,
    created on read so the pick list can hand it out); `null` before the
    first save
  - `POST /jobcv/master` — replace the master and bump its own version line
    (kept beside the session records as `master.json`, last 10 versions);
    never refused by a mid-turn switch — it belongs to no posting
  - `GET /jobcv/delta?session=<id>` — what the active CV changed against the
    master: counts (added/removed/unchanged blocks) and only the change
    entries, from a host-side normalized block diff (`&kind=letter` diffs
    the cover letter instead)
  - `GET /jobcv/skill` — the agent-facing contract (A4, self-contained,
    truthful tailoring)
- **Client half** (`lib/client.js`, built from `lib/client/` fragments)
  registers into `conversation.input.dock`. When the session preset is
  `job` the dock shows a **Show preview / Hide preview** button that opens
  the CV in one of two shapes:
  - _split_ (center column ≥ 860px) — the conversation is squeezed into a
    chat sidebar **on the right** and the CV pane is portalled into the
    whole area that frees up on its left, so nothing of the chat stands
    over the page. The sidebar is 460px wide and gives width back down to
    340px on a tighter column, because the preview keeps a 520px floor
    before the split is abandoned; every pixel above that goes to the CV,
    not to the chat. The self-healing DOM transform follows the same
    proven pattern as dsh-trader's chart host.
  - _overlay_ — when there is no room to split, or via **Full screen** on
    a wide column, the CV fills the window. `Esc` returns.

  The room is measured on the **center column**, not on the window: the
  shell spends width on its session sidebar and, when it is open, on the
  details panel, so a wide window can still leave a column too narrow to
  divide. Dragging either panel re-decides the shape live.

  The document is **pushed**: the pane holds a server-sent stream
  (`GET /jobcv/stream`) and a save writes one frame to it, so every agent
  save appears live and is announced ("v4 · just updated"). A 2.5s poll
  runs underneath as the fallback — it starts with the pane, stops at the
  first frame that proves the stream works, and comes back whenever the
  stream drops. An `EventSource` failure carries no status, and only the
  poll can tell a host that has gone away from the 403 the trust gate
  returns on a LAN address, so a host that stops answering is reported
  rather than silently freezing the preview.

  The document renders as paper, not as a scroll: each `<div class="page">`
  division the agent writes is drawn as a separate A4 sheet on a desk, with
  the page break visible as the gap and shadow between sheets — a two-page CV
  shows two pages, not one long strip. Documents without page divisions still
  get a boundary line every 297mm, so the break is readable either way. The
  contract tells the agent to paginate deliberately with `.page`; the deck
  styling is injected by the parent under `@media screen`, so it never affects
  the printed PDF.

  **Nothing blank prints.** Two different things put a blank sheet in the
  exported PDF, and only one of them is visible in the preview. An empty
  `<div class="page">` draws a full A4 sheet on the desk, so you can see it —
  but a stray `<br>` or an empty spacer div sitting _between_ or _after_ the
  sheets draws nothing at all against the desk background, and print has no
  desk: it still takes up space, and one line of it is enough to push a whole
  blank page into the PDF. That is how the preview can show the right number
  of pages and the export still come out one too long.

  So the deck marks both, on the same test, and hides them in _every_ medium
  rather than only on screen — a sheet the preview drops has to be a page the
  PDF does not print, or the two are disagreeing again, which is the one thing
  this deck exists to prevent. What counts as content errs hard toward keeping
  the page: words, an image, a rule, a table, a signature, even a decorative
  background all hold one open, and an element that _is_ the thing that draws
  (a stray `<img>` beside the sheets) counts as much as one containing it. A
  false blank would delete part of the document; a false keep is only the
  status quo. A blank page comes _back_ while you are editing, dashed, since
  that is exactly where someone would want to fill one in. A trailing sheet
  carrying overflowed text is untouched: it has real content on it — see
  below.

  **A sheet that does not fit is named, not hidden.** The other way a PDF goes
  wrong is a `.page` taller than the paper: it does not just lose its own
  tail, it pushes everything after it down, so the next sheet starts partway
  into a printed page and the last millimetres land on a page of their own.
  One page 17mm too long is what turns a two-page CV into a three-page PDF
  with a list broken across the break — and the preview cannot show it,
  because on screen a sheet simply grows.

  So the preview measures. Every `.page` is compared against a real 297mm
  probe (not a hand-computed 96dpi figure, which is how rounding becomes a
  false warning on every page), the offending sheet's A4 boundary turns red,
  and a strip says which page and by how many millimetres — with **Make it
  fit**, which asks the agent to move the overflow, naming the page and the
  number. It is told what not to do about it: not shrink the type, not cut the
  evidence.

  And every `.page` after the first now starts on **fresh paper** in print. A
  `.page` division means a sheet, so one over-long page costs its own extra
  sheet instead of shifting every page below it out of register for the rest
  of the document — which is what "it broke my formatting" looks like.

  The preview is TRUE A4: the document lays out at 210mm — the width the PDF
  prints at — and when the pane is narrower than a full sheet, the whole
  sheet SCALES down as one (transform, never reflow), so a preview page and a
  printed page can no longer disagree. A `@media print` normalizer pins the
  page box (border-box, 210mm of paper including padding, no margins), and
  the A4 boundary is drawn on the sheet itself: content that would spill onto
  a second printed page crosses the line in the preview at exactly that spot.

  The document is agent-authored, so the deck also defends: `<script>`
  elements are stripped (the sandbox blocks them and logs an error), an
  embedded external page becomes a link (LinkedIn and most boards refuse to
  be framed and the blocked frame renders as a broken box), and `<a href>`
  links open in a new tab from the parent — same-frame navigation would
  replace the preview with the linked page, and `target="_blank"` inside the
  sandbox is blocked. The exported PDF keeps the anchors as-is, and they stay
  clickable there.

  The boundary between the preview and the chat is a **draggable divider**:
  pulling it wider gives the chat more room and the sheet scales to what
  remains (down to a 240px floor), double-clicking it returns to the computed
  split, and the chosen share persists per session.

  On a touch device, a horizontal swipe across the sheet moves between the
  CV, cover letter and Post tabs. The sandboxed iframe swallows the gesture,
  so it is detected inside the document and forwarded to the pane, and a
  vertical scroll never reads as a switch (the drag must be clearly
  horizontal). A one-time **‹ swipe to switch ›** hint sits under the tab
  switcher until the first switch, and only when the pointer is coarse — it
  is a hint for fingers, not mice.

  The rest of the surface meets fingers halfway too. A coarse pointer gets
  **34px-tall controls** everywhere in the pane, the overlay and the dock
  (the desktop paddings give ~22px, under even the 24px WCAG floor), and
  **16px inputs** — an input under 16px makes iOS Safari zoom the whole page
  on focus, which a layout of fixed panes cannot shrug off. The split
  divider's grab area widens from 7px to 28px (still invisible), the file
  preview popover clamps to the viewport instead of clipping off a 360px
  phone, the overlay and both document surfaces contain their scrolls rather
  than chaining into the page behind them, and the start form's link and path
  fields stop fighting the mobile keyboard (`type=url`, no autocapitalize or
  autocorrect). On a phone the toolbar drops its "CV preview" eyebrow — the
  dock already said it — and the comment box loses the ⌘/Ctrl+Enter hint,
  which names a keyboard the reader does not have.

### The cover letter

**+ Cover letter** in the toolbar asks the agent for a one-page letter to go
with the CV. The preview switches to the letter's own surface immediately —
a shimmering skeleton sheet under the working badge — and the button becomes
a disabled writing status, so the request cannot be fired twice. When the
letter lands, the finished sheet rises into place (and the Letter tab
pulses). Once one exists the toolbar becomes a **CV / Letter** toggle and
Export PDF prints whichever is shown. The letter is a second document, not a
section of the CV: its own version line (`POST /jobcv/letter`), its own
`letter/` folder beside `cv/`. Revising a paragraph of the letter should not
renumber the CV's history.

### The job post, in the preview

The document is written against the post, and the post lived in whichever
browser tab it was copied from — so checking a requirement meant leaving the
preview. The toolbar toggle is **CV / Letter / Post**, and Post shows the
readable text of the posting: what the agent fetched, stored per candidacy
(`POST /jobcv/post`, mirrored to `notes/job-post.txt`) so it outlives the
posting being pulled or the link rotting.

It is also **pasteable** and **fetchable**: **Refresh** (and **Fetch the post
for me** on an empty tab) asks the agent to re-read the link and store the
latest text — postings get edited, requirements change, applicant counts move.
The browser cannot fetch a job board itself (most are cross-origin), so this
rides the same chat-request path as a fit score; the agent POSTs the text, the
poll notices, and the tab updates on its own. Many boards render through
JavaScript and `curl` comes back with an empty shell, which the contract
already warns the agent about; pasting is the way out, and pasted text is
authoritative over whatever the scrape managed to get.

The body is fetched only when the tab wants it — the `/jobcv/doc` projection
carries a marker (`postChars`, `postUpdatedAt`), never thousands of
characters of posting.

What leads the tab is not the dump but the posting **as a page**: a styled
A4 document, like the CV itself — company name and logo at the top, then the
company, the team, the job, the requirements and the expectations, in the
post's own words. The agent builds it (`POST /jobcv/post` with an `html`
field) under the same self-contained rules as the CV document, embedding the
logo as a small data URI.

**The red marks are the point.** Every requirement the CV does not yet
evidence is wrapped in `<mark class="dsh-gap">` and painted red by the
preview — blockers solid, majors underlined, minors dashed, with the "what is
missing" on hover and a legend at the top of the page. The marks and the fit
score's gaps are the same judgement: the agent builds them together and moves
both when it re-scores. The preview owns the red convention (injected into the
iframe by the parent), so the marks cannot be restyled out of existence by an
agent stylesheet.

What is missing is one **tap** away on a phone: the explanation lives in the
mark's `title`, and a title is a hover tooltip — with no hover, the red marks
were the whole message. Tapping a mark (or clicking it) opens a small dark
callout rendered from that very attribute, one at a time; tapping again,
tapping anywhere else, or scrolling closes it, and a drag stays a scroll. The
callout is `@media screen`-only, so it can never print. Edit mode stands it
down — a callout under a caret being placed is noise.

The brief remains for what a page cannot show — the practical facts as a
strip: location and remote policy, salary range if stated, when it was
posted, how many have applied, the deadline.

The agent builds it (`POST /jobcv/brief`) from the post text and what the
company says about itself, on the same honesty rules as everything else:
every section names its source (posting / company site / LinkedIn / estimate),
an estimate says what would confirm it, and the meta strip carries only what
it could verify — the board's own applicant counts, never invented ones.
The raw text stays reachable under **Full text**, and a posting with no brief
yet still reads, with a **Break this down for me** button that asks for one;
a brief of a post that has since been re-stored says it is stale.

### The fit score, and the gaps under it

**68% fit** sits in the preview toolbar and in the dock, and opens a panel
with the verdict, what is missing, and what already lands. Each gap carries a
severity (blocker / major / minor, blockers first), why it matters, and the
move that would close it — and a button that sends exactly that to the agent,
one gap or the whole set.

The number is computed by the **agent**, never in the browser. Keyword overlap
against the post would always be available and quietly wrong: it cannot tell a
requirement that is genuinely met from one that merely shares a word, and a
confident wrong number is worse than none. So the agent reads the post and the
document and POSTs its judgement (`POST /jobcv/fit`), the same way it proposes
changes.

A score is about a version. The CV moves underneath it, so the panel says what
it was scored against and marks itself stale (`68% fit ·`) the moment the CV or
the letter has been saved since. A save never clears the score — a blank panel
would read as "nothing happened" where a stale one says what changed under it.
The contract tells the agent what the number is not: alignment with this post,
never a probability of an offer.

### History as a timeline

**History** in the toolbar opens a timeline of saved versions, newest first,
each labelled with the note its author wrote ("Quantified the delivery
bullets") rather than a bare timestamp. Clicking an entry **shows** that
version in the preview — bodies are fetched one at a time
(`GET /jobcv/history?session=…&version=N`), never shipped with the list.

The **cover letter has its own timeline**, on the same terms: its own version
line, its own notes, its own rollback (`?kind=letter`). Both documents count
from v1, so a version is only ever shown under the tab it belongs to — and
switching tabs closes a timeline that describes the document you just left.

Looking changes nothing. A banner says so and offers the two ways out:
**Restore vN** or **Back to vN**. Restoring is a separate, deliberate gesture,
and it saves forward as a new version labelled `Restored vN`, so the timeline
explains its own jumps and nothing is ever lost by going back. A save landing
while you are looking at an old version returns you to the current one.

### The agent in the chat

Job mode's preset carries its own persona: **Close**, a candidate-side career
strategist who works for the candidate and never the employer. It leads with a
verdict rather than a preamble, calibrates level from evidence (scope owned,
who they influenced, whether they set direction) rather than from titles,
probes for the missing number instead of inventing one, attaches provenance to
every market figure it cites — role, level, geography, year, source — and ends
a substantive reply with one **Next move**.

It is deliberately industry-agnostic: it reads the post and calibrates to that
industry, sector and seniority conventions, on the rule that adjacent
specialisms are separate markets whose titles, bands and processes do not
transfer. The hard rules and the plugin's own contract agree where it matters
— never invent experience, and wording changes go to the user through
`/jobcv/proposal` rather than straight into a save.

The preset is seeded once into `$DSH_HOME/.agent-presets/job`. A later version
that ships a new persona **refreshes** that file, but only while it still
hashes to something this plugin wrote: edit one byte and it is yours, said out
loud in the log rather than silently overwritten. The harness reads presets at
boot, so a refresh lands on the next `dsh web` restart.

### The application tracker

**Applications** in the dock opens a panel over everything: one row per
candidacy, each carrying its status tag as a colored select (`drafting`,
`applied`, `interview`, `offer`, `rejected`), the latest CV and cover letter
versions it can point at, whether the post was stored, the fit score when one
was given, and how long ago any of that moved. Expanding a row shows the job
link, the applied date, the tag's history ("interview · 2d ago · panel Thu"),
the workspace path, direct links to `cv/latest.html`, `letter/latest.html` and
`notes/job-post.txt`, a note field, and — for rows belonging to another
session — **Resume here**, which hands the agent a message telling it to adopt
that exact folder rather than fork a new one.

Past a handful of applications, scanning stops working, so the overview is a
small workbench over the same listing:

- **Search** (`/` focuses it) reaches every field the host carries — company,
  role, link, folder path, note, and the note inside each entry of the tag's
  history. Whitespace terms AND together: `acme interview` finds the Acme row
  whose history says interview.
- **Three views** over the same rows. _List_ is the card view described above.
  _Board_ lays the pipeline out as five stage columns (drafting → rejected),
  one glanceable card per application, moving with its tag. _Table_ is a dense
  grid for surveying many rows at once — Role, Stage, Fit, Applied, Updated.
- **Filters built from what a job spec has**: stage chips carrying the counts
  of the full listing, an artifact facet (has a CV / letter / stored post /
  any note), a company facet derived from the candidacies themselves, fit
  bands mirroring the fit panel's thresholds (strong 75%+, partial 50–74%,
  thin under 50%, plus not-scored-yet), and recency buckets measured on each
  row's activity stamp (moved today / this week / this month / quiet 30+ days).
- **Sort on every axis** — recently updated (the default), applied date, fit
  score, company, role, or pipeline stage — with a direction toggle. Rows with
  no fit score or no applied stamp sort last whichever way the arrow points,
  so an ascending sort never photobombs with blanks.

Search, filters and sorting run client-side over the fetched listing (the host
caps it well below browser-painful sizes), and the chosen arrangement — view,
sort, filters — persists per session in localStorage. The typed query
deliberately does not persist: reopening the panel to a pre-typed search reads
as "where did my applications go". When facets hide everything, the empty
state says how many of how many are hidden and offers **Show everything**
instead of a bare blank.

The tag is deliberately the user's report, never an inference: the host
stores what was set with its date and note, stamps the applied date the
first time a row reaches `applied` (keeping it through `interview` and
`offer` — the day they applied does not move because the process did), and
the contract tells the agent to record a status only from something the user
actually said. Setting a row back to `drafting` clears the tag entirely.

Storage follows the plugin's oldest habit: the session record is the source
of truth, and the candidacy folder gets a mirror (`status.json`, written
temp-then-rename like every other mirrored file). On read the newer write
wins, so two sessions on one application converge, a hand edit outside the
harness counts, and a reset writes through — a stale mirror can never
resurrect an old tag on the next listing. A tag set anywhere is also
_activity_: its row rises, because what moved last is exactly what someone
scanning their search wants on top. The listing reads session files
directly, degrades over unreadable records instead of failing, and never
touches the read cache — an onboarding glance must not evict live sessions.

The dock carries the same state twice: a count on the button, and — once
this session's application is tagged — a pill next to the version line
("● applied · 12 Mar") that opens the panel. Both refresh when the panel
closes, not on every poll tick: the listing scans every session file, and
that is not a 2.5-second cost.

### Several jobs in one session

A session holds one ACTIVE candidacy document, and — since the jobs list
arrived — any number of parked ones. The session file keeps whichever is on
screen; each parked job lives in an archive file beside it
(`sessions/<id>.jobs/<hash>.json`, keyed by the posting's URL) holding its
entire record: every CV version, the cover letter and its timeline, the
stored post, the fit score, the status tag. **Switching** (`POST
/jobcv/switch`) parks the active record into its archive and loads the
target's — or a fresh, link-stamped record when that posting was never
worked on here — and pushes the new projection to the preview over the same
stream a save uses. A promoted archive deletes itself, so a session never
lists one candidacy twice.

The rest of the plugin treats archives as ordinary past applications: the
tracker aggregates them per workspace folder like any other session's rows,
and the onboarding pick list offers their mirrored `cv/latest.html` (only
the asking session's _active_ record stays hidden from it). A status tag
carries its `jobUrl`, so retagging a parked row writes into THAT job's
record instead of whichever candidacy happens to be active — a panel click
can never move the wrong application's status.

**Identity is the normalized link — at two grades of strictness.** Every
URL-derived key runs on the MATCHING form: trailing slash, `#fragment`,
host case, `http`/`https`, whitespace, `utm_*`, LinkedIn tracking dust and
sometimes-functional tokens like `?ref=` are all ignored when deciding
whether two spellings are one posting. Stored links keep the STORAGE form:
only unambiguously-cosmetic parameters are stripped, so an Ashby link whose
`?ref=` actually routes the board still fetches later. Without this split,
one posting becomes two records sharing one workspace folder, quietly
overwriting each other's `cv/latest.html` — or worse, a "cleaned" link stops
opening the right page.

**A save names its posting.** `/jobcv/doc`, `/letter`, `/post`, `/brief`,
`/fit` and `/proposal` accept an optional `jobUrl`; when it names a
candidacy that is no longer active — the user switched while the agent was
mid-turn — the save is refused with 409 (`stale save`) instead of landing
the wrong CV on whatever job is on screen now. Omitting it behaves exactly
as before; the contract tells the agent to always send it.

### Reviewing changes before they happen

The agent does not save wording changes — it proposes them. A pending
proposal takes over the top of the preview, showing per change what the text
says now, why the post makes it worth changing, two or three alternatives to
pick from, a box to write your own, and skip. One **Apply** sends every
decision as a single message, and the choices are binding: the contract tells
the agent to use them verbatim, not to re-word them or fold in what was
skipped. Formatting — margins, type sizes, section order — still saves
directly; approving a margin helps nobody.

Because one comment usually implicates more than the line commented on (cut a
claim from the summary and the bullet repeating it dangles), a proposal
carries a _set_ of changes decided together.

### Commenting on a part of the CV

**Comment on a part** in the preview toolbar turns the document on screen
into a pick surface: hover highlights the line under the cursor, clicking it
quotes that text into a comment box, and **dragging across several parts
grows the selection into one range** — everything the pointer touches joins
the note, each part quoted on its own line so the agent can find all of them.
Preset chips ("Quantify with real numbers", "Shorten this", …) fill in the
common asks. Notes queue up, so
one round of review becomes **one** chat message rather than one message
per fix — each send costs the agent a full turn and a document rewrite.

It works on the cover letter too, and the message says which document it is
about: "Revise one part of my cover letter (currently letter v2)", closing
with `POST /jobcv/letter` rather than the CV route. Without that the agent
reads any marked-up request as a request about the CV — rewriting the wrong
document and saving it over the right one. The two are never mixed in one
batch: switching CV ↔ Letter drops the pending notes (their highlights live
in the other document) and says so.

Sending is automatic: the composer's documented face is `setDraft` +
`submit`, so a finished comment goes straight to the agent. If you have your
own half-typed draft, the message is appended below it and left unsent
instead — `setDraft` writes the whole draft, so replacing it would destroy
your text and submitting would send it half-written.

While the agent works, three dots swell in sequence — and the loading lives
**only on the surface that was asked for**. A comment batch dims exactly the
marked parts, in two phases: the moment a part is added to the batch it dims
and pulses (queued), and once the batch is on its way to the agent the same
treatment rides the anchor paths. A cover-letter request shows on the
letter's own surface — a skeleton sheet while no letter exists yet, the
dimmed document once it does — and never dims the CV, a post request shows a
strip on the Post tab, a fit request shows in the dock alone. A request
committed to the composer counts — sent, or queued below your own draft —
and the state stays visible for at least three seconds even when a fast
agent answers at once, so it can never blink away unread; its own timer
then re-checks the landing, because a landed save may never be followed by
another frame to re-run the check. The working state ends the moment the
thing that was asked for lands — a CV save ends a CV request, a letter save
ends a letter request, new post text ends a post request — and a save
landing while something else is in flight does not clear the wrong thing.
It also gives up after six minutes, so a turn that answers without saving
cannot leave it showing forever.

The message names the document, the section, a CSS-ish path and the exact
current text for every note, and closes by asking the agent to save the
revision _and_ answer with judgement: whether each edit really strengthens
the CV for this job post, and which requests would overstate what the CV
supports.
`GET /jobcv/skill` documents that format on the agent side.

On a phone it is **tap to mark**. The picking was mouse-only to begin with —
`mousedown`, `mousemove`, `mouseup` — and a phone does not reliably make those
out of a tap: iOS Safari synthesizes them for elements it considers clickable
and not for a paragraph inside a frame, so tapping a line of the CV did nothing
at all and there was no way to comment from a phone. Touch is handled directly
now, the same lesson the swipe gesture already learned about this iframe. One
tap marks one part and the tap is cancelled so the mouse path cannot mark it
twice; dragging a _range_ stays a mouse affordance, because on a phone a drag
is how you scroll and taking that away would trap the reader on the first
screen of their own CV. Several parts are still one batch — tap, write, Add,
tap the next — and the panel says so in those words when the pointer is coarse.
While comment mode (or edit mode) is on, the swipe-to-switch gesture stands
down: switching tabs mid-comment drops the notes marked on that document.

The preview iframe never gets `allow-scripts` — picking works because the
frame is same-origin, so the _parent_ attaches the listeners and paints
the highlights. Highlight CSS is injected under `@media screen`, so it
can never appear in the exported PDF.

### Editing it yourself

Everything above routes through the agent, which is right for judgement — does
this bullet land, is this claim supported — and wrong for a typo, a date, a
place name, or a sentence you already know how to phrase. Asking a model to fix
_Singapor_ costs a full turn and a whole-document rewrite.

So **Edit** in the toolbar makes the document editable where it is. The sheet
does not become a form or a text box: you click into the page and type, the
block under the cursor tints to say it is yours to change, and the CV still
looks like the CV. It works the same way commenting does — the preview iframe
runs no scripts, but it _is_ same-origin, so the parent flips its body to
`contentEditable` and reads the result back out.

A hand edit is a save like any other. It goes through the same route the agent
writes to, so it takes the next number on the same version line and lands in
the same timeline — under `Edited by hand`, or under the one-line note you type
in the edit bar ("Fixed the start date"). Nothing is special-cased: History
lists it, and a rollback rolls it back.

Each tab edits its own thing. The CV bumps the CV, the cover letter bumps the
letter, and the Post tab edits the styled **page** — leaving the stored post
text exactly as it was fetched, because editing a page is not a claim about
what the posting said. A posting with no page yet is only text, and Edit opens
the text editor that was already there. Re-storing the same words no longer
ages the posting either, so attaching a page never marks the breakdown stale
for a post that has not changed a character.

The document is **frozen** while you edit it: the frame renders from the
snapshot the edit started on, so an agent save landing mid-sentence cannot swap
the page out from under the caret. It says so instead — _the agent saved while
you were editing_ — and your save still lands, on top of that version. For the
same reason Close and Full screen stand down while editing (both would tear the
pane down and take the unsaved words with it), and switching tabs with unsaved
changes is refused rather than silently dropped: **Save changes** and
**Discard** are the two ways out, and Discard reloads the saved document.

What gets saved is the author's document, not the preview's furniture. The page
deck, the comment highlights, the red gap marks, the edit affordance, the
viewport the deck declared, the `contentEditable` flag itself — all of it is
stripped from a _clone_ on the way out, so a failed save leaves you still
editing what you wrote. Two of the deck's defenses do become permanent, which is
what they should have been: `<script>` elements stay removed, and an embedded
external page stays a link to it.
