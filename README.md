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
  - `GET /jobcv/skill` — the agent-facing contract (A4, self-contained,
    truthful tailoring)
- **Client half** (`lib/client.js`, built from `lib/client/` fragments)
  registers into `conversation.input.dock`. When the session preset is
  `job` the dock shows a **Show preview / Hide preview** button that opens
  the CV in one of two shapes:
  - _split_ (viewport ≥ 900px) — the conversation column is squeezed to a
    460px chat sidebar and the CV pane is portalled into the freed main
    area. The self-healing DOM transform follows the same proven pattern
    as dsh-trader's chart host.
  - _overlay_ — below 900px, or via **Full screen** on a wide viewport,
    the CV fills the window. `Esc` returns.

  The pane polls the document every 2.5s, so every agent save appears
  live and is announced ("v4 · just updated"); a host that stops
  answering is reported rather than silently freezing the preview.

### Commenting on a part of the CV

**Comment on a part** in the preview toolbar turns the CV into a pick
surface: hover highlights the line under the cursor, clicking it quotes
that text into a comment box, and preset chips ("Quantify with real
numbers", "Shorten this", …) fill in the common asks. Notes queue up, so
one round of review becomes **one** chat message rather than one message
per fix — each send costs the agent a full turn and a document rewrite.

The message names the section, a CSS-ish path and the exact current text
for every note, and closes by asking the agent to save the revision _and_
answer with judgement: whether each edit really strengthens the CV for
this job post, and which requests would overstate what the CV supports.
`GET /jobcv/skill` documents that format on the agent side.

The preview iframe never gets `allow-scripts` — picking works because the
frame is same-origin, so the _parent_ attaches the listeners and paints
the highlights. Highlight CSS is injected under `@media screen`, so it
can never appear in the exported PDF.

## Workflow

1. Start a new session in **Job mode** (preset chip / Settings roster).
2. Paste the job post link and your current CV into the chat.
3. The agent fetches the post, tailors the CV, and saves it through
   `POST /jobcv/doc` — the preview updates within seconds. The save must
   carry `Content-Type: application/json`; the `/jobcv/skill` contract
   spells the call out, because the trust gate rejects the content type
   `curl -d` would otherwise pick.
4. Iterate by chatting ("make the summary sharper", "cut to one page").
5. **Export PDF** on the preview toolbar.

## Development

- Edit the browser half in `lib/client/*.js`, then `npm run build:client`
  (`lib/client.js` is generated and stays committed).
- `npm test` verifies the built bundle matches its fragments and runs the
  host-half tests.
- Documents persist per session under `$DSH_HOME/dsh-job-cv/sessions/`
  with the last 10 versions kept in history — the groundwork for a fuller
  job workspace (rollback, multiple documents per job application).
  Saves are serialized per session and written temp-file-then-rename, and
  a document file that cannot be parsed raises instead of quietly reading
  as a new session (which would let the next save overwrite it).

MIT
