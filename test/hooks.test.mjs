import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'

// A conditional standard-kit hook call is the one client bug that hides
// itself completely. `useInput` is absent until a session is current (the
// dock sits in a session-maybe seat), so calling it behind a ternary changes
// the component's hook order the moment it appears — React answers by
// unmounting the subtree, and the whole dock disappears with no error on
// screen and nothing for the user to report but "the button is gone".
//
// The safe shape is a child that is conditionally RENDERED: its own hook list,
// so appearing and disappearing costs nothing.
const dir = new URL('../lib/client/', import.meta.url)
const fragments = readdirSync(dir).filter((f) => f.endsWith('.js'))
assert.ok(fragments.length > 0)

const offenders = []
for (const name of fragments) {
  const src = readFileSync(new URL(name, dir), 'utf8')
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // `props.useThing ? props.useThing(...) : x` — on one line or split
    const guarded =
      /props\.use[A-Z][A-Za-z]*\s*$/.test(line.trim()) && /^\s*\?/.test(lines[i + 1] || '')
    const inline = /props\.use[A-Z][A-Za-z]*\s*(\?|&&)/.test(line)
    if (guarded || inline) {
      // A conditional RENDER of a child that owns the hook is the fix, not the bug.
      const following = (lines[i + 1] || '') + (lines[i + 2] || '')
      if (/createElement\(/.test(following)) continue
      offenders.push(name + ':' + String(i + 1) + '  ' + line.trim())
    }
  }
}
assert.deepEqual(
  offenders,
  [],
  'a standard-kit hook is called conditionally — render a child that owns it instead:\n  ' +
    offenders.join('\n  '),
)

// and the fix is actually in place: the hook lives in a component that calls
// it unconditionally, and JobDock no longer calls it at all
const dock = readFileSync(new URL('050-job-dock.js', dir), 'utf8')
const probe = dock.slice(dock.indexOf('function DraftProbe'))
assert.ok(probe.includes('useInput(function'), 'DraftProbe calls the hook unconditionally')
const jobDock = dock.slice(dock.indexOf('function JobDock('), dock.indexOf('function DockBoundary'))
assert.ok(
  !/props\.useInput\s*\(/.test(jobDock),
  'JobDock must not call useInput itself — it renders DraftProbe',
)

// the dock is mounted behind an error boundary, so a future crash is visible
assert.ok(dock.includes('getDerivedStateFromError'), 'the dock has an error boundary')
const wiring = readFileSync(new URL('060-plugin-wiring.js', dir), 'utf8')
assert.ok(wiring.includes('JobDockRoot'), 'the slot mounts the boundary, not the bare dock')

console.log('ok  client hook safety')
