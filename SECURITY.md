# Security

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/dujar/dsh-job-cv/security/advisories/new)
(private) or, if that is unavailable, email the address in the npm package
metadata. Please do not file a public issue for a vulnerability. Expect an
acknowledgement within a week.

## What this software touches

`dsh-job-cv` handles **personal data**: real CVs, employment history, contact
details, and the job postings a user is applying to. It is a **local-first
tool** and is designed so that data stays on the user's machine.

- **No telemetry, no outbound calls of its own.** The plugin/server never sends
  your documents anywhere. The only network requests are the ones an agent
  makes with its own tools (fetching a job post), and — in the MCP shell —
  those are performed by the MCP _client_, not this server.
- **All state is on disk under `$DSH_HOME/dsh-job-cv/`** (default
  `~/.dsh/dsh-job-cv/`) plus the candidacy folders mirrored into the user's
  chosen project directory. Deleting those directories deletes everything.
- **The LLM sees what you give it.** Tailoring a CV means the model reads your
  CV and the job post. Which model, and where it runs, is the harness's or the
  MCP client's configuration — not this project's.

## Trust model of the local HTTP surface

Both shells expose an HTTP surface on loopback (`/jobcv/*`, and in the MCP shell
a preview page). It is guarded, not open:

- **Loopback only.** The server binds `127.0.0.1`. A request whose `Host` is not
  a loopback name is refused.
- **Fail-closed CSRF check** (`lib/http/http-utils.js`): a cross-origin
  `Origin`/`Referer` is rejected outright (never falls through); an unparseable
  one is rejected; CORS-simple content types (`text/plain`,
  `application/x-www-form-urlencoded`, `multipart/form-data`) are refused on the
  JSON routes, so a form on another page cannot POST to them.
- **Agent-authored HTML is sandboxed.** The preview renders documents in a
  `sandbox`-attribute iframe with no `allow-scripts`; `<script>` in a saved
  document is dropped. Files served individually get
  `Content-Security-Policy: sandbox`.
- **Body size limits** on every route; the intake and jobs-list routes have
  their own larger caps for staged files.
- **Path safety.** Candidacy folder names are derived by `slugify`/`jobSlug`
  from the company and job id — the agent never supplies a raw path segment.
  Session ids are sanitised to `[a-zA-Z0-9._-]` before any path is built.

### Residual risks a deployer should know

- The loopback surface trusts any process that can bind a browser-shaped
  request to `127.0.0.1` with a matching `Origin`. On a shared machine, another
  local user could reach it. Run it as your own user on a machine you control.
- The MCP shell's preview URL carries the session id as a bearer-ish token in
  the query string; treat the URL as mildly sensitive (it is printed to stderr,
  not logged elsewhere).
- A job-post link is user-supplied and, in the DSH shell, read by a shell
  pipeline (`curl | perl`). That runs with the agent's shell permissions, the
  same as any other command it runs.

## Supported versions

Pre-1.0: only the latest published version (`main`) receives fixes.
