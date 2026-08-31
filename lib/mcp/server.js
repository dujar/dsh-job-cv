/**
 * A minimal Model Context Protocol server for the job-CV workflow.
 *
 * stdio transport, newline-delimited JSON-RPC 2.0 — no SDK, matching this
 * package's zero-runtime-dependency rule. Each tool calls the shared
 * application service (lib/app/job-cv.js) in-process — the SAME instance the
 * preview page's routes use, so a tool call and the browser see one state.
 *
 * The session id is the server's, minted once and injected into every call —
 * the client never sees it, never copies it, never gets it wrong.
 */
import { readJobListFile } from '../store/joblist.js'

const PROTOCOL_FALLBACK = '2024-11-05'
const SERVER_INFO = { name: 'dsh-job-cv', version: '0.1.0' }

function log(...args) {
  process.stderr.write('[dsh-job-cv-mcp] ' + args.join(' ') + '\n')
}

/* ─────────────────────────── tool catalogue ──────────────────────────── */

const S = {
  html: {
    type: 'string',
    description:
      'One complete self-contained HTML document (doctype…body), A4-paginated, inline CSS only, no scripts.',
  },
  note: {
    type: 'string',
    description:
      'One short timeline label for the version history — written for someone choosing which version to roll back to.',
  },
  jobUrl: {
    type: 'string',
    description:
      'The job post link this save is for. Binds the save to a posting so a mid-turn job switch cannot misfile it.',
  },
}

/**
 * Each tool: a JSON schema for the client, and `run(ctx, args)` where
 * `ctx = { app, sid, ui }` — `app` is the shared service, `sid` the server's
 * session id, `ui` the preview server (for its URL).
 */
const TOOLS = [
  {
    name: 'jobcv_context',
    description:
      'Where the workspace stands: the preview URL to give the user, the active candidacy (company, title, job link, CV version), the current fit score, any pending change proposal, and the tracked applications. Call this first.',
    schema: { type: 'object', properties: {} },
    async run({ app, sid, ui }) {
      const doc = await app.getDoc(sid)
      const apps = await app.getApplications()
      const requests = doc.requests || []
      return {
        previewUrl: ui.url,
        note: 'Open previewUrl in a browser to watch the CV, letter, job post and fit score update live.',
        pendingRequests:
          requests.length === 0
            ? []
            : requests.map((r) => ({
                id: r.id,
                kind: r.kind,
                summary: r.summary,
                detail: r.detail,
              })),
        pendingRequestsNote:
          requests.length === 0
            ? undefined
            : 'The user raised these from the preview. Act on each, then call jobcv_resolve_requests with their ids.',
        active: {
          company: doc.company || '',
          jobTitle: doc.jobTitle || '',
          jobUrl: doc.jobUrl || '',
          workspace: doc.workspace || '',
          cvVersion: doc.version || 0,
          letterVersion: doc.letter ? doc.letter.version : 0,
          masterVersion: doc.masterVersion || 0,
          fitScore: doc.fit ? doc.fit.score : null,
          status: doc.status || 'drafting',
          pendingProposal: doc.proposal ? doc.proposal.id : null,
        },
        applications: (apps.applications || []).map((a) => ({
          company: a.company,
          jobTitle: a.jobTitle,
          cvVersion: a.cvVersion,
          fitScore: a.fitScore,
          status: a.application ? a.application.status : 'drafting',
        })),
      }
    },
  },
  {
    name: 'jobcv_open',
    description:
      'Open or resume a candidacy for a job posting. Switches the active job, then upserts its workspace folder. Returns { path, created, resumed } — created:false or resumed:true means read what is already in the folder before rewriting. Fetch the post text and call jobcv_set_post next.',
    schema: {
      type: 'object',
      required: ['jobUrl', 'company'],
      properties: {
        jobUrl: { type: 'string', description: 'The job post link — the candidacy identity.' },
        company: {
          type: 'string',
          description: 'Company name, as it should read in the folder path and the dock.',
        },
        jobTitle: { type: 'string', description: 'The role title, for the dock label.' },
        jobId: { type: 'string', description: 'The board’s own job id, when the post shows one.' },
      },
    },
    async run({ app, sid }, args) {
      const switched = await app.switchCandidacy(sid, {
        jobUrl: args.jobUrl,
        company: args.company,
        jobTitle: args.jobTitle,
      })
      const workspace = await app.openWorkspace(sid, {
        company: args.company,
        jobUrl: args.jobUrl,
        jobTitle: args.jobTitle,
        jobId: args.jobId,
      })
      return {
        switched,
        workspace,
        next: 'Read the post with your client’s fetch/web tool, then jobcv_set_post. Then jobcv_score early — the gap list is the plan.',
      }
    },
  },
  {
    name: 'jobcv_get',
    description: 'Read one part of the workspace verbatim.',
    schema: {
      type: 'object',
      required: ['what'],
      properties: {
        what: {
          type: 'string',
          enum: [
            'cv',
            'letter',
            'post',
            'brief',
            'master',
            'profile',
            'fit',
            'workspace',
            'delta',
            'history',
            'applications',
            'candidacies',
            'joblist',
            'requests',
            'skill',
          ],
          description: 'Which document or list to return.',
        },
        version: {
          type: 'integer',
          description: 'For what:"history" — return this one version’s HTML.',
        },
        kind: {
          type: 'string',
          enum: ['cv', 'letter', 'master'],
          description: 'For what:"history"/"delta" — which timeline.',
        },
      },
    },
    async run({ app, sid }, args) {
      switch (args.what) {
        case 'cv':
          return app.getDoc(sid)
        case 'letter':
          return app.getLetter(sid)
        case 'post':
          return app.getPost(sid)
        case 'brief':
          return app.getBrief(sid)
        case 'master':
          return app.getMaster(sid)
        case 'profile':
          return app.getProfile(sid)
        case 'fit':
          return app.getFit(sid)
        case 'workspace':
          return app.getWorkspace(sid)
        case 'delta':
          return app.getDelta(sid, args.kind)
        case 'history':
          return app.getHistory(sid, { kind: args.kind, version: args.version })
        case 'applications':
          return app.getApplications()
        case 'candidacies':
          return app.getCandidacies(sid)
        case 'joblist':
          return app.getJobList(sid)
        case 'requests':
          return app.getRequests(sid)
        case 'skill':
          return { skill: app.getSkill() }
        default:
          throw new Error('unknown "what": ' + args.what)
      }
    },
  },
  {
    name: 'jobcv_save_cv',
    description:
      'Replace the whole CV document and bump its version. Formatting changes save directly; WORDING changes must go through jobcv_propose first and be approved by the user.',
    schema: {
      type: 'object',
      required: ['html', 'note'],
      properties: { html: S.html, note: S.note, jobUrl: S.jobUrl },
    },
    run: ({ app, sid }, args) => app.saveCv(sid, args),
  },
  {
    name: 'jobcv_save_letter',
    description:
      'Replace the cover letter (its own version line — never saved through the CV route).',
    schema: {
      type: 'object',
      required: ['html', 'note'],
      properties: { html: S.html, note: S.note, jobUrl: S.jobUrl },
    },
    run: ({ app, sid }, args) => app.saveLetter(sid, args),
  },
  {
    name: 'jobcv_save_master',
    description:
      'Save the master CV — the source of truth every application is tailored from. Only save what the user agreed to fold back, verbatim.',
    schema: {
      type: 'object',
      required: ['html', 'note'],
      properties: { html: S.html, note: S.note },
    },
    run: ({ app, sid }, args) => app.saveMaster(sid, args),
  },
  {
    name: 'jobcv_save_profile',
    description:
      'Save the candidate profile — the standing facts every application would otherwise re-derive (years of experience, what the candidate will and will not claim, confidentiality constraints, the "why I left" stories that belong in an interview). Plain markdown. Save only what the user has confirmed, verbatim.',
    schema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'The full profile, markdown. "" clears it.' },
      },
    },
    run: ({ app, sid }, args) => app.saveProfile(sid, args),
  },
  {
    name: 'jobcv_set_post',
    description:
      'Store the job post text the preview shows (and optionally a styled A4 HTML page of it with <mark class="dsh-gap" data-dsh-gap="blocker|major|minor"> around unmet requirements). Store the READABLE extraction, not raw page HTML.',
    schema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'The readable job post text.' },
        source: {
          type: 'string',
          enum: ['agent', 'you'],
          description: '"agent" when you fetched it, "you" when the user pasted it.',
        },
        html: {
          type: 'string',
          description:
            'Optional: the posting rendered as one self-contained A4 HTML page with gap marks.',
        },
        jobUrl: S.jobUrl,
      },
    },
    run: ({ app, sid }, args) => app.setPost(sid, args),
  },
  {
    name: 'jobcv_set_brief',
    description:
      'Store the candidate-facing breakdown of the posting: sections (About the company / The team / The job / Requirements / Expectations), each with a source, plus verifiable meta facts.',
    schema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'body'],
            properties: {
              title: { type: 'string' },
              body: { type: 'string' },
              source: {
                type: 'string',
                description: 'posting | company site | LinkedIn | estimate',
              },
            },
          },
        },
        meta: {
          type: 'array',
          items: {
            type: 'object',
            required: ['label', 'value'],
            properties: { label: { type: 'string' }, value: { type: 'string' } },
          },
        },
        jobUrl: S.jobUrl,
      },
    },
    run: ({ app, sid }, args) => app.setBrief(sid, args),
  },
  {
    name: 'jobcv_score',
    description:
      'Score the CV against the post: a 0–100 alignment estimate, a one-line verdict, the gaps (each with severity, why it matters, and the concrete move that closes it — a missing fact is a QUESTION, not an invention), and the strengths with the CV line that evidences each. Score early and re-score after a save that closed a gap.',
    schema: {
      type: 'object',
      required: ['score'],
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        verdict: { type: 'string', description: 'One line — what decides this application.' },
        gaps: {
          type: 'array',
          items: {
            type: 'object',
            required: ['requirement'],
            properties: {
              requirement: { type: 'string', description: 'What the post asks for, in its words.' },
              severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
              why: { type: 'string', description: 'What the screen or the manager does with it.' },
              fix: { type: 'string', description: 'The move that closes it today.' },
            },
          },
        },
        strengths: {
          type: 'array',
          items: {
            type: 'object',
            required: ['requirement'],
            properties: {
              requirement: { type: 'string' },
              evidence: { type: 'string', description: 'The line in the CV that answers it.' },
            },
          },
        },
        jobUrl: S.jobUrl,
      },
    },
    run: ({ app, sid }, args) => app.setFit(sid, args),
  },
  {
    name: 'jobcv_propose',
    description:
      'Propose WORDING changes instead of saving them — the user accepts, swaps, rewrites or skips each one in the preview. Give 2–3 genuinely different options per change. Put every part one change implicates in the SAME proposal.',
    schema: {
      type: 'object',
      required: ['summary', 'changes'],
      properties: {
        summary: { type: 'string', description: 'Why, in one line.' },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['section', 'current', 'options'],
            properties: {
              id: { type: 'string' },
              section: { type: 'string' },
              path: {
                type: 'string',
                description: 'The CSS-ish path from a marked-up request, when there was one.',
              },
              current: { type: 'string', description: 'The exact text today.' },
              why: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['label', 'text'],
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    text: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        jobUrl: S.jobUrl,
      },
    },
    async run({ app, sid }, args) {
      const result = await app.setProposal(sid, args)
      return {
        ...result,
        next: 'The user decides in the preview. Poll jobcv_get what:"cv" — proposal goes null once they have decided; apply exactly their choice, then jobcv_save_cv.',
      }
    },
  },
  {
    name: 'jobcv_switch',
    description:
      'Make another posting the active candidacy. resumed:true means its earlier work in this session came back — continue it.',
    schema: {
      type: 'object',
      required: ['jobUrl'],
      properties: {
        jobUrl: { type: 'string' },
        company: { type: 'string' },
        jobTitle: { type: 'string' },
      },
    },
    run: ({ app, sid }, args) => app.switchCandidacy(sid, args),
  },
  {
    name: 'jobcv_set_status',
    description:
      'Record where this application stands — drafting | applied | interview | offer | rejected. ONLY from something the user actually told you, never from a guess or because a save landed.',
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['drafting', 'applied', 'interview', 'offer', 'rejected'] },
        note: {
          type: 'string',
          description: 'One short line beside the tag — a date, a contact, what happens next.',
        },
      },
    },
    run: ({ app, sid }, args) => app.setStatus(sid, args),
  },
  {
    name: 'jobcv_restore',
    description:
      'Roll a document back to an earlier saved version. The restore is itself a new version — nothing is lost.',
    schema: {
      type: 'object',
      required: ['version'],
      properties: {
        version: { type: 'integer', minimum: 1 },
        kind: { type: 'string', enum: ['cv', 'letter', 'master'] },
      },
    },
    run: ({ app, sid }, args) => app.restore(sid, args),
  },
  {
    name: 'jobcv_resolve_requests',
    description:
      'Clear preview requests you have acted on (from jobcv_context.pendingRequests). Pass their ids; omit ids to clear all.',
    schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
    },
    run: ({ app, sid }, args) => app.resolveRequests(sid, args),
  },
  {
    name: 'jobcv_load_joblist',
    description:
      'Parse a markdown file of postings ("- [Title](https://…)" lines, a "## Company" heading sets the employer) into the session pick list. Returns the deduped jobs — score each against the master with jobcv_open + jobcv_score, skipping the irrelevant ones.',
    schema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', description: 'Absolute path to the markdown file.' } },
    },
    async run({ app, sid, ui }, args) {
      const text = await readJobListFile(args.path, ui.applicationsRoot)
      return app.setJobListFromText(sid, { text, path: args.path })
    },
  },
]

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

const INSTRUCTIONS = [
  'Job mode — candidate-side CV tailoring against a specific job post.',
  '',
  'You work for the candidate, never the employer. Never invent experience,',
  'metrics, employers, dates or credentials — reframe and re-emphasize what is',
  'really there. A missing number is a QUESTION for the user, not something to',
  'write. Wording changes are the user’s call: propose them (jobcv_propose) and',
  'apply exactly what they choose; formatting saves directly.',
  '',
  'Start with jobcv_context, then jobcv_open for the posting, fetch and',
  'jobcv_set_post the readable post text, jobcv_score early (the gaps are the',
  'plan), then tailor the CV as ONE self-contained A4 HTML document and',
  'jobcv_save_cv. Tell the user to open the previewUrl to watch it render.',
  '',
  'jobcv_context.pendingRequests are things the user clicked in the preview',
  '(ask for a cover letter, close a gap, a line marked on the CV). Check it at',
  'the start of a turn, act on each, then jobcv_resolve_requests their ids.',
  '',
  'The full contract is the "jobcv://skill" resource — read it before the',
  'first save.',
].join('\n')

/* ─────────────────────────── JSON-RPC plumbing ───────────────────────── */

export function startMcpServer(options) {
  const ui = options.ui
  const app = ui.app
  const sid = ui.sessionId
  const stdin = options.stdin || process.stdin
  const stdout = options.stdout || process.stdout
  // The real shell exits the process when the client hangs up; a test passes
  // its own so the harness stays alive.
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => process.exit(0)

  function send(msg) {
    stdout.write(JSON.stringify(msg) + '\n')
  }
  function reply(id, result) {
    send({ jsonrpc: '2.0', id, result })
  }
  function fail(id, code, message, data) {
    send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })
  }

  async function handle(msg) {
    const { id, method, params } = msg
    const isNotification = id === undefined || id === null

    if (method === 'initialize') {
      const wanted = params && params.protocolVersion
      return reply(id, {
        protocolVersion: typeof wanted === 'string' ? wanted : PROTOCOL_FALLBACK,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      })
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
    if (method === 'ping') return reply(id, {})

    if (method === 'tools/list') {
      return reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.schema,
        })),
      })
    }
    if (method === 'tools/call') {
      const name = params && params.name
      const tool = TOOL_BY_NAME.get(name)
      if (!tool) return fail(id, -32602, 'unknown tool: ' + name)
      try {
        const out = await tool.run({ app, sid, ui }, (params && params.arguments) || {})
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
      } catch (error) {
        return reply(id, {
          content: [
            {
              type: 'text',
              text: 'tool failed: ' + String(error && error.message ? error.message : error),
            },
          ],
          isError: true,
        })
      }
    }

    if (method === 'resources/list') {
      return reply(id, {
        resources: [
          {
            uri: 'jobcv://skill',
            name: 'Job mode contract',
            description: 'The full CV-tailoring contract — read before the first save.',
            mimeType: 'text/plain',
          },
          {
            uri: 'jobcv://profile',
            name: 'Candidate profile',
            description: 'The standing facts about the candidate — read before the first question.',
            mimeType: 'text/markdown',
          },
          {
            uri: 'jobcv://context',
            name: 'Workspace context',
            description: 'Live snapshot of the active candidacy.',
            mimeType: 'application/json',
          },
        ],
      })
    }
    if (method === 'resources/read') {
      const uri = params && params.uri
      if (uri === 'jobcv://skill') {
        return reply(id, { contents: [{ uri, mimeType: 'text/plain', text: app.getSkill() }] })
      }
      if (uri === 'jobcv://profile') {
        const p = await app.getProfile(sid)
        return reply(id, { contents: [{ uri, mimeType: 'text/markdown', text: p.text || '' }] })
      }
      if (uri === 'jobcv://context') {
        const out = await TOOL_BY_NAME.get('jobcv_context').run({ app, sid, ui }, {})
        return reply(id, {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(out, null, 2) }],
        })
      }
      return fail(id, -32602, 'unknown resource: ' + uri)
    }

    if (method === 'prompts/list') return reply(id, { prompts: [] })

    if (!isNotification) return fail(id, -32601, 'method not found: ' + method)
  }

  let buffer = ''
  let inFlight = 0
  let ended = false
  function maybeShutDown() {
    if (!ended || inFlight > 0) return
    log('stdin closed — shutting down')
    if (ui && typeof ui.close === 'function') ui.close().finally(onClose)
    else onClose()
  }
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line === '') continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        log('dropped a non-JSON line')
        continue
      }
      inFlight++
      Promise.resolve(handle(msg))
        .catch((error) => {
          log('handler error:', String(error && error.message ? error.message : error))
          if (msg && msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, 'internal error')
        })
        .finally(() => {
          inFlight--
          maybeShutDown()
        })
    }
  })
  stdin.on('end', () => {
    ended = true
    setTimeout(() => {
      inFlight = 0
      maybeShutDown()
    }, 2000).unref()
    maybeShutDown()
  })

  log('ready — preview at ' + ui.url + ' (session ' + sid + ')')
}
