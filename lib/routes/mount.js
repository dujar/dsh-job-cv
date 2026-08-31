/**
 * Route mounting for the /jobcv/* surface (same pattern as dsh-trader:
 * one declaration site per route, shared guards, summary derived from the
 * declarations so it cannot drift).
 */

/** Group a domain's declarations under a heading for the boot summary. */
export function defineRoutes(group, entries) {
  return { group, entries }
}

/** Wrap one declaration in the shared guards. */
export function guardHandler(entry, deps) {
  return async function (req, res) {
    if (entry.method && req.method !== entry.method) {
      return deps.sendJson(res, 405, { error: 'method not allowed' })
    }
    if (!deps.isTrusted(req)) return deps.sendJson(res, 403, { error: 'untrusted request' })
    let body
    if (entry.body) {
      try {
        body = await deps.readJsonBody(req)
      } catch (err) {
        return deps.sendJson(res, 400, { error: 'invalid body' })
      }
    }
    try {
      return await entry.handler(req, res, body)
    } catch (error) {
      // An app-layer error names its own HTTP status (400 bad input, 409
      // stale save…); anything else is an unhandled 500.
      const status = error && Number.isInteger(error.status) ? error.status : 500
      return deps.sendJson(res, status, {
        error: String(error && error.message ? error.message : error),
      })
    }
  }
}

/** Register every group's routes and return the rendered boot summary. */
export function mountRouteGroups(ctx, groups, deps) {
  const rows = []
  for (const { group, entries } of groups) {
    const groupRows = []
    for (const entry of entries) {
      const handler = guardHandler(entry, deps)
      ctx.effect(
        () => ctx.webServer.register({ kind: 'exact', path: entry.path, handler }),
        'dsh-job-cv: ' + entry.path + ' route',
      )
      for (const [method, what] of entry.docs) groupRows.push([method, entry.path, what])
    }
    rows.push([group, groupRows])
  }
  return renderRouteSummary(rows)
}

/** The aligned, grouped boot log (asserted on by the route test). */
export function renderRouteSummary(rows) {
  const cols = rows
    .flatMap(function (pair) {
      return pair[1]
    })
    .map(function (r) {
      return r[0] + ' ' + r[1]
    })
  const pad =
    Math.max.apply(
      null,
      cols.map(function (col) {
        return col.length
      }),
    ) + 2
  const lines = ['[dsh-job-cv] host routes ready']
  for (const [group, rs] of rows) {
    lines.push('  ' + group)
    for (const r of rs) lines.push('    ' + (r[0] + ' ' + r[1]).padEnd(pad) + r[2])
  }
  return lines.join('\n')
}
