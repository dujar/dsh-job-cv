/**
 * The job-CV application service — the workflow's operations, once.
 *
 * Every operation the DSH plugin exposes as a `/jobcv/*` route and the MCP
 * shell exposes as a tool is a method here: input validation, the
 * mid-turn-switch guard, the `normalize*` coercion and the multi-step
 * orchestrations (workspace upsert, master mirror, switch sidecar) live in
 * this layer. The routes translate HTTP to a call here; the MCP tools call
 * it in-process.
 *
 * It depends only on the store and a `resolveRoot(rawSessionId)` — no HTTP,
 * no DSH context. Errors are the typed ones from ./errors.js, so a route
 * maps them to a status and the MCP shell reports the message.
 */
import { sanitizeSessionId } from '../store/doc-store.js'
import { upsertCandidacy, listCandidacyFiles } from '../store/workspace.js'
import { normalizeProposal } from '../store/proposal.js'
import { normalizeFit } from '../store/fit.js'
import { normalizeBrief } from '../store/post-brief.js'
import { isValidStatus, DEFAULT_STATUS } from '../store/applications.js'
import { parseJobList, urlMatchKey } from '../store/joblist.js'
import { BadRequest, NotFound, StaleSave } from './errors.js'

/** Sanitize a session id or reject the request. */
function sid(raw) {
  const safe = sanitizeSessionId(raw)
  if (safe === null) throw new BadRequest('missing or invalid sessionId')
  return safe
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequest(field + ' must be a non-empty string')
  }
  return value
}

export function createJobCvApp(deps) {
  const store = deps.store
  const resolveRoot = deps.resolveRoot
  const skillText = typeof deps.skillText === 'string' ? deps.skillText : ''

  /**
   * A save that names its posting is refused when that is no longer this
   * session's active candidacy — the user switched while the agent worked,
   * and the save would land on the wrong folder. A save with no jobUrl is
   * unguarded, exactly as before.
   */
  async function assertActiveJob(session, claimedJobUrl) {
    if (typeof claimedJobUrl !== 'string' || claimedJobUrl.trim() === '') return
    const doc = await store.get(session)
    if (urlMatchKey(doc.jobUrl || '') === urlMatchKey(claimedJobUrl)) return
    throw new StaleSave(
      'stale save: the active candidacy changed under you (' +
        (doc.company ? doc.company + ' — ' : '') +
        (doc.jobUrl || 'no job link') +
        '). Re-read the document; switch to this posting first if it is really wanted.',
    )
  }

  // ─────────────────────────────── reads ───────────────────────────────

  const getDoc = (raw) => store.get(sid(raw))

  async function getWorkspace(raw) {
    const doc = await store.get(sid(raw))
    if (doc.workspace === '') return { ok: true, path: '', files: [] }
    return {
      ok: true,
      path: doc.workspace,
      files: await listCandidacyFiles(doc.workspace),
      company: doc.company,
      jobTitle: doc.jobTitle,
    }
  }

  async function getLetter(raw) {
    const doc = await store.get(sid(raw))
    return { ok: true, letter: doc.letter }
  }

  async function getMaster(raw) {
    sid(raw)
    const master = await store.getMaster()
    let path = ''
    if (master.version > 0 && master.html !== '') {
      const mirror = await store.masterMirror(resolveRoot(raw))
      path = mirror === null ? '' : mirror.path
    }
    return {
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
      path,
    }
  }

  const getDelta = (raw, kind) => store.deltaVsMaster(sid(raw), kind === 'letter' ? 'letter' : 'cv')

  async function getPost(raw) {
    const session = sid(raw)
    const doc = await store.get(session)
    const post = await store.getPost(session)
    return {
      ok: true,
      text: post === null ? '' : post.text,
      source: post === null ? '' : post.source,
      updatedAt: post === null ? 0 : post.updatedAt,
      html: post === null ? '' : post.html,
      htmlUpdatedAt: post === null ? 0 : post.htmlUpdatedAt,
      jobUrl: doc.jobUrl,
      company: doc.company,
      jobTitle: doc.jobTitle,
    }
  }

  const getBrief = async (raw) => ({ ok: true, brief: await store.getBrief(sid(raw)) })
  const getFit = async (raw) => ({ ok: true, fit: (await store.get(sid(raw))).fit })
  const getProposal = async (raw) => ({ ok: true, proposal: (await store.get(sid(raw))).proposal })

  async function getHistory(raw, opts) {
    const session = sid(raw)
    const o = opts || {}
    const kind = o.kind === 'letter' ? 'letter' : o.kind === 'master' ? 'master' : 'cv'
    if (o.version !== undefined && o.version !== null) {
      const version = Number(o.version)
      if (!Number.isInteger(version) || version < 1) {
        throw new BadRequest('version must be a positive integer')
      }
      const html = await store.versionHtml(session, version, kind)
      if (html === null) throw new NotFound('version not found in history')
      return { ok: true, kind, version, html }
    }
    return { ok: true, kind, versions: await store.history(session, kind) }
  }

  async function getRecentCvs(raw) {
    const session = sid(raw)
    return {
      ok: true,
      cvs: await store.listRecentCvs(session),
      master: await store.masterMirror(resolveRoot(raw)),
    }
  }

  async function getCandidacies(raw) {
    const rows = await store.listCandidacies(sid(raw))
    return { ok: true, candidacies: rows, active: rows.find((row) => row.active) || null }
  }

  async function getApplications() {
    const applications = await store.listApplications()
    const counts = {}
    for (const status of ['drafting', 'applied', 'interview', 'offer', 'rejected']) {
      counts[status] = 0
    }
    for (const app of applications) {
      const tag =
        app.application === null ? DEFAULT_STATUS : app.application.status || DEFAULT_STATUS
      if (counts[tag] !== undefined) counts[tag] += 1
    }
    return { ok: true, applications, counts }
  }

  async function getJobList(raw) {
    const list = await store.getJobList(sid(raw))
    return {
      ok: true,
      path: list.path,
      cvPath: list.cvPath,
      updatedAt: list.updatedAt,
      count: list.jobs.length,
      jobs: list.jobs,
    }
  }

  const getSkill = () => skillText

  // ─────────────────────────────── writes ──────────────────────────────

  async function saveCv(raw, body) {
    const session = sid(raw)
    nonEmptyString(body.html, 'html')
    await assertActiveJob(session, body.jobUrl)
    const version = await store.save(session, {
      html: body.html,
      jobUrl: body.jobUrl,
      note: body.note,
    })
    return { ok: true, version }
  }

  async function openWorkspace(raw, body) {
    const session = sid(raw)
    nonEmptyString(body.company, 'company')
    const result = await upsertCandidacy(resolveRoot(raw), {
      company: body.company,
      jobId: body.jobId,
      jobUrl: body.jobUrl,
      jobTitle: body.jobTitle,
    })
    if (result === null) {
      throw new BadRequest('company and job id/url yield no usable folder name')
    }
    await store.setWorkspace(session, result.path, body.jobUrl, body.company, body.jobTitle)
    return {
      ok: true,
      path: result.path,
      company: result.company,
      jobId: result.job,
      created: result.created,
    }
  }

  async function saveLetter(raw, body) {
    const session = sid(raw)
    nonEmptyString(body.html, 'html')
    await assertActiveJob(session, body.jobUrl)
    const version = await store.saveLetter(session, { html: body.html, note: body.note })
    return { ok: true, version }
  }

  async function saveMaster(raw, body) {
    const session = sid(raw)
    nonEmptyString(body.html, 'html')
    // No assertActiveJob: the master belongs to no posting, and a mid-turn
    // switch must never refuse folding an improvement back into it.
    const version = await store.saveMaster(session, { html: body.html, note: body.note })
    const mirror = await store.masterMirror(resolveRoot(raw))
    return { ok: true, version, path: mirror === null ? '' : mirror.path }
  }

  async function setPost(raw, body) {
    const session = sid(raw)
    nonEmptyString(body.text, 'text')
    await assertActiveJob(session, body.jobUrl)
    const post = await store.setPost(session, body.text, body.source, body.html)
    return {
      ok: true,
      chars: post === null ? 0 : post.text.length,
      source: post === null ? '' : post.source,
    }
  }

  async function setBrief(raw, body) {
    const session = sid(raw)
    await assertActiveJob(session, body.jobUrl)
    const brief = normalizeBrief(body)
    if (brief === null) throw new BadRequest('a brief needs at least one section or one meta fact')
    await store.setBrief(session, brief)
    return { ok: true, sections: brief.sections.length }
  }

  async function setFit(raw, body) {
    const session = sid(raw)
    await assertActiveJob(session, body.jobUrl)
    const current = await store.get(session)
    const fit = normalizeFit(
      body,
      current.version,
      current.letter === null ? 0 : current.letter.version,
    )
    if (fit === null) throw new BadRequest('a fit needs a numeric score between 0 and 100')
    await store.setFit(session, fit)
    return { ok: true, score: fit.score, gaps: fit.gaps.length }
  }

  async function setProposal(raw, body) {
    const session = sid(raw)
    await assertActiveJob(session, body.jobUrl)
    const current = await store.get(session)
    const proposal = normalizeProposal(body, current.version)
    if (proposal === null) {
      throw new BadRequest('a proposal needs at least one change carrying at least one option')
    }
    await store.setProposal(session, proposal)
    return { ok: true, proposalId: proposal.id, changes: proposal.changes.length }
  }

  async function clearProposal(raw) {
    await store.setProposal(sid(raw), null)
    return { ok: true }
  }

  async function restore(raw, body) {
    const session = sid(raw)
    if (!Number.isInteger(body.version) || body.version < 1) {
      throw new BadRequest('version must be a positive integer')
    }
    const kind = body.kind === 'letter' ? 'letter' : body.kind === 'master' ? 'master' : 'cv'
    const version =
      kind === 'letter'
        ? await store.restoreLetter(session, body.version)
        : kind === 'master'
          ? await store.restoreMaster(body.version)
          : await store.restore(session, body.version)
    if (version === null) throw new NotFound('version not found in history')
    return { ok: true, kind, version }
  }

  async function switchCandidacy(raw, body) {
    const session = sid(raw)
    nonEmptyString(body.jobUrl, 'jobUrl')
    const result = await store.switchCandidacy(session, {
      jobUrl: body.jobUrl,
      company: typeof body.company === 'string' ? body.company : undefined,
      jobTitle: typeof body.jobTitle === 'string' ? body.jobTitle : undefined,
    })
    if (typeof body.cvPath === 'string' && body.cvPath.trim() !== '') {
      try {
        const list = await store.getJobList(session)
        await store.setJobList(session, Object.assign({}, list, { cvPath: body.cvPath.trim() }))
      } catch (error) {
        console.warn(
          '[dsh-job-cv] could not remember the list CV path: ' +
            String(error && error.message ? error.message : error),
        )
      }
    }
    return Object.assign({ ok: true }, result)
  }

  async function setStatus(raw, body) {
    const session = sid(raw)
    const status = typeof body.status === 'string' ? body.status : ''
    if (!isValidStatus(status)) {
      throw new BadRequest(
        'status must be one of drafting | applied | interview | offer | rejected',
      )
    }
    try {
      const application = await store.setApplication(session, { status, note: body.note })
      return { ok: true, application }
    } catch (error) {
      throw new BadRequest(String(error && error.message ? error.message : error))
    }
  }

  /**
   * Parse resolved markdown text into the pick list and store it. The route
   * (or the MCP tool) is responsible for turning a path or a staged upload
   * into `text` first.
   */
  async function setJobListFromText(raw, opts) {
    const session = sid(raw)
    const o = opts || {}
    const parsed = parseJobList(typeof o.text === 'string' ? o.text : '')
    if (parsed.count === 0) {
      throw new BadRequest(
        'no job links found — expected markdown links like "- [Title](https://…)"',
      )
    }
    await store.setJobList(session, {
      path: typeof o.path === 'string' ? o.path : '',
      cvPath: typeof o.cvPath === 'string' ? o.cvPath.trim() : '',
      updatedAt: Date.now(),
      jobs: parsed.jobs,
    })
    return {
      ok: true,
      path: typeof o.path === 'string' ? o.path : '',
      count: parsed.count,
      jobs: parsed.jobs,
    }
  }

  return {
    // reads
    getDoc,
    getWorkspace,
    getLetter,
    getMaster,
    getDelta,
    getPost,
    getBrief,
    getFit,
    getProposal,
    getHistory,
    getRecentCvs,
    getCandidacies,
    getApplications,
    getJobList,
    getSkill,
    // writes
    saveCv,
    openWorkspace,
    saveLetter,
    saveMaster,
    setPost,
    setBrief,
    setFit,
    setProposal,
    clearProposal,
    restore,
    switchCandidacy,
    setStatus,
    setJobListFromText,
    // escape hatch for the SSE route and the intake route, which are pure
    // transport and stay in the route layer
    store,
    resolveRoot,
  }
}
