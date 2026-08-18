import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The persona and the one thing that decides whether a persona change ever
// reaches anyone: an install that already has the preset. "Seed once, never
// touch again" meant the file on disk stayed whatever the first boot wrote.
const home = await mkdtemp(join(tmpdir(), 'dsh-job-cv-preset-'))
process.env.DSH_HOME = home
const { PRESET_COMPOSITION, PRIOR_SEEDED, seedJobPreset, refreshSeededPreset } =
  await import('../lib/preset/preset-seed.js')

const dir = join(home, '.agent-presets', 'job')
const file = join(dir, 'agent.cordis.yml')
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

// ---- the agent in the chat ----
// Job mode is a candidate-side strategist, not a formatter with opinions.
assert.ok(PRESET_COMPOSITION.includes('You are Close'), 'the persona is Close')
assert.ok(
  PRESET_COMPOSITION.includes('candidate-side career strategist'),
  'working for the candidate, never the employer',
)
assert.ok(
  !/\btech and IT professionals\b/.test(PRESET_COMPOSITION),
  'the persona is not bound to one industry — it calibrates to the job post',
)
for (const rule of [
  'Never invent experience',
  'carries provenance',
  'No outcome guarantees',
  'separate markets',
  'Next move:',
]) {
  assert.ok(PRESET_COMPOSITION.includes(rule), 'hard rule kept: ' + rule)
}
// The mechanics the mode cannot work without survive the persona rewrite.
assert.ok(PRESET_COMPOSITION.includes('{{model}}'), 'the model template var still expands')
assert.ok(PRESET_COMPOSITION.includes('{{cwd}}'), 'the cwd template var still expands')
assert.ok(
  PRESET_COMPOSITION.includes('CV-tailoring agent'),
  'the CV-tailoring brief lives in the persona itself, not only in the contract',
)
assert.ok(PRESET_COMPOSITION.includes('never invent experience, employers, dates or credentials'))
assert.ok(PRESET_COMPOSITION.includes('steer back'), 'and out-of-scope asks steer back to the work')
assert.ok(PRESET_COMPOSITION.includes('/jobcv/skill'), 'the agent is pointed at the contract')
assert.ok(PRESET_COMPOSITION.includes('/jobcv/proposal'), 'wording still goes through review')
assert.ok(PRESET_COMPOSITION.includes('no web_fetch tool'), 'and it is told to curl the post')
// The cover letter craft lives in the persona, not only in the contract: how
// a letter is WRITTEN is strategy, and the strategist is Close.
for (const rule of [
  '# THE COVER LETTER',
  'Lead with THEM, not you',
  '250-400 words',
  'To Whom It May Concern',
  'Show, don',
  'Active voice',
  'Why Them',
  'Regurgitate the CV',
  'Clichés',
  'Apologize for missing experience',
]) {
  assert.ok(PRESET_COMPOSITION.includes(rule), 'cover letter rule kept: ' + rule)
}
// ...and so does its layout: a letter that reads as a wall of text gets skipped.
for (const rule of [
  'Layout — the page must read as clean',
  '25mm',
  'never justify',
  '10-12pt',
  'matches the CV',
  'no text boxes',
  'Strictly one page',
  'Firstname_Lastname_Cover_Letter.pdf',
]) {
  assert.ok(PRESET_COMPOSITION.includes(rule), 'cover letter layout rule kept: ' + rule)
}
// A folded scalar would join these lines into one paragraph and the headings
// would dissolve; the persona is markdown and must arrive as markdown.
assert.ok(/text: \|-/.test(PRESET_COMPOSITION), 'the persona is a LITERAL block scalar')
assert.ok(
  PRESET_COMPOSITION.includes('\n      # HARD RULES\n'),
  'its headings survive on own lines',
)

// ---- first boot seeds ----
await seedJobPreset()
assert.equal(await readFile(file, 'utf8'), PRESET_COMPOSITION, 'a fresh home gets the composition')

// ---- the receipt: the plugin records what it wrote ----
// Receipts exist because the upgrade chain once depended on someone
// remembering to append a hash to a list: a refreshed install's file was no
// longer recognised as plugin output, and the next version reported it as
// "local edits" forever. The receipt is written on every seed and refresh,
// and the file is claimed by it — no list, no memory.
const receiptFile = join(home, 'dsh-job-cv', 'preset-seed.json')
assert.equal(
  JSON.parse(await readFile(receiptFile, 'utf8')).agentCordisSha256,
  sha(PRESET_COMPOSITION),
  'seeding records what it wrote',
)

// An older plugin's output is claimed by its receipt, not by any list.
const prior = '# an older shipped composition\n'
await writeFile(file, prior, 'utf8')
await writeFile(receiptFile, JSON.stringify({ agentCordisSha256: sha(prior) }), 'utf8')
await seedJobPreset()
assert.equal(
  await readFile(file, 'utf8'),
  PRESET_COMPOSITION,
  'the receipt alone claims plugin output',
)
assert.equal(
  JSON.parse(await readFile(receiptFile, 'utf8')).agentCordisSha256,
  sha(PRESET_COMPOSITION),
  'and the refresh leaves the new receipt behind',
)

// ---- an untouched preset from before receipts existed is still claimable ----
await writeFile(file, prior, 'utf8')
await refreshSeededPreset(dir, [sha(prior)])
assert.equal(
  await readFile(file, 'utf8'),
  PRESET_COMPOSITION,
  'output this plugin wrote is refreshed — otherwise a persona change reaches nobody',
)

// ---- an edited preset is the user's, and stays theirs ----
const edited = PRESET_COMPOSITION + '\n# my own row\n'
await writeFile(file, edited, 'utf8')
await seedJobPreset()
assert.equal(await readFile(file, 'utf8'), edited, 'one edited byte and the file is untouchable')

// ---- and a second boot on a current preset changes nothing ----
await writeFile(file, PRESET_COMPOSITION, 'utf8')
await seedJobPreset()
assert.equal(await readFile(file, 'utf8'), PRESET_COMPOSITION)

// The hashes of the compositions shipped before the receipt must stay
// claimable: dropping one strands every install seeded from it. The
// first-Close hash is the one an earlier refresh wrote — it predates the
// receipt, so the list is the only thing that recognises it.
for (const pinned of [
  '7631c5960a15b7c6f522a5a03f94cc4d0976fbf50986a62f51ad4d3fe010b776',
  '8bd5e126cf57d7098fc22f52a9a6f1f96decce48908686ea9340ba9e61f931bf',
]) {
  assert.ok(PRIOR_SEEDED.includes(pinned), 'a pre-receipt composition stays claimable: ' + pinned)
}

await rm(home, { recursive: true, force: true })
console.log('ok  preset persona + refresh of an unedited seed')
