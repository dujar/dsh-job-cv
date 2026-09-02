# TODO

## The master CV — source of truth, and deltas against it — RESOLVED (phase 1+2)

The onboarding pick list now pins one **master CV** above every past
application's tailored byproduct: one document every application tailors,
with its own version line (`master.json` beside the session records, last 10
kept), mirrored to `<root>/master/cv/latest.html` on save AND on read so a
new project root always meets it with a real file. `GET /jobcv/delta`
computes what a tailored CV changed against it, and the preview's **vs
master** panel renders that diff.

Design decisions worth remembering:

- **Full documents everywhere; deltas are derived views.** Nothing is stored
  as a patch and nothing is reconstructed from one — storage dedup saves
  kilobytes nobody cares about, and would break every consumer of plain HTML
  files (dock previews, tracker links, hand edits, export). Token savings
  come from what READERS read: the host computes the diff mechanically
  (normalized text blocks + LCS, `lib/store/cv-diff.js`) and ships only
  change entries, so reviewing N applications costs N small deltas instead
  of N full CVs.
- **The model never diffs and never merges.** An LLM asked to diff two CVs
  burns tokens producing what `diffBlocks` computes deterministically for
  free. Where judgement is needed (folding an improvement back), the flow is:
  read the compact delta → PROPOSE in chat → save only what the user agreed
  to verbatim.
- **The master belongs to no posting** — `/jobcv/master` deliberately skips
  the `assertActiveJob` 409 guard, because a mid-turn switch must never
  refuse folding an improvement back into the user's source of truth.
- **Master markers ride the /jobcv/doc projection** (`masterVersion`,
  `masterUpdatedAt`), the same pattern as the post's markers: the toolbar
  button appears without any probe request, and `sameDoc()` compares them so
  a master save pushes a fresh frame to open previews.

Phase 3 — sync-down — RESOLVED:

- **Syncing an improved master back into a tailored CV.** The mirror image of
  the fold-back. `GET /jobcv/delta?dir=incoming` diffs `master@base` →
  `master@HEAD`, where `base` is `record.baseMasterVersion` — a new record
  field seeded to the master HEAD on the first CV save, carried forward on
  ordinary saves, moved only by an explicit sync save that passes
  `baseMasterVersion`. A CV written before the field existed reads as 0 and
  the delta infers a base from the oldest master still retained
  (`baseInferred:true`). Same rule as everywhere else: the host does the
  mechanical diff, the model proposes only what fits the post, the user
  decides in Review, nothing is merged automatically. The MCP preview's
  **Master** tab renders the master beside the tailored CV, lists the
  incoming changes, and raises the `sync-master` request in one tap;
  `jobcv_context` carries `baseMasterVersion` + `masterSyncAvailable`.
- **A skip is final for future incoming deltas** (the next sync runs from the
  reconciled version), but the master keeps the skipped block and the
  outgoing `/jobcv/delta` still surfaces it — so nothing is lost, it just
  stops nagging.

Still open:

- **Fold-back UI.** The contract already tells the agent how to propose a
  fold-back; a panel button ("fold these into my master") sending exactly
  that request would make it one tap. (The MCP Master tab is the natural
  home for it now — the sync-down button already lives there.)
- **The DSH web preview** only has the outgoing "vs master" panel. The
  Master tab / side-by-side / incoming delta are MCP-only for now; porting
  `031-cv-master.js` is the follow-up.
- **Base shortlisting.** With many applications, the host could rank which
  past variant is closest to a new post (stored posts ↔ fit scores ↔ titles)
  and hand the agent ONE reference delta with the master, instead of letting
  it choose blind. Not built until several flavors actually exist.
- **Named flavor library.** Several intentional masters ("Backend", "EM")
  under one canonical record. Deferred: the single master plus per-application
  deltas covers the workflow today; flavors add a naming/merge policy question
  that should not be solved speculatively.

## Onboarding flow — hand-off shape

A fresh session shows a start form in the preview (job post link + CV, plus
an optional company name). The CV field lists the latest CV of every past
application (`GET /jobcv/cvs`, one entry per candidacy folder) to pick from;
a typed path or a dropped file staged via `POST /jobcv/intake` covers a new
one. Submitting composes a chat message telling the agent to open the
candidacy workspace (`POST /jobcv/workspace`) and tailor the CV.

When the composer is unreachable and a company name was given, the form
falls back to calling `POST /jobcv/workspace` itself so the folder exists
anyway, and shows the message to copy into the chat. The agent is still the
reliable path for the normal case — it reads the company name and job id
off the fetched post.

## Jobs-list onboarding + switching — RESOLVED

The second onboarding door now exists. `POST /jobcv/joblist` parses a
markdown file of postings into a per-session pick list (`- Title — https://…`
lines, a `## Company` heading sets the employer; deduped by URL; prose and
non-http links ignored). The start form's **From a list** tab offers its
lines; **Jobs** in the dock keeps them as a switcher.

Design decisions worth remembering:

- Switch identity is the jobUrl string — `POST /jobcv/switch` keys the
  archive by sha1(jobUrl), so the same link always lands on the same
  candidacy.
- The session file keeps the ACTIVE candidacy only; parked ones live in
  `sessions/<id>.jobs/<hash>.json`, whole records. Promoting an archive
  deletes it (best-effort) so listings never double-count.
- Status tags carry an optional jobUrl: `/jobcv/status` routes a tag into
  that job's archived record when it is not the active one.
- The pick list itself is a sidecar at `sessions/lists/<id>.json`; a corrupt
  sidecar degrades to empty (it is rebuilt by re-parsing), unlike session
  documents which raise.
- The contract (`GET /jobcv/skill`) tells the agent to switch BEFORE working
  another posting, and the panel's start message says the switch already ran
  so it does not switch again.
- Identity is the NORMALIZED link (hash/trailing-slash/whitespace stripped,
  same rule as the parser's dedupe), and the normalized form is what gets
  stored — otherwise `…/123` and `…/123/` fork two candidacies that share
  one workspace folder and clobber each other's mirrored cv/v1.html.
- Saves may carry their posting's `jobUrl`; a mismatch with the active one
  answers 409 ("stale save") so a mid-turn switch cannot misfile a tailored
  CV onto the wrong job. Omitting it keeps the old behavior.

## The three "already exists" edges — RESOLVED

- **Company-spelling forks.** Folders now resolve by posting, not by name:
  each records its canonical URL in `application.json`, legacy folders speak
  through their breadcrumb's `Job post:` line, and the upsert adopts ANY
  folder claiming the same link — however its company segment or job slug
  was spelled (`adoptedBy:'url'` / `'id'` / `'exact'`). A preferred path
  owned by a genuinely different posting yields a stable `<job>-<hash8>`
  sibling instead of mixing two applications into one `cv/`.
- **Tracking query dust.** URL handling is split in two grades: STORAGE
  (`normalizeUrl` — strips only unambiguous tracking; keeps `?ref=`,
  `gh_jid`, `vjk` so links still fetch) and MATCHING (`urlMatchKey` —
  additionally ignores `ref`). Archive keys, the 409 save guard and the
  client panel all compare on the matching form; stored links stay
  faithful. A parity fixture runs tricky URLs through BOTH implementations.
- **Concurrent mirrors.** All candidacy-folder writes (cv versions,
  latest.html, post text/html, status.json, application.json) run under a
  best-effort `.lock` directory: mkdir-based, waits up to 4s, takes over
  locks older than 60s, and PROCEEDS UNLOCKED on timeout — mirroring still
  never fails a save. Residual honesty: two live sessions interleaving
  saves still interleave version numbers per session; only whole-file torn
  states were ever possible and the lock narrows last-writer-wins to
  operation granularity.

Residuals worth remembering (after the follow-up round):

- README-evidence is only as true as the breadcrumb: a hand edit of the
  `Job post:` line changes what the folder claims to be. Accepted — the
  identity file has exactly the same property, and both are user-visible
  plain files on purpose.
- The URL-first scan reads at most 400 folders; a tree larger than that
  falls back to the name-based rules for whatever it did not reach. Raise
  MAX_FOLDERS_SCANNED if an applications root ever gets near it.
- MATCH_ONLY_PARAMS holds just `ref` today. It exists so the NEXT sometimes-
  functional token (`?vjk`-class) has a documented home that keeps stored
  links fetchable while identity stays generous — add tokens there, never
  to TRACKING_PARAMS, when stripping one would break a fetch.
- The identity file makes every folder root hold two files now; listings
  that asserted "README.md only" were updated.

## Composer face — RESOLVED

`inputActions` is documented by `@deepseek-ai/dsh-client-ui-conversation`
(`lib/types/client/input/contract.d.ts`):

    setDraft(text)   single public draft write path — the FULL next draft
    submit()         enter submission
    addImages / removeImage / pruneImages

Note `setDraft` REPLACES; there is no append. `deliverToComposer` therefore
appends below an existing draft itself and only submits when the composer was
empty. The name probe is kept as a narrow fallback for other shells.

## Reading job posts: no fetch provider exists

`web_fetch` cannot work in this harness. `dsh-web` resolves a provider per
capability, and while `dsh-web-search-deepseek` calls `registerSearchProvider`,
**nothing anywhere calls `registerFetchProvider`** — so every `web_fetch` call
raises `WEB_PROVIDER_UNAVAILABLE` ("no usable web provider is registered").
The shipped `standard` preset pins `fetch: false` for exactly this reason; the
job preset now does too, and the contract tells the agent to read the post with
`curl | perl` instead. `test/routes.test.mjs` pins this so it cannot regress.

Worth deciding: the host half could register its own fetch provider
(`ctx.web.registerFetchProvider`) and make `web_fetch` genuinely work for job
posts — better extraction than a shell pipeline, and it would benefit every
preset. That means owning redirect/size/timeout limits and an SSRF policy
(a job link is user-supplied and would be fetched by the host), so it is a
real feature rather than a config change. Until then the shell path stands.

## Job folder naming vs. a hand-kept convention

Folders already kept by hand look like `coinbase/7866674-senior-sw-engineer-trading-intx`
— the job id AND the title. `jobSlug` produces the id alone when the post has
one, so plugin-made folders read `3812345678/` instead.

Not changed, deliberately: the folder name is the upsert's identity, and
`jobTitle` is optional on `POST /jobcv/workspace`. Folding it into the path
would mean one call with a title and one without produce two folders for the
same job — losing the property the whole design defends. Closing this needs
the title to become required, or a lookup that matches an existing folder by
id prefix before creating a new one.

## MCP shell — RESOLVED (v1)

The plugin now also runs as an MCP server (`bin/dsh-job-cv-mcp.js`,
`lib/mcp/`). It is NOT a port: the DSH plugin is untouched and both shells
read/write the same `$DSH_HOME/dsh-job-cv` state.

Design decisions worth remembering:

- **One core, two shells.** The workflow's operations live in
  `lib/app/job-cv.js` (`createJobCvApp`): validation, the `assertActiveJob`
  guard, `normalize*`, the orchestrations — with typed errors
  (`lib/app/errors.js`). `defineJobCvRoutes` handlers are thin wrappers that
  parse the request and call one app method through `respond()`. The MCP
  shell builds ONE app instance and both its preview routes and its tools
  use it; the tools call it **in-process** (no loopback HTTP). Three routes
  stay handler-heavy — `/jobcv/stream`, `/jobcv/file`, `/jobcv/intake` — as
  pure transport.
- **`lib/routes/mount.js`** (the `ctx.webServer` binding + the typed-error
  status map) stays plugin-only; the MCP shell's `buildRouteTable` is the
  ~15-line `http.Server` equivalent.
- **The session id is the server's.** Minted once, remembered in
  `mcp-session.json`, injected into every request. The whole "copy the
  session id verbatim, a wrong one still 200s" section of the contract does
  not apply to this shell.
- **No SDK.** Newline-delimited JSON-RPC 2.0 over stdio, ~200 lines
  (`lib/mcp/server.js`), matching the package's zero-runtime-dep rule.
- **The preview is a new self-contained page** (`lib/mcp/ui.html`), not the
  DSH client bundle — it consumes the same `/jobcv/stream` SSE + `/jobcv/*`
  GETs, so it tracks saves live, but it does not (yet) have the annotate /
  mark-a-spot surface.

The preview is now interactive (RESOLVED, v2): light/dark/system theme, an
Overview dashboard, a request inbox (`lib/store/requests.js`, `/jobcv/request`,
`jobcv_context.pendingRequests`, `jobcv_resolve_requests`) that UI buttons and
CV line-marking feed, direct actions (switch / status / restore), and a
virtualised applications drawer.

Still open:

- **Proposal decisions still have no true back-channel.** The Review tab shows
  a copy-paste relay. It could raise a `revise`-style request instead so the
  agent picks the decision up from the inbox like everything else.
- **Full render parity.** The MCP `ui.html` re-implements the panels rather
  than sharing the DSH client fragments. A shared `lib/render/` bundle both
  shells load would remove the second implementation (annotate range-picking,
  master-diff, the page-overflow deck are DSH-only for now).
- **Backend pagination for the applications drawer.** The list is virtualised
  client-side but `/jobcv/applications` still returns the whole set (capped at
  200). True infinite scroll needs an `after=` cursor on that route.
- **Daemon mode.** Two MCP clients at once = two servers = two ports. A
  first-one-binds daemon would share one preview.
- **`jobcv_triage`.** `jobcv_load_joblist` + per-job `jobcv_open`/`jobcv_score`
  already covers list scoring by hand; a single tool that walks the list
  against the master and emits the scorecard is the obvious next step
  (see "Base shortlisting" above).
- **Reading the post.** The server has no fetch tool; the client fetches and
  `jobcv_set_post`s. If the host ever registers a fetch provider (see
  "Reading job posts" above) a `jobcv_ingest_post(url)` tool becomes trivial.
- **Per-domain route files.** `routes.js` dropped from 936 → ~530 lines once
  the handlers became thin, and is grouped by domain already. Splitting each
  `defineXRoutes` into its own `lib/routes/<domain>.js` is now mechanical if
  the file grows further.

## The fit assessment — sharpened (RESOLVED), and what's left

`normalizeFit` now carries `decidedBy`, `levelRead`, per-gap `kind` and `id`,
and per-strength `strength` grade; bands are the contract's calibration
boundaries (80/60/40), shared by the panel and the tracker filter via
`lib/shared/severity.js`. Gap ids match `data-dsh-gap-id` on the post marks,
and the CV frame now paints `.dsh-gap` marks too.

Still open:

- **Interactive gap ↔ mark cross-highlight.** The ids line up (data model +
  contract), but hovering a gap in the fit panel does not yet light up its
  mark in the post/CV iframe. The wiring is: on gap hover, reach into the
  iframe and toggle a class on `.dsh-gap[data-dsh-gap-id="gX"]`.
- **Host-side mark/gap count check.** `app.setFit` could parse the stored
  post html and warn when the marked ids and the scored gap ids diverge.
- **`lib/shared/severity.js` for the client.** The store imports it; the
  client keeps its own literal (IIFE, no imports) with a drift-guard test.
  A build-time inline into a generated fragment would make it truly one place.

## The candidate profile — RESOLVED (v1)

`profile.json` beside `master.json` (`lib/store/profile.js`): one plain-text
markdown document of standing facts about the person, last 8 versions.
`/jobcv/profile` GET/POST, `app.getProfile`/`saveProfile`, MCP
`jobcv_save_profile` + `jobcv://profile` resource + `jobcv_get what:"profile"`.
The persona reads it before the first question; the contract's "THE CANDIDATE
PROFILE" section holds the propose-then-save rule.

Still open:

- **No DSH client panel.** The agent reads and writes it; a DSH user has no
  UI to see or hand-edit it (the MCP preview could grow a textarea tab). The
  master CV went through the same v1 → panel arc.
- **No `notes/profile.md` mirror.** master.json mirrors to
  `<root>/master/cv/latest.html`; the profile could mirror to
  `<root>/candidate-profile.md` so it is a plain file a human keeps too.

## Smaller

- The preview polls `/jobcv/doc` every 2.5s. A push channel (SSE, or the
  harness's own session stream) would drop the latency and the idle traffic.
- `test/annotate.test.mjs` builds fake nodes by hand. If a DOM harness ever
  lands here (dsh-trader uses jsdom), the picking effect in `CvPane` itself
  becomes reachable, not just its helpers.
- The rollback UI restores whole versions. A finer "restore just this
  section from an older version" would need diffing the two documents —
  probably more than the workflow needs today.
