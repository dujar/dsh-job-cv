/**
 * The /jobcv/* HTTP surface: the session document (GET/POST /jobcv/doc)
 * and the agent-facing contract (GET /jobcv/skill).
 *
 * The webServer allows ONE exact-route handler per path, so /jobcv/doc is a
 * single declaration whose handler dispatches on req.method (the mount's
 * method guard is omitted for it — "omit method when the handler dispatches
 * itself").
 */
import { defineRoutes } from './mount.js'
import { sanitizeSessionId } from '../store/doc-store.js'
import { sendJson, readJsonBody } from '../http/http-utils.js'
import { upsertCandidacy, listCandidacyFiles, readCandidacyFile } from '../store/workspace.js'
import { saveIntakeFile, intakeDirFor, INTAKE_LIMIT } from '../store/intake.js'
import { normalizeProposal } from '../store/proposal.js'
import { normalizeFit } from '../store/fit.js'
import { normalizeBrief } from '../store/post-brief.js'
import { basename } from 'node:path'

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

function defineJobCvRoutes(deps) {
  const store = deps.store
  const docRoutes = defineRoutes('document', [
    {
      path: '/jobcv/doc',
      // method omitted: the handler dispatches GET vs POST itself
      docs: [
        ['GET', 'the session current CV document (html, jobUrl, version)'],
        ['POST', 'replace the whole CV document and bump the version'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = sanitizeSessionId(url.searchParams.get('session'))
          if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
          return sendJson(res, 200, await store.get(sessionId))
        }
        if (req.method === 'POST') {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: 'invalid body' })
          }
          const sessionId = sanitizeSessionId(body.sessionId)
          if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
          if (typeof body.html !== 'string' || body.html.trim() === '') {
            return sendJson(res, 400, { error: 'html must be a non-empty string' })
          }
          const version = await store.save(sessionId, {
            html: body.html,
            jobUrl: body.jobUrl,
            note: body.note,
          })
          return sendJson(res, 200, { ok: true, version: version })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      path: '/jobcv/stream',
      method: 'GET',
      docs: [['GET', 'server-sent stream of the document — a save pushes, no poll']],
      handler: async function (req, res) {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = sanitizeSessionId(url.searchParams.get('session'))
        if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
        // SSE: the response stays open and each change writes one `data:`
        // frame. The projection is the same one GET /jobcv/doc returns, so
        // the client applies it through the same comparison path.
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
              if (closed) return
              res.write('data: ' + JSON.stringify(doc) + '\n\n')
            })
            .catch(function () {
              /* a failed read just skips this frame */
            })
        }
        push()
        const unsubscribe = store.subscribe(sessionId, push)
        // Keep proxies from closing an idle stream: a comment line is a no-op
        // to the client but refreshes the connection.
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
  const workspaceRoutes = defineRoutes('candidacy', [
    {
      path: '/jobcv/workspace',
      // method omitted: the handler dispatches GET vs POST itself
      docs: [
        ['GET', 'the session candidacy folder path and the files in it'],
        ['POST', 'upsert <root>/<company>/<job-id>/ for this candidacy'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = sanitizeSessionId(url.searchParams.get('session'))
          if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
          const doc = await store.get(sessionId)
          if (doc.workspace === '') return sendJson(res, 200, { ok: true, path: '', files: [] })
          return sendJson(res, 200, {
            ok: true,
            path: doc.workspace,
            files: await listCandidacyFiles(doc.workspace),
            company: doc.company,
            jobTitle: doc.jobTitle,
          })
        }
        if (req.method === 'POST') {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: 'invalid body' })
          }
          const sessionId = sanitizeSessionId(body.sessionId)
          if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
          if (typeof body.company !== 'string' || body.company.trim() === '') {
            return sendJson(res, 400, { error: 'company must be a non-empty string' })
          }
          // Resolved per request from the RAW id: the session lookup wants the
          // client's spelling, while the store key is the sanitized one.
          const root = deps.resolveRoot(body.sessionId)
          const result = await upsertCandidacy(root, {
            company: body.company,
            jobId: body.jobId,
            jobUrl: body.jobUrl,
            jobTitle: body.jobTitle,
          })
          if (result === null) {
            return sendJson(res, 400, {
              error: 'company and job id/url yield no usable folder name',
            })
          }
          await store.setWorkspace(sessionId, result.path, body.jobUrl, body.company, body.jobTitle)
          return sendJson(res, 200, {
            ok: true,
            path: result.path,
            company: result.company,
            jobId: result.job,
            created: result.created,
          })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
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
        if (doc.workspace === '')
          return sendJson(res, 404, { error: 'no workspace for this session' })
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
        // origin; the preview strips scripts, and opening a file in its own
        // tab must not be the way around that.
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
        let body
        try {
          // A dropped CV is a PDF or DOCX, not a 256KB JSON document.
          body = await readJsonBody(req, INTAKE_LIMIT)
        } catch (error) {
          const tooBig = String(error && error.message) === 'body too large'
          return sendJson(res, tooBig ? 413 : 400, {
            error: tooBig ? 'file too large' : 'invalid body',
          })
        }
        const sessionId = sanitizeSessionId(body.sessionId)
        if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
        if (typeof body.dataBase64 !== 'string' || body.dataBase64 === '') {
          return sendJson(res, 400, { error: 'dataBase64 must be a non-empty string' })
        }
        let staged
        try {
          const current = await store.get(sessionId)
          const dir = intakeDirFor(deps.intakeRoot, sessionId, current.workspace)
          staged = await saveIntakeFile(dir, body.filename, body.dataBase64)
        } catch (error) {
          return sendJson(res, 400, {
            error: String(error && error.message ? error.message : error),
          })
        }
        return sendJson(res, 200, { ok: true, path: staged.path, bytes: staged.bytes })
      },
    },
  ])
  const letterRoutes = defineRoutes('letter', [
    {
      path: '/jobcv/letter',
      // method omitted: the handler dispatches GET vs POST itself
      docs: [
        ['GET', 'the cover letter that complements the CV'],
        ['POST', 'replace the cover letter and bump its own version'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = sanitizeSessionId(url.searchParams.get('session'))
          if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
          const doc = await store.get(sessionId)
          return sendJson(res, 200, { ok: true, letter: doc.letter })
        }
        if (req.method === 'POST') {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: 'invalid body' })
          }
          const sessionId = sanitizeSessionId(body.sessionId)
          if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
          if (typeof body.html !== 'string' || body.html.trim() === '') {
            return sendJson(res, 400, { error: 'html must be a non-empty string' })
          }
          const version = await store.saveLetter(sessionId, { html: body.html, note: body.note })
          return sendJson(res, 200, { ok: true, version: version })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      },
    },
  ])
  const postRoutes = defineRoutes('job post', [
    {
      path: '/jobcv/post',
      // method omitted: the handler dispatches GET vs POST itself
      docs: [
        ['GET', 'the job post text the preview shows (falls back to the folder)'],
        ['POST', 'store the fetched (or pasted) post text for this candidacy'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = sanitizeSessionId(url.searchParams.get('session'))
          if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
          const doc = await store.get(sessionId)
          const post = await store.getPost(sessionId)
          return sendJson(res, 200, {
            ok: true,
            text: post === null ? '' : post.text,
            source: post === null ? '' : post.source,
            updatedAt: post === null ? 0 : post.updatedAt,
            html: post === null ? '' : post.html,
            htmlUpdatedAt: post === null ? 0 : post.htmlUpdatedAt,
            jobUrl: doc.jobUrl,
            company: doc.company,
            jobTitle: doc.jobTitle,
          })
        }
        if (req.method === 'POST') {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: 'invalid body' })
          }
          const sessionId = sanitizeSessionId(body.sessionId)
          if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
          if (typeof body.text !== 'string' || body.text.trim() === '') {
            return sendJson(res, 400, { error: 'text must be a non-empty string' })
          }
          const post = await store.setPost(sessionId, body.text, body.source, body.html)
          return sendJson(res, 200, {
            ok: true,
            chars: post === null ? 0 : post.text.length,
            source: post === null ? '' : post.source,
          })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      },
    },
  ])
  const briefRoutes = defineRoutes('post brief', [
    {
      path: '/jobcv/brief',
      // method omitted: the handler dispatches GET vs POST itself
      docs: [
        ['GET', 'the candidate-facing breakdown of the posting'],
        ['POST', 'store the structured brief the agent builds'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = sanitizeSessionId(url.searchParams.get('session'))
          if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
          return sendJson(res, 200, { ok: true, brief: await store.getBrief(sessionId) })
        }
        if (req.method === 'POST') {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: 'invalid body' })
          }
          const sessionId = sanitizeSessionId(body.sessionId)
          if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
          const brief = normalizeBrief(body)
          if (brief === null) {
            return sendJson(res, 400, {
              error: 'a brief needs at least one section or one meta fact',
            })
          }
          await store.setBrief(sessionId, brief)
          return sendJson(res, 200, { ok: true, sections: brief.sections.length })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      },
    },
  ])
  const fitRoutes = defineRoutes('fit', [
    {
      path: '/jobcv/fit',
      // method omitted: the handler dispatches GET vs POST itself
      docs: [
        ['GET', 'the candidacy fit: the match score and what is missing'],
        ['POST', 'score this CV against this post, with the gaps to close'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = sanitizeSessionId(url.searchParams.get('session'))
          if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
          const doc = await store.get(sessionId)
          return sendJson(res, 200, { ok: true, fit: doc.fit })
        }
        if (req.method === 'POST') {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: 'invalid body' })
          }
          const sessionId = sanitizeSessionId(body.sessionId)
          if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
          const current = await store.get(sessionId)
          const fit = normalizeFit(
            body,
            current.version,
            current.letter === null ? 0 : current.letter.version,
          )
          if (fit === null) {
            return sendJson(res, 400, { error: 'a fit needs a numeric score between 0 and 100' })
          }
          await store.setFit(sessionId, fit)
          return sendJson(res, 200, { ok: true, score: fit.score, gaps: fit.gaps.length })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      },
    },
  ])
  const proposalRoutes = defineRoutes('review', [
    {
      path: '/jobcv/proposal',
      // method omitted: the handler dispatches GET vs POST itself
      docs: [
        ['GET', 'the change set awaiting the user decision'],
        ['POST', 'propose content changes instead of saving them'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = sanitizeSessionId(url.searchParams.get('session'))
          if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
          const doc = await store.get(sessionId)
          return sendJson(res, 200, { ok: true, proposal: doc.proposal })
        }
        if (req.method === 'POST') {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: 'invalid body' })
          }
          const sessionId = sanitizeSessionId(body.sessionId)
          if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
          const current = await store.get(sessionId)
          const proposal = normalizeProposal(body, current.version)
          if (proposal === null) {
            return sendJson(res, 400, {
              error: 'a proposal needs at least one change carrying at least one option',
            })
          }
          await store.setProposal(sessionId, proposal)
          return sendJson(res, 200, {
            ok: true,
            proposalId: proposal.id,
            changes: proposal.changes.length,
          })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      path: '/jobcv/proposal/decision',
      method: 'POST',
      docs: [['POST', 'clear the pending proposal once the user has decided']],
      handler: async function (req, res) {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return sendJson(res, 400, { error: 'invalid body' })
        }
        const sessionId = sanitizeSessionId(body.sessionId)
        if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
        // The decision itself travels to the agent through the chat; the host
        // only retires the pending set so the panel closes for good.
        await store.setProposal(sessionId, null)
        return sendJson(res, 200, { ok: true })
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
      ],
      handler: async function (req, res) {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = sanitizeSessionId(url.searchParams.get('session'))
        if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
        // Two documents, two timelines. Anything but 'letter' means the CV,
        // so an older client that never sends ?kind keeps working.
        const kind = url.searchParams.get('kind') === 'letter' ? 'letter' : 'cv'
        const wanted = url.searchParams.get('version')
        if (wanted !== null) {
          const version = Number(wanted)
          if (!Number.isInteger(version) || version < 1) {
            return sendJson(res, 400, { error: 'version must be a positive integer' })
          }
          const html = await store.versionHtml(sessionId, version, kind)
          if (html === null) return sendJson(res, 404, { error: 'version not found in history' })
          return sendJson(res, 200, { ok: true, kind: kind, version: version, html: html })
        }
        return sendJson(res, 200, {
          ok: true,
          kind: kind,
          versions: await store.history(sessionId, kind),
        })
      },
    },
    {
      path: '/jobcv/restore',
      method: 'POST',
      docs: [
        ['POST', 'roll the document back to an earlier saved version'],
        ['POST', '{"kind":"letter"} rolls the cover letter back instead'],
      ],
      handler: async function (req, res) {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return sendJson(res, 400, { error: 'invalid body' })
        }
        const sessionId = sanitizeSessionId(body.sessionId)
        if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
        if (!Number.isInteger(body.version) || body.version < 1) {
          return sendJson(res, 400, { error: 'version must be a positive integer' })
        }
        const kind = body.kind === 'letter' ? 'letter' : 'cv'
        const version =
          kind === 'letter'
            ? await store.restoreLetter(sessionId, body.version)
            : await store.restore(sessionId, body.version)
        if (version === null) {
          return sendJson(res, 404, { error: 'version not found in history' })
        }
        return sendJson(res, 200, { ok: true, kind: kind, version: version })
      },
    },
  ])
  const skillRoutes = defineRoutes('contract', [
    {
      path: '/jobcv/skill',
      method: 'GET',
      docs: [['GET', 'the agent-facing Job mode CV contract (plain text)']],
      handler: async function (req, res) {
        return deps.sendText(res, 200, deps.skillText)
      },
    },
  ])
  return [
    docRoutes,
    letterRoutes,
    postRoutes,
    briefRoutes,
    fitRoutes,
    workspaceRoutes,
    proposalRoutes,
    historyRoutes,
    skillRoutes,
  ]
}

export { defineJobCvRoutes }
