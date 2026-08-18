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
  return [docRoutes, skillRoutes]
}

export { defineJobCvRoutes }
