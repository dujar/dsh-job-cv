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
import { isValidStatus, DEFAULT_STATUS } from '../store/applications.js'
import {
  parseJobList,
  readJobListFile,
  urlMatchKey as matchKeyOf,
  MAX_LIST_BYTES,
} from '../store/joblist.js'
import { basename } from 'node:path'

/**
 * Body cap for a jobs-list upload: the markdown itself is capped at
 * MAX_LIST_BYTES, and base64 inflates it by a third, with slack for the
 * JSON envelope.
 */
const JOBLIST_BODY_LIMIT = MAX_LIST_BYTES + Math.ceil(MAX_LIST_BYTES / 3) + 64 * 1024

/**
 * Mid-turn switch guard. A save that NAMES its posting (body.jobUrl) is
 * refused when that is no longer this session's active one: the user
 * switched while the agent was working, and without this check the save
 * would land its carefully tailored CV on whichever candidacy happens to be
 * on screen now. Saves without a jobUrl behave exactly as before, so older
 * callers and quick scripts keep working.
 *
 * Returns true to proceed; otherwise a 409 has already been written.
 */
async function assertActiveJob(store, res, sessionId, claimedJobUrl) {
  if (typeof claimedJobUrl !== 'string' || claimedJobUrl.trim() === '') return true
  const doc = await store.get(sessionId)
  if (matchKeyOf(doc.jobUrl || '') === matchKeyOf(claimedJobUrl)) return true
  sendJson(res, 409, {
    error:
      'stale save: the active candidacy changed under you (' +
      (doc.company ? doc.company + ' — ' : '') +
      (doc.jobUrl || 'no job link') +
      '). Re-read GET /jobcv/doc; POST /jobcv/switch first if this posting really is wanted.',
  })
  return false
}

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
          if (!(await assertActiveJob(store, res, sessionId, body.jobUrl))) return
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
          if (!(await assertActiveJob(store, res, sessionId, body.jobUrl))) return
          const version = await store.saveLetter(sessionId, { html: body.html, note: body.note })
          return sendJson(res, 200, { ok: true, version: version })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      },
    },
  ])
  const masterRoutes = defineRoutes('master cv', [
    {
      path: '/jobcv/master',
      // method omitted: the handler dispatches GET vs POST itself
      docs: [
        ['GET', 'the master CV — the source of truth every tailored application starts from'],
        ['POST', 'save the master CV (its own version line, like the cover letter)'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost')
          const rawSessionId = url.searchParams.get('session')
          if (sanitizeSessionId(rawSessionId) === null) {
            return sendJson(res, 400, { error: 'missing ?session=' })
          }
          const master = await store.getMaster()
          let mirror = null
          if (master.version > 0 && master.html !== '') {
            // Mirrored on read, not only on save: a root that first meets
            // the master through this GET still gets a latest.html the
            // onboarding pick list can hand out as a real path.
            mirror = await store.masterMirror(deps.resolveRoot(rawSessionId))
          }
          return sendJson(res, 200, {
            ok: true,
            master:
              master.version > 0 && master.html !== ''
                ? {
                    version: master.version,
                    html: master.html,
                    note: master.note,
                    updatedAt: master.updatedAt,
                  }
                : null,
            path: mirror === null ? '' : mirror.path,
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
          if (typeof body.html !== 'string' || body.html.trim() === '') {
            return sendJson(res, 400, { error: 'html must be a non-empty string' })
          }
          // No assertActiveJob here ON PURPOSE: the master belongs to no
          // posting, and a mid-turn switch must never refuse folding an
          // improvement back into it.
          const version = await store.saveMaster(sessionId, { html: body.html, note: body.note })
          const mirror = await store.masterMirror(deps.resolveRoot(body.sessionId))
          return sendJson(res, 200, {
            ok: true,
            version: version,
            path: mirror === null ? '' : mirror.path,
          })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      path: '/jobcv/delta',
      method: 'GET',
      docs: [
        ['GET', 'what the active document changed against the master CV (normalized block diff)'],
      ],
      handler: async function (req, res) {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = sanitizeSessionId(url.searchParams.get('session'))
        if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
        const kind = url.searchParams.get('kind') === 'letter' ? 'letter' : 'cv'
        return sendJson(res, 200, await store.deltaVsMaster(sessionId, kind))
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
          if (!(await assertActiveJob(store, res, sessionId, body.jobUrl))) return
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
          if (!(await assertActiveJob(store, res, sessionId, body.jobUrl))) return
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
          if (!(await assertActiveJob(store, res, sessionId, body.jobUrl))) return
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
          if (!(await assertActiveJob(store, res, sessionId, body.jobUrl))) return
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
        ['GET', '?kind=master reads the master CV timeline instead'],
      ],
      handler: async function (req, res) {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = sanitizeSessionId(url.searchParams.get('session'))
        if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
        // Three timelines. Anything but 'letter'/'master' means the CV, so an
        // older client that never sends ?kind keeps working.
        const wantedKind = url.searchParams.get('kind')
        const kind = wantedKind === 'letter' ? 'letter' : wantedKind === 'master' ? 'master' : 'cv'
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
        ['POST', '{"kind":"master"} rolls the master CV back instead'],
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
        const kind = body.kind === 'letter' ? 'letter' : body.kind === 'master' ? 'master' : 'cv'
        const version =
          kind === 'letter'
            ? await store.restoreLetter(sessionId, body.version)
            : kind === 'master'
              ? await store.restoreMaster(body.version)
              : await store.restore(sessionId, body.version)
        if (version === null) {
          return sendJson(res, 404, { error: 'version not found in history' })
        }
        return sendJson(res, 200, { ok: true, kind: kind, version: version })
      },
    },
  ])
  const recentsRoutes = defineRoutes('past applications', [
    {
      path: '/jobcv/cvs',
      method: 'GET',
      docs: [['GET', 'the latest CV of every past application, for the start form pick list']],
      handler: async function (req, res) {
        const url = new URL(req.url, 'http://localhost')
        const rawSessionId = url.searchParams.get('session')
        const sessionId = sanitizeSessionId(rawSessionId)
        if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
        // The current session is excluded: onboarding is where version 0
        // lives, so its own (empty) record could never be worth offering.
        return sendJson(res, 200, {
          ok: true,
          cvs: await store.listRecentCvs(sessionId),
          // The pinned pick above every past application: the user's master
          // CV, mirrored into THIS root first so its path exists right now.
          // null when there is no master yet — the form simply hides it.
          master: await store.masterMirror(deps.resolveRoot(rawSessionId)),
        })
      },
    },
  ])
  const jobListRoutes = defineRoutes('job list', [
    {
      path: '/jobcv/joblist',
      // method omitted: the handler dispatches GET vs POST itself
      docs: [
        ['GET', 'the session’s stored jobs pick list'],
        ['POST', 'parse a markdown jobs file into the pick list'],
      ],
      handler: async function (req, res) {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = sanitizeSessionId(url.searchParams.get('session'))
          if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
          const list = await store.getJobList(sessionId)
          return sendJson(res, 200, {
            ok: true,
            path: list.path,
            cvPath: list.cvPath,
            updatedAt: list.updatedAt,
            count: list.jobs.length,
            jobs: list.jobs,
          })
        }
        if (req.method === 'POST') {
          let body
          try {
            // A dropped .md arrives as base64, not as a 256KB JSON document.
            body = await readJsonBody(req, JOBLIST_BODY_LIMIT)
          } catch (error) {
            const tooBig = String(error && error.message) === 'body too large'
            return sendJson(res, tooBig ? 413 : 400, {
              error: tooBig ? 'file too large' : 'invalid body',
            })
          }
          const sessionId = sanitizeSessionId(body.sessionId)
          if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
          const cvPath = typeof body.cvPath === 'string' ? body.cvPath.trim() : ''
          let text = typeof body.text === 'string' && body.text.trim() !== '' ? body.text : null
          let sourcePath = typeof body.path === 'string' ? body.path.trim() : ''
          if (text === null) {
            if (typeof body.dataBase64 === 'string' && body.dataBase64 !== '') {
              // A dropped file has no path the host could re-read later, so
              // it is staged first (like an intake CV) and parsed from where
              // it landed — which is also the path Reload uses afterwards.
              let staged
              try {
                const current = await store.get(sessionId)
                const dir = intakeDirFor(deps.intakeRoot, sessionId, current.workspace)
                staged = await saveIntakeFile(dir, body.filename || 'jobs.md', body.dataBase64)
              } catch (error) {
                return sendJson(res, 400, {
                  error: String(error && error.message ? error.message : error),
                })
              }
              sourcePath = staged.path
            }
            try {
              text = await readJobListFile(sourcePath, deps.resolveRoot(body.sessionId))
            } catch (error) {
              return sendJson(res, 400, {
                error: String(error && error.message ? error.message : error),
              })
            }
          }
          const parsed = parseJobList(text)
          if (parsed.count === 0) {
            return sendJson(res, 400, {
              error: 'no job links found — expected markdown links like "- [Title](https://…)"',
            })
          }
          await store.setJobList(sessionId, {
            path: sourcePath,
            cvPath: cvPath,
            updatedAt: Date.now(),
            jobs: parsed.jobs,
          })
          return sendJson(res, 200, {
            ok: true,
            path: sourcePath,
            count: parsed.count,
            jobs: parsed.jobs,
          })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      },
    },
  ])
  const candidacyRoutes = defineRoutes('candidacies', [
    {
      path: '/jobcv/candidacies',
      method: 'GET',
      docs: [['GET', "this session's candidacies — the active one plus its archives"]],
      handler: async function (req, res) {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = sanitizeSessionId(url.searchParams.get('session'))
        if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
        const rows = await store.listCandidacies(sessionId)
        return sendJson(res, 200, {
          ok: true,
          candidacies: rows,
          active: rows.find((row) => row.active) || null,
        })
      },
    },
    {
      path: '/jobcv/switch',
      method: 'POST',
      docs: [
        ['POST', "make another job this session's active candidacy"],
        ['POST', 'archives the outgoing one with its whole history; answers resumed true/false'],
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
        if (typeof body.jobUrl !== 'string' || body.jobUrl.trim() === '') {
          return sendJson(res, 400, { error: 'jobUrl must be a non-empty string' })
        }
        const result = await store.switchCandidacy(sessionId, {
          jobUrl: body.jobUrl,
          company: typeof body.company === 'string' ? body.company : undefined,
          jobTitle: typeof body.jobTitle === 'string' ? body.jobTitle : undefined,
        })
        // The default CV of this session's list rides along best-effort, so
        // starting the NEXT job from the panel can pre-fill it.
        if (typeof body.cvPath === 'string' && body.cvPath.trim() !== '') {
          try {
            const list = await store.getJobList(sessionId)
            await store.setJobList(
              sessionId,
              Object.assign({}, list, { cvPath: body.cvPath.trim() }),
            )
          } catch (error) {
            console.warn(
              '[dsh-job-cv] could not remember the list CV path: ' +
                String(error && error.message ? error.message : error),
            )
          }
        }
        return sendJson(res, 200, Object.assign({ ok: true }, result))
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
  const trackerRoutes = defineRoutes('tracker', [
    {
      path: '/jobcv/applications',
      method: 'GET',
      docs: [['GET', 'every application: latest CV/letter/post per candidacy, newest first']],
      handler: async function (req, res) {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = sanitizeSessionId(url.searchParams.get('session'))
        if (sessionId === null) return sendJson(res, 400, { error: 'missing ?session=' })
        const applications = await store.listApplications()
        // The counts the panel header shows; an untagged row is drafting.
        const counts = {}
        for (const status of ['drafting', 'applied', 'interview', 'offer', 'rejected']) {
          counts[status] = 0
        }
        for (const app of applications) {
          const tag =
            app.application === null ? DEFAULT_STATUS : app.application.status || DEFAULT_STATUS
          if (counts[tag] !== undefined) counts[tag] += 1
        }
        return sendJson(res, 200, { ok: true, applications: applications, counts: counts })
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
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return sendJson(res, 400, { error: 'invalid body' })
        }
        const sessionId = sanitizeSessionId(body.sessionId)
        if (sessionId === null) return sendJson(res, 400, { error: 'missing sessionId' })
        const status = typeof body.status === 'string' ? body.status : ''
        if (!isValidStatus(status)) {
          return sendJson(res, 400, {
            error: 'status must be one of drafting | applied | interview | offer | rejected',
          })
        }
        let application
        try {
          application = await store.setApplication(sessionId, { status: status, note: body.note })
        } catch (error) {
          return sendJson(res, 400, {
            error: String(error && error.message ? error.message : error),
          })
        }
        return sendJson(res, 200, { ok: true, application: application })
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
