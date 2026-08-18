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
import { upsertCandidacy, listCandidacyFiles } from '../store/workspace.js'
import { saveIntakeFile, intakeDirFor, INTAKE_LIMIT } from '../store/intake.js'
import { normalizeProposal } from '../store/proposal.js'

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
          const version = await store.save(sessionId, { html: body.html, jobUrl: body.jobUrl })
          return sendJson(res, 200, { ok: true, version: version })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
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
          const version = await store.saveLetter(sessionId, { html: body.html })
          return sendJson(res, 200, { ok: true, version: version })
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
      docs: [['GET', 'the pickable saved versions (newest first, no bodies)']],
      handler: async function (req, res) {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = sanitizeSessionId(url.searchParams.get('session'))
        if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
        return sendJson(res, 200, { ok: true, versions: await store.history(sessionId) })
      },
    },
    {
      path: '/jobcv/restore',
      method: 'POST',
      docs: [['POST', 'roll the document back to an earlier saved version']],
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
        const version = await store.restore(sessionId, body.version)
        if (version === null) {
          return sendJson(res, 404, { error: 'version not found in history' })
        }
        return sendJson(res, 200, { ok: true, version: version })
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
  return [docRoutes, letterRoutes, workspaceRoutes, proposalRoutes, historyRoutes, skillRoutes]
}

export { defineJobCvRoutes }
