/**
 * dsh-job-cv host half — composition root.
 *
 * Adds a 'job' agent preset to the DSH mode roster (discovered from
 * $DSH_HOME/.agent-presets) and serves the /jobcv/* document surface the
 * browser half and the session agent both talk to. The seed never
 * overwrites: once the preset directory exists the user owns it.
 *
 * The browser half (lib/client.js) detects when the current session's
 * preset is 'job' and then restructures the layout: the chat narrows to a
 * sidebar column and the main area becomes a live CV preview rendered
 * from the stored HTML document, exportable to PDF via the print dialog.
 */
import { seedJobPreset, seedJobSkill, skillInstructions, dshHome } from './preset/preset-seed.js'
import { createDocStore } from './store/doc-store.js'
import { candidacyRoot } from './store/workspace.js'
import { defineJobCvRoutes } from './routes/routes.js'
import { mountRouteGroups } from './routes/mount.js'
import { isTrustedRequest, readJsonBody, sendJson, sendText } from './http/http-utils.js'
import { join } from 'node:path'

export const name = 'dsh-job-cv'

/** Host services required before mounting. */
export const inject = ['webServer']

/**
 * The working directory a session was started in, or '' when it cannot be
 * resolved. Read defensively rather than declared in `inject`: a missing or
 * late `sessions` service must degrade to the $DSH_HOME fallback, never stop
 * the whole plugin from mounting.
 */
function sessionCwd(ctx, rawSessionId) {
  try {
    const store = ctx.sessions
    if (!store || typeof store.get !== 'function') return ''
    const id = String(rawSessionId === undefined || rawSessionId === null ? '' : rawSessionId)
    // The browser spells ids 'session-<uuid>'; an agent may send the bare uuid.
    const session =
      store.get(id) || store.get(id.replace(/^session-/, '')) || store.get('session-' + id)
    const cwd = session && session.header && session.header.cwd
    return typeof cwd === 'string' ? cwd : ''
  } catch {
    return '' // the store is optional; the fallback root still works
  }
}

export function apply(ctx) {
  seedJobPreset().catch(function (error) {
    console.warn(
      '[dsh-job-cv] failed to seed job preset:',
      String(error && error.message ? error.message : error),
    )
  })
  seedJobSkill().catch(function (error) {
    console.warn(
      '[dsh-job-cv] failed to seed job skill:',
      String(error && error.message ? error.message : error),
    )
  })

  const home = dshHome()
  const store = createDocStore(join(home, 'dsh-job-cv'))
  const groups = defineJobCvRoutes({
    store: store,
    resolveRoot: function (rawSessionId) {
      return candidacyRoot({ sessionCwd: sessionCwd(ctx, rawSessionId), dshHome: home })
    },
    intakeRoot: join(home, 'dsh-job-cv', 'intake'),
    skillText: skillInstructions(),
    sendText: sendText,
  })
  const summary = mountRouteGroups(ctx, groups, {
    isTrusted: isTrustedRequest,
    readJsonBody: readJsonBody,
    sendJson: sendJson,
  })
  console.log(summary)
}
