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

Still open (phase 3):

- **Fold-back UI.** The contract already tells the agent how to propose a
  fold-back; a panel button ("fold these into my master") sending exactly
  that request would make it one tap.
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

- **One core, two shells.** `defineJobCvRoutes(deps)` was already
  shell-agnostic (it takes `store` / `resolveRoot` / `sendJson`, not `ctx`).
  The MCP shell stands those exact route groups on a plain `http.Server`
  (`lib/mcp/ui-server.js`), wrapped in the exact `guardHandler` the plugin
  uses. `lib/routes/mount.js` (the `ctx.webServer` binding) stays
  plugin-only.
- **Tools are thin wrappers over the routes, called over loopback HTTP** —
  not in-process. The route guard, body pipeline and trust check run once,
  identically, for the browser and for the tool layer. `isTrustedRequest`
  passes an internal `fetch` (loopback Host, `application/json`, no Origin).
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

Still open:

- **Proposal decisions have no back-channel.** In DSH the user's accept/skip
  travels to the agent through chat; the MCP shell has no chat. v1 shows a
  copy-paste relay in the Review tab. A `/jobcv/proposal/decision` that
  RECORDS the choice + a `jobcv_get what:"decision"` (or a resource) would
  close the loop.
- **Full render parity.** Port the shell-agnostic client fragments
  (`030-cv-preview`, `025-cv-annotate`, `027-cv-fit`, `031-cv-master`,
  `035-applications`, `036-jobs`) into a shared `lib/render/` bundle both
  shells load, so the MCP page gains annotate/history/master-diff without a
  second implementation.
- **Daemon mode.** Two MCP clients at once = two servers = two ports. A
  first-one-binds daemon would share one preview.
- **`jobcv_triage`.** `jobcv_load_joblist` + per-job `jobcv_open`/`jobcv_score`
  already covers list scoring by hand; a single tool that walks the list
  against the master and emits the scorecard is the obvious next step
  (see "Base shortlisting" above).
- **Reading the post.** The server has no fetch tool; the client fetches and
  `jobcv_set_post`s. If the host ever registers a fetch provider (see
  "Reading job posts" above) a `jobcv_ingest_post(url)` tool becomes trivial.

## Smaller

- The preview polls `/jobcv/doc` every 2.5s. A push channel (SSE, or the
  harness's own session stream) would drop the latency and the idle traffic.
- `test/annotate.test.mjs` builds fake nodes by hand. If a DOM harness ever
  lands here (dsh-trader uses jsdom), the picking effect in `CvPane` itself
  becomes reachable, not just its helpers.
- The rollback UI restores whole versions. A finer "restore just this
  section from an older version" would need diffing the two documents —
  probably more than the workflow needs today.
