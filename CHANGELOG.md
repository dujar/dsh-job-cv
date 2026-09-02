# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0 and does not yet promise semantic-versioning stability.

## [Unreleased]

### Added

- **Print / Save-PDF button on the CV, cover letter and master CV.** The
  document toolbars gain a primary **⎙ Print / Save PDF** action that opens the
  document in its own top-level window (real A4, the in-page preview is a
  sandboxed iframe) and fires the browser's print / Save-as-PDF dialog once it
  lays out. The old "Open in tab (print / save PDF)" button stays, renamed
  "Open in tab", for viewing without the dialog.
- **HTTP transport for the MCP server** (`--http`). Alongside stdio, the server
  now speaks the MCP Streamable HTTP transport over one endpoint (`POST` returns
  `application/json`, `GET` is an SSE keep-alive stream, notifications get
  `202`), gated by an optional bearer token (`--http-token` /
  `$DSH_JOB_CV_MCP_TOKEN`). Both transports share one dispatcher and one
  in-process app instance. This is what lets a tunnel (cloudflared, ngrok) put
  the workflow behind a public HTTPS URL you add to **claude.ai as a custom
  connector** — so Claude on the web, mobile, or in Chrome drives the same
  workspace as the CLI. New flags: `--http`, `--http-port` (8123),
  `--http-host` (127.0.0.1), `--http-token`, `--http-path` (`/mcp`). See
  [README](README.md#reach-it-from-claudeai-web--mobile--claude-in-chrome).
- **A Jobs workbench in the MCP preview.** The new **Jobs** tab is a search
  engine over every tracked candidacy: a text box that matches company, role,
  link and note; facet chips for stage (`drafting … rejected`), for what a
  candidacy has to show (CV / letter / post) and, as selects, for company and
  fit band; the count updates as you narrow, `reset` clears it. Two views over
  the filtered set — a **Leaderboard** that ranks the scored candidacies by fit
  (the profile-match ordering) with the unscored listed below, and a
  **Table** whose every column header sorts. Each row carries a **source link**
  to the original posting, labelled with the portal it came from (Cryptocurrency
  Jobs, Ashby, LinkedIn, web3.career, MyCareersFuture …, else the bare host), and
  the portal name is searchable; the **stage tag is an inline editable select**
  that retags that row's own candidacy (routed by `jobUrl`, in its own session)
  without switching to it — so `POST /jobcv/status` and `jobcv_set_status` now
  take an optional `jobUrl`. A row opens that candidacy. View, sort and facets
  persist per browser; the typed query does not. All of it is client-side over
  the `/jobcv/applications` listing, which is unchanged.
- **The Master tab's deltas render as git-style diffs.** Both directions —
  what the master gained since this CV was reconciled (sync down), and what
  tailoring changed against the master (fold back) — now show hunks with
  `@@ -a,b +c,d @@` headers carrying the nearest section heading, old/new
  line numbers, context lines, word-level marks on a reworded pair, GitHub-ish
  `+N −M` stats with a ratio bar, and fold rows for long unchanged runs
  (click to expand). The hunks are computed in the browser with the same
  block normalization the host uses (`lib/store/cv-diff.js`) — the incoming
  diff fetches its `master@base` document via `GET /jobcv/history?kind=master`
  and falls back to the server-shipped change list when that version has aged
  out of the retained history. A segmented control picks the direction and
  remembers the choice; `/jobcv/delta` itself is unchanged and stays compact
  for the agent.
- **Sync an improved master back down into a tailored CV.**
  `GET /jobcv/delta?session=<id>&dir=incoming` (and `jobcv_get what:"master-delta"`)
  is the reverse of the fold-back view: the normalized block diff
  `master@base → master@HEAD`, where `base` is the master version this CV was
  last reconciled against (`record.baseMasterVersion`, seeded on the first
  save, inferred from the oldest retained master for CVs that predate the
  marker). The agent proposes only the additions that serve the job post,
  the user decides each in Review, and the save carries `baseMasterVersion`
  so the next sync starts from there. The MCP preview grows a **Master** tab —
  the master CV beside the tailored one, the incoming delta, and a one-tap
  "sync from master" ask; `jobcv_context.active` gains
  `baseMasterVersion` and `masterSyncAvailable`. The Master tab also shows the
  **outgoing** delta — what this tailored CV added or dropped against the
  master (`GET /jobcv/delta` with no `dir`) — so the fold-back candidates are
  visible at a glance.
- **MCP shell.** The workflow now also runs as a Model Context Protocol server
  (`dsh-job-cv-mcp`) for any MCP client, with its own live preview page. The
  DSH plugin is unchanged; both shells share state under `$DSH_HOME/dsh-job-cv`.
  See [README](README.md#also-an-mcp-server) and
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **`lib/app/` application service** — the workflow's operations, once; the
  routes and the MCP tools both call it (the tools in-process).
- **Sharper fit assessment** — `decidedBy`, `levelRead`, per-gap `kind`, gap
  `id`s that link to the post marks, per-strength `strength` grade; score
  bands calibrated to the contract and shared with the tracker.
- **Candidate profile** (`/jobcv/profile`, `jobcv://profile`) — standing facts
  about the person so a session does not re-derive them.
- **The MCP preview is now interactive**: light/dark/system theme, an Overview
  dashboard with metrics, and buttons that raise a structured request into an
  inbox the agent picks up via `jobcv_context` (write a cover letter, close a
  gap, re-score, fetch the post, or **Mark a line** on the CV). Direct actions
  — switch application, set status, restore a version. Applications moved to a
  virtualised drawer behind a discreet button. New: `jobcv_resolve_requests`,
  `?theme=` / `?drawer=` params.
- Type-checking gate: `npm run typecheck` (`tsc --noEmit` over the host half via
  JSDoc + `checkJs`), wired into `npm test`.
- CI (GitHub Actions), `CONTRIBUTING.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`.

### Changed

- The MCP preview's look: an editor's-desk theme — warm paper light, lamplight
  dark, serif display type for the company line, score and verdicts, and mono
  where line identity matters (versions, stats, the diff). Same tokens, both
  themes; `?theme=` and the theme button work as before.
- Persona: HARD RULE 1 is the facts-only doctrine; the cover-letter craft moved
  to the on-demand contract; the persona no longer hard-codes one runtime's
  page-reading story.
- Route handlers are thin wrappers over `lib/app/`; `routes.js` dropped ~400
  lines. MCP tools call the app in-process instead of over loopback HTTP.
- `LICENSE` is now the full MIT text (was a truncated paraphrase).
- Test runner is `node --test` (was a shell loop).
- `.npmrc` no longer forces `legacy-peer-deps`; `npm install` / `npm ci` pull
  the peer deps the test suite needs.
- MCP preview no longer rebuilds the view on every 3.5s poll — it re-renders
  only when the data behind the current tab actually changed. The old timer
  reloaded the panel's `<iframe>`s on every tick, flashing the CV/letter/post/
  master documents and scrolling them back to the top.

## [0.1.0]

Initial DSH web-GUI plugin: Job mode, the live A4 CV preview, the cover letter,
the job-post page and fit score, version history, change proposals, in-place
editing, the candidacy workspace, the application tracker, the master CV and
deltas, and jobs-list onboarding with per-session switching.
