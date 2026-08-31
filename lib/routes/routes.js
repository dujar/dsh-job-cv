/**
 * The /jobcv/* HTTP surface.
 *
 * Every handler is thin: parse the request, call the application service
 * (lib/app/job-cv.js), serialize. The service owns validation, the
 * mid-turn-switch guard and the multi-step orchestrations, so the DSH
 * plugin and the MCP shell share one implementation of the workflow.
 *
 * Three routes stay handler-heavy because they are pure transport, not
 * workflow: `/jobcv/stream` (SSE), `/jobcv/file` (content-type + CSP) and
 * `/jobcv/intake` (a base64 upload body). They reach the store through
 * `app.store` / `app.resolveRoot`.
 *
 * The webServer allows ONE exact-route handler per path, so a route that
 * serves GET and POST is a single declaration whose handler dispatches on
 * req.method (the mount's method guard is omitted for it).
 */
import { defineRoutes } from './mount.js'
import { createJobCvApp } from '../app/job-cv.js'
import { sanitizeSessionId } from '../store/doc-store.js'
import { sendJson } from '../http/http-utils.js'
import { readCandidacyFile } from '../store/workspace.js'
import { saveIntakeFile, intakeDirFor, INTAKE_LIMIT } from '../store/intake.js'
import { readJobListFile, MAX_LIST_BYTES } from '../store/joblist.js'
import { basename } from 'node:path'
import { respond, sessionParam, readBody } from './respond.js'

/**
 * Body cap for a jobs-list upload: the markdown itself is capped at
 * MAX_LIST_BYTES, and base64 inflates it by a third, with slack for the
 * JSON envelope.
 */
const JOBLIST_BODY_LIMIT = MAX_LIST_BYTES + Math.ceil(MAX_LIST_BYTES / 3) + 64 * 1024

/**
 * MIME type for the file-serving route, so the browser opens rather than
 * downloads. Unknown extensions fall back to octet-stream (a download).
 */
function contentTypeFor(name) {
  const n = String(name).toLowerCase()
  if (n.endsWith('.html') || n.endsWith('.htm')) return 'text/html; charset=utf-8'
  if (n.endsWith('.css')) return 'text/css; charset=utf-8'
  if (n.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (n.endsWith('.json')) return 'application/json; charset=utf-8'
  if (n.endsWith('.txt') || n.endsWith('.md')) return 'text/plain; charset=utf-8'
  if (n.endsWith('.pdf')) return 'application/pdf'
  if (n.endsWith('.svg')) return 'image/svg+xml'
  if (n.endsWith('.png')) return 'image/png'
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg'
  if (n.endsWith('.gif')) return 'image/gif'
  if (n.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

const notAllowed = (res) => sendJson(res, 405, { error: 'method not allowed' })

function defineJobCvRoutes(deps) {
  // The MCP shell builds the app itself (it also calls it in-process) and
  // passes it in; the DSH plugin lets the routes build it from `deps`.
  const app = deps.app || createJobCvApp(deps)
  const store = app.store

  const docRoutes = defineRoutes('document', [
    {
      path: '/jobcv/doc',
      docs: [
        ['GET', 'the session current CV document (html, jobUrl, version)'],
        ['POST', 'replace the whole CV document and bump the version'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getDoc(sessionParam(req)))
        if (req.method === 'POST') {
          const { body } = await readBody(req, res)
          if (body === null) return
          return respond(res, () => app.saveCv(body.sessionId, body))
        }
        return notAllowed(res)
      },
    },
    {
      path: '/jobcv/stream',
      method: 'GET',
      docs: [['GET', 'server-sent stream of the document — a save pushes, no poll']],
      handler: async function (req, res) {
        const sessionId = sanitizeSessionId(sessionParam(req))
        if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        let closed = false
        function push() {
          if (closed) return
          store
            .get(sessionId)
            .then(function (doc) {
              if (!closed) res.write('data: ' + JSON.stringify(doc) + '\n\n')
            })
            .catch(function () {
              /* a failed read just skips this frame */
            })
        }
        push()
        const unsubscribe = store.subscribe(sessionId, push)
        const heartbeat = setInterval(function () {
          if (closed) return
          try {
            res.write(': ping\n\n')
          } catch (e) {
            finish()
          }
        }, 25000)
        function finish() {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          unsubscribe()
          try {
            res.end()
          } catch (e) {
            /* the socket is already gone */
          }
        }
        res.on('close', finish)
        req.on('close', finish)
      },
    },
  ])

  const letterRoutes = defineRoutes('letter', [
    {
      path: '/jobcv/letter',
      docs: [
        ['GET', 'the cover letter that complements the CV'],
        ['POST', 'replace the cover letter and bump its own version'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getLetter(sessionParam(req)))
        if (req.method === 'POST') {
          const { body } = await readBody(req, res)
          if (body === null) return
          return respond(res, () => app.saveLetter(body.sessionId, body))
        }
        return notAllowed(res)
      },
    },
  ])

  const masterRoutes = defineRoutes('master cv', [
    {
      path: '/jobcv/master',
      docs: [
        ['GET', 'the master CV — the source of truth every tailored application starts from'],
        ['POST', 'save the master CV (its own version line, like the cover letter)'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getMaster(sessionParam(req)))
        if (req.method === 'POST') {
          const { body } = await readBody(req, res)
          if (body === null) return
          return respond(res, () => app.saveMaster(body.sessionId, body))
        }
        return notAllowed(res)
      },
    },
    {
      path: '/jobcv/delta',
      method: 'GET',
      docs: [
        ['GET', 'what the active document changed against the master CV (normalized block diff)'],
      ],
      handler: (req, res) =>
        respond(res, () => {
          const kind = new URL(req.url, 'http://localhost').searchParams.get('kind')
          return app.getDelta(sessionParam(req), kind)
        }),
    },
    {
      path: '/jobcv/profile',
      docs: [
        ['GET', 'the candidate profile — standing facts every application would re-derive'],
        ['POST', 'save the candidate profile (plain markdown text)'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getProfile(sessionParam(req)))
        if (req.method === 'POST') {
          const { body } = await readBody(req, res)
          if (body === null) return
          return respond(res, () => app.saveProfile(body.sessionId, body))
        }
        return notAllowed(res)
      },
    },
  ])

  const postRoutes = defineRoutes('job post', [
    {
      path: '/jobcv/post',
      docs: [
        ['GET', 'the job post text the preview shows (falls back to the folder)'],
        ['POST', 'store the fetched (or pasted) post text for this candidacy'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getPost(sessionParam(req)))
        if (req.method === 'POST') {
          const { body } = await readBody(req, res)
          if (body === null) return
          return respond(res, () => app.setPost(body.sessionId, body))
        }
        return notAllowed(res)
      },
    },
  ])

  const briefRoutes = defineRoutes('post brief', [
    {
      path: '/jobcv/brief',
      docs: [
        ['GET', 'the candidate-facing breakdown of the posting'],
        ['POST', 'store the structured brief the agent builds'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getBrief(sessionParam(req)))
        if (req.method === 'POST') {
          const { body } = await readBody(req, res)
          if (body === null) return
          return respond(res, () => app.setBrief(body.sessionId, body))
        }
        return notAllowed(res)
      },
    },
  ])

  const fitRoutes = defineRoutes('fit', [
    {
      path: '/jobcv/fit',
      docs: [
        ['GET', 'the candidacy fit: the match score and what is missing'],
        ['POST', 'score this CV against this post, with the gaps to close'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getFit(sessionParam(req)))
        if (req.method === 'POST') {
          const { body } = await readBody(req, res)
          if (body === null) return
          return respond(res, () => app.setFit(body.sessionId, body))
        }
        return notAllowed(res)
      },
    },
  ])

  const workspaceRoutes = defineRoutes('candidacy', [
    {
      path: '/jobcv/workspace',
      docs: [
        ['GET', 'the session candidacy folder path and the files in it'],
        ['POST', 'upsert <root>/<company>/<job-id>/ for this candidacy'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getWorkspace(sessionParam(req)))
        if (req.method === 'POST') {
          const { body } = await readBody(req, res)
          if (body === null) return
          return respond(res, () => app.openWorkspace(body.sessionId, body))
        }
        return notAllowed(res)
      },
    },
    {
      path: '/jobcv/file',
      method: 'GET',
      docs: [['GET', 'serve one candidacy file, for opening it from the dock']],
      handler: async function (req, res) {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = sanitizeSessionId(url.searchParams.get('session'))
        if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
        const name = url.searchParams.get('name')
        if (typeof name !== 'string' || name === '') {
          return sendJson(res, 400, { error: 'missing ?name=' })
        }
        const doc = await store.get(sessionId)
        if (doc.workspace === '') {
          return sendJson(res, 404, { error: 'no workspace for this session' })
        }
        const body = await readCandidacyFile(doc.workspace, name)
        if (body === null) return sendJson(res, 404, { error: 'file not found' })
        const type = contentTypeFor(name)
        const headers = {
          'content-type': type,
          'content-length': body.length,
          'content-disposition':
            'inline; filename="' + basename(name).replace(/[^\w.\- ]+/g, '_') + '"',
          'cache-control': 'no-store',
        }
        // Agent-authored HTML would otherwise execute with the harness
        // origin; opening a file in its own tab must not be the way around
        // the preview's script stripping.
        if (type.indexOf('text/html') === 0) headers['content-security-policy'] = 'sandbox'
        res.writeHead(200, headers)
        res.end(body)
      },
    },
    {
      path: '/jobcv/intake',
      method: 'POST',
      docs: [['POST', 'stage a CV file dropped in the browser, return its path']],
      handler: async function (req, res) {
        // A dropped CV is a PDF or DOCX, not a 256KB JSON document.
        const { body } = await readBody(req, res, INTAKE_LIMIT)
        if (body === null) return
        const sessionId = sanitizeSessionId(body.sessionId)
        if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
        if (typeof body.dataBase64 !== 'string' || body.dataBase64 === '') {
          return sendJson(res, 400, { error: 'dataBase64 must be a non-empty string' })
        }
        try {
          const current = await store.get(sessionId)
          const dir = intakeDirFor(deps.intakeRoot, sessionId, current.workspace)
          const staged = await saveIntakeFile(dir, body.filename, body.dataBase64)
          return sendJson(res, 200, { ok: true, path: staged.path, bytes: staged.bytes })
        } catch (error) {
          return sendJson(res, 400, {
            error: String(error && error.message ? error.message : error),
          })
        }
      },
    },
  ])

  const proposalRoutes = defineRoutes('review', [
    {
      path: '/jobcv/proposal',
      docs: [
        ['GET', 'the change set awaiting the user decision'],
        ['POST', 'propose content changes instead of saving them'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getProposal(sessionParam(req)))
        if (req.method === 'POST') {
          const { body } = await readBody(req, res)
          if (body === null) return
          return respond(res, () => app.setProposal(body.sessionId, body))
        }
        return notAllowed(res)
      },
    },
    {
      path: '/jobcv/proposal/decision',
      method: 'POST',
      docs: [['POST', 'clear the pending proposal once the user has decided']],
      handler: async function (req, res) {
        const { body } = await readBody(req, res)
        if (body === null) return
        // The decision itself travels to the agent through the chat; the host
        // only retires the pending set so the panel closes for good.
        return respond(res, () => app.clearProposal(body.sessionId))
      },
    },
    {
      path: '/jobcv/request',
      docs: [
        ['GET', "the preview's pending asks — cover letter, re-score, a marked line…"],
        ['POST', 'raise one from the preview (the MCP shell has no composer)'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getRequests(sessionParam(req)))
        if (req.method === 'POST') {
          const { body } = await readBody(req, res)
          if (body === null) return
          return respond(res, () => app.addRequest(body.sessionId, body))
        }
        return notAllowed(res)
      },
    },
    {
      path: '/jobcv/request/resolve',
      method: 'POST',
      docs: [['POST', 'drop requests by id (all when ids omitted) — acted on, or dismissed']],
      handler: async function (req, res) {
        const { body } = await readBody(req, res)
        if (body === null) return
        return respond(res, () => app.resolveRequests(body.sessionId, body))
      },
    },
  ])

  const historyRoutes = defineRoutes('versions', [
    {
      path: '/jobcv/history',
      method: 'GET',
      docs: [
        ['GET', 'the pickable saved versions (newest first, no bodies)'],
        ['GET', '?version=N adds that one version body, for previewing it'],
        ['GET', '?kind=letter reads the cover letter timeline instead'],
        ['GET', '?kind=master reads the master CV timeline instead'],
      ],
      handler: (req, res) =>
        respond(res, () => {
          const url = new URL(req.url, 'http://localhost')
          return app.getHistory(sessionParam(req), {
            kind: url.searchParams.get('kind'),
            version: url.searchParams.get('version'),
          })
        }),
    },
    {
      path: '/jobcv/restore',
      method: 'POST',
      docs: [
        ['POST', 'roll the document back to an earlier saved version'],
        ['POST', '{"kind":"letter"} rolls the cover letter back instead'],
        ['POST', '{"kind":"master"} rolls the master CV back instead'],
      ],
      handler: async function (req, res) {
        const { body } = await readBody(req, res)
        if (body === null) return
        return respond(res, () => app.restore(body.sessionId, body))
      },
    },
  ])

  const recentsRoutes = defineRoutes('past applications', [
    {
      path: '/jobcv/cvs',
      method: 'GET',
      docs: [['GET', 'the latest CV of every past application, for the start form pick list']],
      handler: (req, res) => respond(res, () => app.getRecentCvs(sessionParam(req))),
    },
  ])

  const trackerRoutes = defineRoutes('tracker', [
    {
      path: '/jobcv/applications',
      method: 'GET',
      docs: [['GET', 'every application: latest CV/letter/post per candidacy, newest first']],
      handler: function (req, res) {
        // A listing needs a session like every other GET, even though the
        // roster itself is not session-scoped.
        if (sanitizeSessionId(sessionParam(req)) === null) {
          return sendJson(res, 400, { error: 'missing ?session=' })
        }
        return respond(res, () => app.getApplications())
      },
    },
    {
      path: '/jobcv/status',
      method: 'POST',
      docs: [
        ['POST', 'record where this application stands — applied, interview, rejected…'],
        ['POST', '{"status":"drafting"} clears the tag back to a draft'],
      ],
      handler: async function (req, res) {
        const { body } = await readBody(req, res)
        if (body === null) return
        return respond(res, () => app.setStatus(body.sessionId, body))
      },
    },
  ])

  const jobListRoutes = defineRoutes('job list', [
    {
      path: '/jobcv/joblist',
      docs: [
        ['GET', 'the session’s stored jobs pick list'],
        ['POST', 'parse a markdown jobs file into the pick list'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') return respond(res, () => app.getJobList(sessionParam(req)))
        if (req.method === 'POST') {
          // A dropped .md arrives as base64, not as a 256KB JSON document.
          const { body } = await readBody(req, res, JOBLIST_BODY_LIMIT)
          if (body === null) return
          const sessionId = sanitizeSessionId(body.sessionId)
          if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
          let text = typeof body.text === 'string' && body.text.trim() !== '' ? body.text : null
          let sourcePath = typeof body.path === 'string' ? body.path.trim() : ''
          if (text === null) {
            if (typeof body.dataBase64 === 'string' && body.dataBase64 !== '') {
              try {
                const current = await store.get(sessionId)
                const dir = intakeDirFor(deps.intakeRoot, sessionId, current.workspace)
                const staged = await saveIntakeFile(
                  dir,
                  body.filename || 'jobs.md',
                  body.dataBase64,
                )
                sourcePath = staged.path
              } catch (error) {
                return sendJson(res, 400, {
                  error: String(error && error.message ? error.message : error),
                })
              }
            }
            try {
              text = await readJobListFile(sourcePath, app.resolveRoot(body.sessionId))
            } catch (error) {
              return sendJson(res, 400, {
                error: String(error && error.message ? error.message : error),
              })
            }
          }
          return respond(res, () =>
            app.setJobListFromText(body.sessionId, {
              text,
              path: sourcePath,
              cvPath: body.cvPath,
            }),
          )
        }
        return notAllowed(res)
      },
    },
  ])

  const candidacyRoutes = defineRoutes('candidacies', [
    {
      path: '/jobcv/candidacies',
      method: 'GET',
      docs: [['GET', "this session's candidacies — the active one plus its archives"]],
      handler: (req, res) => respond(res, () => app.getCandidacies(sessionParam(req))),
    },
    {
      path: '/jobcv/switch',
      method: 'POST',
      docs: [
        ['POST', "make another job this session's active candidacy"],
        ['POST', 'archives the outgoing one with its whole history; answers resumed true/false'],
      ],
      handler: async function (req, res) {
        const { body } = await readBody(req, res)
        if (body === null) return
        return respond(res, () => app.switchCandidacy(body.sessionId, body))
      },
    },
  ])

  const skillRoutes = defineRoutes('contract', [
    {
      path: '/jobcv/skill',
      method: 'GET',
      docs: [['GET', 'the agent-facing Job mode CV contract (plain text)']],
      handler: function (req, res) {
        return deps.sendText(res, 200, app.getSkill())
      },
    },
  ])

  return [
    docRoutes,
    letterRoutes,
    masterRoutes,
    postRoutes,
    briefRoutes,
    fitRoutes,
    workspaceRoutes,
    proposalRoutes,
    historyRoutes,
    recentsRoutes,
    trackerRoutes,
    jobListRoutes,
    candidacyRoutes,
    skillRoutes,
  ]
}

export { defineJobCvRoutes }
