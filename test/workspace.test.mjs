import { strict as assert } from 'node:assert'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  slugify,
  jobSlugFromUrl,
  jobSlug,
  candidacyPath,
  upsertCandidacy,
  applicationsRoot,
} from '../lib/store/workspace.js'
import { saveIntakeFile, sanitizeFileName, INTAKE_LIMIT } from '../lib/store/intake.js'

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

  // applicationsRoot: env override wins, else under dshHome
  const prev = process.env.DSH_JOB_CV_ROOT
  try {
    process.env.DSH_JOB_CV_ROOT = '/custom/apps'
    assert.equal(applicationsRoot('/home/u'), '/custom/apps')
    delete process.env.DSH_JOB_CV_ROOT
    assert.equal(applicationsRoot('/home/u'), join('/home/u', 'dsh-job-cv', 'applications'))
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
    intakeDir,
    's1',
    'my cv.pdf',
    Buffer.from('hello').toString('base64'),
  )
  assert.equal(staged.bytes, 5)
  assert.equal(staged.path, join(intakeDir, 's1', 'my_cv.pdf'))
  const files = await readdir(join(intakeDir, 's1'))
  assert.deepEqual(files, ['my_cv.pdf'])

  // empty / invalid base64 is rejected
  await assert.rejects(saveIntakeFile(intakeDir, 's1', 'x.pdf', ''), /empty/)
  await assert.rejects(saveIntakeFile(intakeDir, 's1', 'x.pdf', '???'), /empty/)

  assert.equal(INTAKE_LIMIT, 12 * 1024 * 1024)
} finally {
  await rm(intakeDir, { recursive: true, force: true })
}

console.log('ok  workspace + intake')
