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
import { defineJobCvRoutes } from './routes/routes.js'
import { mountRouteGroups } from './routes/mount.js'
import { isTrustedRequest, readJsonBody, sendJson, sendText } from './http/http-utils.js'
import { join } from 'node:path'

export const name = 'dsh-job-cv'

/** Host services required before mounting. */
export const inject = ['webServer']

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

  const store = createDocStore(join(dshHome(), 'dsh-job-cv'))
  const groups = defineJobCvRoutes({
    store: store,
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
