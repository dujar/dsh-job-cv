import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, readdir, readFile, stat, lstat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  slugify,
  jobSlugFromUrl,
  jobSlug,
  candidacyPath,
  upsertCandidacy,
  applicationsRoot,
  candidacyRoot,
  listCandidacyFiles,
  readCandidacyIdentity,
  isStrongJobSlug,
  LOCK_WAIT_MS,
  CANDIDACY_DIRS,
  mirrorCvVersion,
} from '../lib/store/workspace.js'
import { normalizeUrl as normalizeJobUrl } from '../lib/store/joblist.js'
import {
  saveIntakeFile,
  intakeDirFor,
  sanitizeFileName,
  INTAKE_LIMIT,
} from '../lib/store/intake.js'

// ---- slugging: the folder names the host derives, never the agent ----
assert.equal(slugify('Acme Corp', 'x'), 'acme-corp')
assert.equal(slugify('  Acme   Corp  ', 'x'), 'acme-corp')
assert.equal(slugify('Café Zürich', 'x'), 'cafe-zurich')
assert.equal(slugify('!!!', 'fallback'), 'fallback')
assert.equal(slugify('', 'fallback'), 'fallback')
assert.equal(slugify(undefined, 'fallback'), 'fallback')

assert.equal(jobSlugFromUrl('https://jobs.lever.co/acme/abc-123-def-456'), 'abc-123-def-456')
assert.equal(jobSlugFromUrl('https://www.linkedin.com/jobs/view/3876543210/'), '3876543210')
assert.equal(jobSlugFromUrl('https://boards.greenhouse.io/acme/jobs/7654321'), '7654321')
assert.equal(jobSlugFromUrl('https://example.com/jobs/senior-engineer'), 'senior-engineer')
assert.equal(jobSlugFromUrl('not a url'), '')

assert.equal(jobSlug('42', 'https://x/y'), '42', 'explicit id wins')
assert.equal(jobSlug('', 'https://x/y/42'), '42', 'url id used when no explicit id')
assert.equal(jobSlug('', 'https://x/jobs/senior-engineer'), 'senior-engineer')
assert.ok(
  /^job-[0-9a-f]{10}$/.test(jobSlug('', 'https://x/!!!')),
  'url digest as last resort when the last segment slugifies to nothing',
)

assert.deepEqual(candidacyPath({ company: 'Acme Corp', jobId: '42', jobUrl: '' }), {
  company: 'acme-corp',
  job: '42',
  relative: join('acme-corp', '42'),
})
assert.equal(candidacyPath({ company: '', jobId: '42' }), null)
assert.equal(candidacyPath({ company: 'Acme', jobId: '', jobUrl: '' }), null)

// ---- upsert: create once, adopt on resume, never clobber ----
const dir = await mkdtemp(join(tmpdir(), 'jobcv-ws-'))
try {
  const first = await upsertCandidacy(dir, {
    company: 'Acme Corp',
    jobId: '42',
    jobUrl: 'https://jobs.example.com/42',
    jobTitle: 'Senior Engineer',
  })
  assert.equal(first.created, true)
  assert.equal(first.path, join(dir, 'acme-corp', '42'))
  assert.equal(first.company, 'acme-corp')
  assert.equal(first.job, '42')

  // a second upsert for the same job resumes instead of forking
  const second = await upsertCandidacy(dir, {
    company: 'Acme Corp',
    jobId: '42',
    jobUrl: 'https://jobs.example.com/42',
  })
  assert.equal(second.created, false)
  assert.equal(second.path, join(dir, 'acme-corp', '42'))

  // a different job under the same company gets its own folder
  const other = await upsertCandidacy(dir, { company: 'Acme Corp', jobId: '99' })
  assert.equal(other.created, true)
  assert.equal(other.path, join(dir, 'acme-corp', '99'))

  // the README breadcrumb lands on every creation (42 and 99 both created)
  const readme = await readFile(join(dir, 'acme-corp', '42', 'README.md'), 'utf8')
  assert.ok(readme.includes('Acme Corp'))
  assert.ok(readme.includes('https://jobs.example.com/42'))
  const readme99 = await readFile(join(dir, 'acme-corp', '99', 'README.md'), 'utf8')
  assert.ok(readme99.includes('Acme Corp'))
  // ...but a resumed folder is never clobbered: re-upserting 42 keeps its
  // original breadcrumb (the 'wx' flag refuses to overwrite user edits).
  await upsertCandidacy(dir, { company: 'Acme Corp', jobId: '42', jobTitle: 'Rewritten' })
  const readmeAgain = await readFile(join(dir, 'acme-corp', '42', 'README.md'), 'utf8')
  assert.ok(readmeAgain.includes('Senior Engineer'), 'resume does not rewrite the README')

  // listCandidacyFiles: names + sizes, newest first; missing dir -> []
  // Root files: the README breadcrumb plus the recorded identity (which
  // posting this folder is FOR — what makes Acme/Acme Corp one folder).
  const files = await listCandidacyFiles(join(dir, 'acme-corp', '42'))
  assert.deepEqual(files.map((f) => f.name).sort(), ['README.md', 'application.json'])
  assert.ok(files[0].size > 0)
  assert.ok(files[0].mtime > 0)
  assert.deepEqual(await listCandidacyFiles(join(dir, 'does-not-exist')), [])

  // ---- the candidacy layout ----
  // Scaffolded on upsert so the agent never has to invent a place for things.
  const home = join(dir, 'acme-corp', '42')
  for (const [name] of CANDIDACY_DIRS) {
    assert.equal((await stat(join(home, name))).isDirectory(), true, name + '/ is scaffolded')
  }
  // ...and on RE-open too, so a folder from an older build gains the layout
  await rm(join(home, 'notes'), { recursive: true, force: true })
  await upsertCandidacy(dir, { company: 'Acme Corp', jobId: '42' })
  assert.equal((await stat(join(home, 'notes'))).isDirectory(), true, 'relaid on re-upsert')

  const layoutReadme = await readFile(join(home, 'README.md'), 'utf8')
  for (const [name] of CANDIDACY_DIRS) {
    assert.ok(layoutReadme.includes('`' + name + '/`'), 'README explains ' + name + '/')
  }

  // ---- mirrorCvVersion: the folder holds the actual CV ----
  assert.equal(await mirrorCvVersion('', 1, '<h1>x</h1>'), null, 'no workspace, no mirror')
  assert.equal(await mirrorCvVersion(home, 0, '<h1>x</h1>'), null, 'version 0 is not a save')
  assert.equal(await mirrorCvVersion(home, 1, ''), null, 'an empty document is not mirrored')

  await mirrorCvVersion(home, 1, '<h1>one</h1>')
  await mirrorCvVersion(home, 2, '<h1>two</h1>')
  assert.equal(await readFile(join(home, 'cv', 'v1.html'), 'utf8'), '<h1>one</h1>')
  assert.equal(await readFile(join(home, 'cv', 'v2.html'), 'utf8'), '<h1>two</h1>')
  assert.equal(
    await readFile(join(home, 'cv', 'latest.html'), 'utf8'),
    '<h1>two</h1>',
    'latest.html tracks the newest save',
  )
  // a copy, not a symlink: the folder has to survive being zipped and moved
  assert.equal((await lstat(join(home, 'cv', 'latest.html'))).isSymbolicLink(), false)
  assert.deepEqual(
    (await readdir(join(home, 'cv'))).filter((f) => f.includes('.tmp-')),
    [],
    'no temp files left behind',
  )

  // ---- listing recurses one level, so the scaffold is not a dead end ----
  const listed = await listCandidacyFiles(home)
  const names = listed.map((f) => f.name)
  assert.ok(names.includes('cv/v1.html'), 'nested files come back relative: ' + names.join(', '))
  assert.ok(names.includes('cv/latest.html'))
  assert.ok(names.includes('README.md'), 'top-level files still listed')
  assert.ok(
    names.every((n) => n.split('/').length <= 2),
    'one level only — a deep tree cannot flood the list',
  )

  // applicationsRoot: env override wins, else under dshHome
  const prev = process.env.DSH_JOB_CV_ROOT
  try {
    process.env.DSH_JOB_CV_ROOT = '/custom/apps'
    assert.equal(applicationsRoot('/home/u'), '/custom/apps')
    delete process.env.DSH_JOB_CV_ROOT
    assert.equal(applicationsRoot('/home/u'), join('/home/u', 'dsh-job-cv', 'applications'))

    // candidacyRoot: an application belongs in the session's own project, not
    // in $DSH_HOME beside the plugin's internal state.
    assert.equal(
      candidacyRoot({ sessionCwd: '/home/u/projects/job_candidatures', dshHome: '/home/u/.dsh' }),
      '/home/u/projects/job_candidatures',
      'the session working directory wins',
    )
    // no cwd (or a relative one) falls back rather than guessing
    assert.equal(
      candidacyRoot({ sessionCwd: '', dshHome: '/home/u/.dsh' }),
      join('/home/u/.dsh', 'dsh-job-cv', 'applications'),
    )
    assert.equal(
      candidacyRoot({ sessionCwd: 'relative/path', dshHome: '/home/u/.dsh' }),
      join('/home/u/.dsh', 'dsh-job-cv', 'applications'),
      'a relative cwd is not a workspace',
    )
    assert.equal(candidacyRoot(), applicationsRoot(undefined))
    // an explicit override still beats everything
    process.env.DSH_JOB_CV_ROOT = '/custom/apps'
    assert.equal(candidacyRoot({ sessionCwd: '/home/u/projects/x' }), '/custom/apps')
  } finally {
    if (prev === undefined) delete process.env.DSH_JOB_CV_ROOT
    else process.env.DSH_JOB_CV_ROOT = prev
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

// ---- intake: staged dropped files land under <root>/<session>/ ----
const intakeDir = await mkdtemp(join(tmpdir(), 'jobcv-intake-'))
try {
  assert.equal(sanitizeFileName('cv.pdf', 'cv'), 'cv.pdf')
  assert.equal(sanitizeFileName('../../etc/passwd', 'cv'), 'passwd')
  assert.equal(sanitizeFileName('.hidden', 'cv'), 'hidden')
  assert.equal(sanitizeFileName('', 'cv'), 'cv')
  assert.equal(sanitizeFileName('a'.repeat(200) + '.pdf', 'cv').length <= 100, true)

  const staged = await saveIntakeFile(
    join(intakeDir, 's1'),
    'my cv.pdf',
    Buffer.from('hello').toString('base64'),
  )
  // an upload goes into the candidacy folder once one exists, staging before
  assert.equal(intakeDirFor('/intake', 's1', ''), join('/intake', 's1'))
  assert.equal(intakeDirFor('/intake', 's1', undefined), join('/intake', 's1'))
  assert.equal(intakeDirFor('/intake', 's1', '/apps/acme/42'), join('/apps/acme/42', 'source'))

  assert.equal(staged.bytes, 5)
  assert.equal(staged.path, join(intakeDir, 's1', 'my_cv.pdf'))
  const files = await readdir(join(intakeDir, 's1'))
  assert.deepEqual(files, ['my_cv.pdf'])

  // empty / invalid base64 is rejected
  await assert.rejects(saveIntakeFile(join(intakeDir, 's1'), 'x.pdf', ''), /empty/)
  await assert.rejects(saveIntakeFile(join(intakeDir, 's1'), 'x.pdf', '???'), /empty/)

  assert.equal(INTAKE_LIMIT, 12 * 1024 * 1024)
} finally {
  await rm(intakeDir, { recursive: true, force: true })
}

// ---- folder identity: one posting, ONE folder, however it is spelled ----
{
  const root = await mkdtemp(join(tmpdir(), 'jobcv-identity-'))
  try {
    const urlA = 'https://jobs.acme.com/123'

    const first = await upsertCandidacy(root, {
      company: 'Acme Corp',
      jobUrl: urlA,
      jobTitle: 'Senior Engineer',
    })
    assert.equal(first.created, true)
    assert.equal(first.adoptedBy, null)

    // The same posting under a different company spelling adopts the
    // existing folder instead of forking a twin that would share (and
    // clobber) its cv/ directory.
    const again = await upsertCandidacy(root, {
      company: 'Acme',
      jobUrl: urlA + '/?trk=public_search&li_fat_id=abc',
    })
    assert.equal(again.created, false)
    assert.equal(again.adoptedBy, 'url')
    assert.equal(again.path, first.path)

    const identity = await readCandidacyIdentity(first.path)
    assert.equal(normalizeJobUrl(identity.jobUrl), urlA)
    assert.ok(identity.recordedAt > 0)

    // A legacy fork — made before identity files existed — is healed when
    // the board id is unique enough to be trusted on its own.
    const legacy = join(root, 'acme-corp-legacy', '456789')
    await mkdir(legacy, { recursive: true })
    const healed = await upsertCandidacy(root, {
      company: 'ACME Corporation',
      jobUrl: 'https://jobs.acme.com/456789',
    })
    assert.equal(healed.created, false, 'the strong board id identifies the posting')
    assert.equal(healed.adoptedBy, 'id')
    assert.equal(healed.path, legacy)

    // ---- strong vs weak slugs: what may be trusted across companies
    assert.equal(isStrongJobSlug('3876543210'), true)
    assert.equal(isStrongJobSlug('7654321'), true)
    assert.equal(isStrongJobSlug('a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6'), true)
    assert.equal(isStrongJobSlug('senior-engineer'), false)
    assert.equal(isStrongJobSlug('123'), false, 'short numbers are not board-minted ids')

    // A TEXT slug is not an identity: two companies may honestly share one,
    // so no adoption happens without a matching recorded URL.
    const weak = await upsertCandidacy(root, {
      company: 'Globex',
      jobUrl: 'https://example.com/jobs/senior-engineer',
    })
    assert.equal(weak.created, true)
    const weakAgain = await upsertCandidacy(root, {
      company: 'Initech',
      jobUrl: 'https://other.example.com/careers/senior-engineer',
    })
    assert.equal(weakAgain.created, true, 'a shared text slug never merges two companies')
    assert.notEqual(weakAgain.path, weak.path)

    // A LEGACY twin — weak slug, no application.json — still heals: its
    // creation breadcrumb has carried "Job post: <url>" since the first
    // release, and that line speaks for the folder.
    const legacyWeak = join(root, 'acme', 'senior-engineer')
    await mkdir(legacyWeak, { recursive: true })
    await writeFile(
      join(legacyWeak, 'README.md'),
      '# Acme\n\nJob post: https://example.com/jobs/senior-engineer\n',
      'utf8',
    )
    const healedWeak = await upsertCandidacy(root, {
      company: 'Acme Corporation',
      jobUrl: 'https://example.com/jobs/senior-engineer',
    })
    assert.equal(healedWeak.created, false, 'the old README still identifies its folder')
    assert.equal(healedWeak.adoptedBy, 'url')
    assert.equal(healedWeak.path, legacyWeak)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ---- a name taken by ANOTHER posting never mixes two applications ----
{
  const root = await mkdtemp(join(tmpdir(), 'jobcv-clash-'))
  try {
    const first = await upsertCandidacy(root, {
      company: 'Acme',
      jobId: 'eng-2024',
      jobUrl: 'https://jobs.acme.com/111',
    })
    assert.equal(first.created, true)

    // Same company slug, same explicit id, genuinely different posting.
    const clash = await upsertCandidacy(root, {
      company: 'Acme',
      jobId: 'eng-2024',
      jobUrl: 'https://jobs.acme.com/222',
    })
    assert.equal(clash.created, true, 'a different posting is not silently merged')
    assert.notEqual(clash.path, first.path)
    assert.ok(clash.path.startsWith(join(root, 'acme', 'eng-2024-')))

    // The sibling name is stable, however the paste was dusted.
    const again = await upsertCandidacy(root, {
      company: 'Acme',
      jobId: 'eng-2024',
      jobUrl: 'https://jobs.acme.com/222?ref=x&utm_source=y',
    })
    assert.equal(again.created, false)
    assert.equal(again.adoptedBy, 'url')
    assert.equal(again.path, clash.path)

    // ...and the original posting still owns its folder.
    const original = await upsertCandidacy(root, {
      company: 'Acme',
      jobId: 'eng-2024',
      jobUrl: 'https://jobs.acme.com/111',
    })
    assert.equal(original.created, false)
    assert.equal(original.adoptedBy, 'exact')
    assert.equal(original.path, first.path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ---- the folder lock: concurrent mirrors serialize, stale locks yield ----
{
  const ws = await mkdtemp(join(tmpdir(), 'jobcv-lock-'))
  try {
    // Many writers to the SAME file name at once: every write completes,
    // latest.html ends valid, and the lock leaves with the last writer.
    const writes = []
    for (let i = 0; i < 25; i++) {
      writes.push(mirrorCvVersion(ws, 1, '<p>save ' + i + '</p>'))
    }
    const results = await Promise.all(writes)
    assert.equal(results.length, 25)
    const latest = await readFile(join(ws, 'cv', 'latest.html'), 'utf8')
    assert.ok(/^<p>save \d+<\/p>$/.test(latest), 'no torn read: ' + latest)
    let entries = await readdir(ws)
    assert.ok(!entries.includes('.lock'), 'the lock releases with the write')

    // An ABANDONED lock (a killed process) does not wedge the next write.
    const { mkdir: mkDir, utimes } = await import('node:fs/promises')
    await mkDir(join(ws, '.lock'))
    const past = new Date(Date.now() - 120000)
    await utimes(join(ws, '.lock'), past, past)
    const started = Date.now()
    await mirrorCvVersion(ws, 2, '<p>after stale</p>')
    assert.ok(Date.now() - started < LOCK_WAIT_MS, 'a stale lock is taken over, not waited out')
    const v2 = await readFile(join(ws, 'cv', 'v2.html'), 'utf8')
    assert.equal(v2, '<p>after stale</p>')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}

console.log('ok  workspace + intake')
