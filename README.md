# dsh-job-cv

Job mode for the DeepSeek Harness web GUI. When the current session runs
the **job** agent preset, the layout flips: the chat narrows into a sidebar
column and the main area becomes a live CV preview rendered from an HTML
document the agent maintains — exportable to PDF from the toolbar (browser
print dialog, Save as PDF, A4).

Scoped to one workflow: tailoring the user's CV against a job post link
they provide together with their current CV.

## How it works

- **Host half** (`lib/index.js`) seeds the `job` agent preset into
  `$DSH_HOME/.agent-presets/job` and the `/job` skill bridge, and serves
  the `/jobcv/*` surface:
  - `GET /jobcv/doc?session=<id>` — the session's current document
  - `POST /jobcv/doc` — replace the whole document, bump the version
  - `GET /jobcv/workspace?session=<id>` — the candidacy folder path and
    the files in it (shown in the dock)
  - `POST /jobcv/workspace` — upsert the candidacy folder
    `<root>/<company>/<job-id>/` and record it on the session
  - `POST /jobcv/intake` — stage a CV file dropped in the browser, return
    its path
  - `GET /jobcv/post?session=<id>` — the job post text (falls back to
    `notes/job-post.txt` in the candidacy folder)
  - `POST /jobcv/post` — store the fetched, or pasted, post text
  - `GET /jobcv/fit?session=<id>` — the match score and the gaps
  - `POST /jobcv/fit` — score this CV against this post
  - `GET /jobcv/history?session=<id>` — the saved versions, newest first
    (`&kind=letter` for the cover letter's own timeline)
  - `POST /jobcv/restore` — roll the document back to an earlier version
    (a restore is itself a save, so the rollback is never destructive;
    `{"kind":"letter"}` rolls the cover letter back instead)
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

  The pane polls the document every 2.5s, so every agent save appears
  live and is announced ("v4 · just updated"); a host that stops
  answering is reported rather than silently freezing the preview.

  The document renders as paper, not as a scroll: each `<div class="page">`
  division the agent writes is drawn as a separate A4 sheet on a desk, with
  the page break visible as the gap and shadow between sheets — a two-page CV
  shows two pages, not one long strip. Documents without page divisions still
  get a boundary line every 297mm, so the break is readable either way. The
  contract tells the agent to paginate deliberately with `.page`; the deck
  styling is injected by the parent under `@media screen`, so it never affects
  the printed PDF.

  The preview is TRUE A4: the sheet renders at 210mm even when the pane is
  narrower (the pane scrolls instead of shrinking the paper), so the document
  lays out at exactly the width the PDF prints at — a preview page and a
  printed page can no longer disagree. A `@media print` normalizer pins the
  page box (border-box, 210mm of paper including padding, no margins), and
  the A4 boundary is drawn on the sheet itself: content that would spill onto
  a second printed page crosses the line in the preview at exactly that spot.

### The cover letter

**+ Cover letter** in the toolbar asks the agent for a one-page letter to go
with the CV; once one exists the toolbar becomes a **CV / Letter** toggle and
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

The body is fetched only when the tab wants it — `/jobcv/doc` is polled every
2.5s and carries a marker (`postChars`, `postUpdatedAt`), never thousands of
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
each labelled with the note its author wrote ("Quantified the the delivery
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
treatment rides the anchor paths. A cover-letter request shows on the letter
tab and never dims the CV, a post request shows a strip on the Post tab, a
fit request shows in the dock alone. A request committed to the composer
counts — sent, or queued below your own draft — and the state stays visible
for at least three seconds even when a fast agent saves within one poll, so
it can never blink away unread. The working state ends the moment the thing that was asked for lands —
a CV save ends a CV request, a letter save ends a letter request, new post
text ends a post request — and a save landing while something else is in
flight does not clear the wrong thing. It also gives up after six minutes, so
a turn that answers without saving cannot leave it showing forever.

The message names the document, the section, a CSS-ish path and the exact
current text for every note, and closes by asking the agent to save the
revision _and_ answer with judgement: whether each edit really strengthens
the CV for this job post, and which requests would overstate what the CV
supports.
`GET /jobcv/skill` documents that format on the agent side.

The preview iframe never gets `allow-scripts` — picking works because the
frame is same-origin, so the _parent_ attaches the listeners and paints
the highlights. Highlight CSS is injected under `@media screen`, so it
can never appear in the exported PDF.

## Workflow

1. Start a new session in **Job mode** (preset chip / Settings roster).
2. A fresh session shows an **onboarding start form** in the preview: paste
   the public job post link and point at your current CV — either type its
   path or drop the file (PDF/DOCX) onto the form, which stages it through
   `POST /jobcv/intake` and fills in the stored path. A company name is
   optional and steers the workspace folder.
3. **Start** hands the link + CV path to the chat. The agent fetches the
   post, upserts a candidacy workspace (`POST /jobcv/workspace`,
   `<root>/<company>/<job-id>/`), tailors the CV, and saves it through
   `POST /jobcv/doc` — the preview updates within seconds. If the composer
   is unreachable but a company name was given, the form opens the
   workspace itself and shows the message to copy. The save must carry
   `Content-Type: application/json`; the `/jobcv/skill` contract spells
   the call out, because the trust gate rejects the content type `curl -d`
   would otherwise pick.
4. The dock shows the workspace folder (labeled with company — job title
   when known) and the files the agent has saved into it, refreshed with
   the same poll as the preview.
5. Iterate by chatting ("make the summary sharper", "cut to one page").
   **History** on the preview toolbar lists every saved version, newest
   first, and restores any of them with one click — restoring is itself a
   save, so the old current version stays in history.
6. **Export PDF** on the preview toolbar.

## Development

- Edit the browser half in `lib/client/*.js`, then `npm run build:client`
  (`lib/client.js` is generated and stays committed).
- `npm test` verifies the built bundle matches its fragments and runs the
  host-half tests.

### The candidacy folder

One folder per application, upserted at `<root>/<company>/<job-id>/`. The
root is the **session's own working directory** — an application is work you
keep, open, diff and back up, so it belongs in the project you started the
session in rather than buried in `$DSH_HOME` beside the plugin's state.
Resolution order:

1. `$DSH_JOB_CV_ROOT` — an explicit choice always wins;
2. the session's `cwd`;
3. `$DSH_HOME/dsh-job-cv/applications` — only when the session has no cwd.

```
acme-corp/3812345678/
  README.md      what this application is, and the job link
  cv/            v1.html, v2.html … plus latest.html
  source/        the CV as supplied — never edited
  notes/         the fetched job post, research, cover letter drafts
```

The host derives both folder names (`slugify` for the company; the job's own
id from the URL, else a slug of the last path segment, else a digest of the
link). That is what makes the upsert an upsert: a second session about the
same job — even typing the company differently — lands in the same folder and
gets `created:false`, the agent's cue to say it is resuming rather than
starting over.

Every save is mirrored into `cv/` from inside the store's write lock, so the
folder holds the actual document rather than only a README, and `latest.html`
is directly openable and printable outside the harness. Mirroring never fails
a save: the session file is the source of truth, and a folder that has been
moved or made read-only only logs a warning. A CV dropped into the start form
lands in `source/` once the folder exists, and in per-session staging before
that (browsers withhold the real path of a dropped file, so its bytes are
uploaded).

- Documents persist per session under `$DSH_HOME/dsh-job-cv/sessions/`
  with the last 10 versions kept in history — the groundwork for a fuller
  job workspace (rollback, multiple documents per job application).
  Saves are serialized per session and written temp-file-then-rename, and
  a document file that cannot be parsed raises instead of quietly reading
  as a new session (which would let the next save overwrite it).

MIT
