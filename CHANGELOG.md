# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0 and does not yet promise semantic-versioning stability.

## [Unreleased]

### Added

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
- Type-checking gate: `npm run typecheck` (`tsc --noEmit` over the host half via
  JSDoc + `checkJs`), wired into `npm test`.
- CI (GitHub Actions), `CONTRIBUTING.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`.

### Changed

- Persona: HARD RULE 1 is the facts-only doctrine; the cover-letter craft moved
  to the on-demand contract; the persona no longer hard-codes one runtime's
  page-reading story.
- Route handlers are thin wrappers over `lib/app/`; `routes.js` dropped ~400
  lines. MCP tools call the app in-process instead of over loopback HTTP.
- `LICENSE` is now the full MIT text (was a truncated paraphrase).
- Test runner is `node --test` (was a shell loop).
- `.npmrc` no longer forces `legacy-peer-deps`; `npm install` / `npm ci` pull
  the peer deps the test suite needs.

## [0.1.0]

Initial DSH web-GUI plugin: Job mode, the live A4 CV preview, the cover letter,
the job-post page and fit score, version history, change proposals, in-place
editing, the candidacy workspace, the application tracker, the master CV and
deltas, and jobs-list onboarding with per-session switching.
