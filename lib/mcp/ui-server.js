/**
 * The MCP shell's own preview server.
 *
 * The DSH plugin renders the CV/letter/post/fit preview inside the harness
 * web GUI. The MCP shell has no harness to live in, so it stands up the same
 * `/jobcv/*` surface on a plain Node http.Server plus one self-contained
 * preview page at `/` — the page the user watches while an MCP client drives
 * the tools.
 *
 * The route handlers are the EXACT ones the plugin mounts
 * (`defineJobCvRoutes`), wrapped in the EXACT shared guards (`guardHandler`).
 * Nothing about the document contract forks between the two shells: only the
 * thing the routes are bolted onto changes.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createDocStore } from '../store/doc-store.js'
import { candidacyRoot } from '../store/workspace.js'
import { defineJobCvRoutes } from '../routes/routes.js'
import { guardHandler } from '../routes/mount.js'
import { skillInstructions, dshHome } from '../preset/preset-seed.js'
import { isTrustedRequest, readJsonBody, sendJson, sendText } from '../http/http-utils.js'

const UI_PAGE = fileURLToPath(new URL('./ui.html', import.meta.url))

/**
 * Build the flat { path -> guarded handler } table from the route groups.
 * The plugin registers each entry on `ctx.webServer`; here they go into a
 * Map the http.Server dispatches on, but through the same guard wrapper so
 * the trust check, the method guard and the error envelope are identical.
 */
function buildRouteTable(store, resolveRoot) {
  const groups = defineJobCvRoutes({
    store,
    resolveRoot,
    intakeRoot: join(dshHome(), 'dsh-job-cv', 'intake'),
    skillText: skillInstructions(),
    sendText,
  })
  const deps = { isTrusted: isTrustedRequest, readJsonBody, sendJson }
  const table = new Map()
  for (const { entries } of groups) {
    for (const entry of entries) table.set(entry.path, guardHandler(entry, deps))
  }
  return table
}

/**
 * Start the preview server.
 *
 * @param {object} options
 * @param {string} options.sessionId  the MCP shell's stable session id
 * @param {string} [options.applicationsRoot]  where candidacy folders go
 * @param {number} [options.port]  0 (default) lets the OS choose
 * @param {string} [options.host]  '127.0.0.1' by default
 * @returns {Promise<{url, port, sessionId, store, close}>}
 */
export async function startUiServer(options) {
  const opts = options || {}
  const sessionId = String(opts.sessionId || '').trim()
  if (sessionId === '') throw new Error('startUiServer needs a sessionId')

  const home = dshHome()
  const store = createDocStore(join(home, 'dsh-job-cv'))
  const root =
    typeof opts.applicationsRoot === 'string' && opts.applicationsRoot.trim() !== ''
      ? opts.applicationsRoot.trim()
      : candidacyRoot({ dshHome: home })
  const resolveRoot = () => root

  const routes = buildRouteTable(store, resolveRoot)
  const host = typeof opts.host === 'string' && opts.host !== '' ? opts.host : '127.0.0.1'

  let pageHtml = await readFile(UI_PAGE, 'utf8')
  // The page needs exactly one thing from the server: which session to read.
  // Injected here so the browser never has to be told a UUID by hand — the
  // failure mode the DSH contract spends a screen of text defending against.
  pageHtml = pageHtml.replace('__JOBCV_SESSION__', JSON.stringify(sessionId))

  const server = createServer((req, res) => {
    let pathname
    try {
      pathname = new URL(req.url, 'http://localhost').pathname
    } catch {
      return sendJson(res, 400, { error: 'bad url' })
    }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      return res.end(pageHtml)
    }
    const handler = routes.get(pathname)
    if (handler) return handler(req, res)
    return sendJson(res, 404, { error: 'not found' })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port || 0, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const port = server.address().port
  return {
    url: 'http://' + host + ':' + port + '/',
    port,
    sessionId,
    store,
    applicationsRoot: root,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}
