import { mkdir, writeFile, stat, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { jobCvBaseUrl } from '../http/http-utils.js'

const PRESET_ID = 'job'

/** Preset display metadata (id comes from the directory name). */
const PRESET_METADATA = `name: Job mode
description: CV tailoring mode — chat moves to a sidebar and the main layout becomes a live HTML-to-PDF CV preview the agent updates. Scope: tailor the user's CV against a job post link they provide.
order: 6
`

/**
 * The job agent composition. Copy of the shipped 'standard' preset with a
 * CV-tailoring persona and web fetch enabled so the agent can read the job
 * post link itself. Everything else stays standard so Job mode behaves like
 * a normal DSH mode.
 */
const PRESET_COMPOSITION = `# The 'job' agent preset (seeded by the dsh-job-cv plugin).
# Copy of the shipped 'standard' preset with a CV-tailoring persona and web
# fetch enabled for reading job posts.

# ── identity ────────────────────────────────────────────────────────────────

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a CV-tailoring agent powered by the {{model}} model. Your working directory is {{cwd}}.
      You help the user tailor their CV against a specific job post. The user provides a job post link (fetch
      and read it with the web tool) and their current CV. You rewrite the CV as a single self-contained
      HTML document sized for A4 print, save it through the /jobcv document routes, and the user sees the
      updated PDF-preview live in the main layout. Be concrete and truthful: never invent experience,
      employers, dates or credentials — reframe and re-emphasize what is really there. When the user asks
      for anything outside CV tailoring, answer briefly and steer back to the CV work.

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

# ── shell ───────────────────────────────────────────────────────────────────

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

# ── filesystem ──────────────────────────────────────────────────────────────

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

# ── background jobs ─────────────────────────────────────────────────────────

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

# ── skills ──────────────────────────────────────────────────────────────────

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'

# ── goals ───────────────────────────────────────────────────────────────────

- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'

# ── plan mode ───────────────────────────────────────────────────────────────

- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config:
        section: |
              You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

              Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

              The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

              Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

              Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

              When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects the plan, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.

# ── compaction ──────────────────────────────────────────────────────────────

- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024

# ── delegation and workflows ────────────────────────────────────────────────

- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'

    - id: tool-subagent-list-agents
      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        enableRunInBackground: true
        maxDepth: 2

    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
      config:
        provider: spawn

    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'

# ── remaining model-facing rows ─────────────────────────────────────────────

- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'

- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

# fetch:true lets the agent read the job post link the user provides.
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000
`

/** Resolve the harness home the way dsh-home-paths does: $DSH_HOME, else ~/.dsh. */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  return join(homedir(), '.dsh')
}

/**
 * Seed the job preset once; never clobber an existing directory.
 *
 * Staged in a temp directory and renamed into place: seeding straight into
 * the final path leaves a half-written (or empty) preset directory behind if
 * the host dies mid-write, and the existence check would then treat that
 * wreckage as user-owned forever. The rename also loses harmlessly against a
 * second host seeding concurrently.
 */
async function seedJobPreset() {
  const root = join(dshHome(), '.agent-presets')
  const dir = join(root, PRESET_ID)
  try {
    const existing = await stat(dir)
    if (existing.isDirectory()) return // user-owned now; leave it alone
  } catch {
    // missing — seed below
  }
  await mkdir(root, { recursive: true })
  const staging = join(root, '.' + PRESET_ID + '.seeding-' + randomUUID())
  try {
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'agent.cordis.yml'), PRESET_COMPOSITION, 'utf8')
    await writeFile(join(staging, 'preset.yml'), PRESET_METADATA, 'utf8')
    await rename(staging, dir)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    // ENOTEMPTY/EEXIST: someone else won the race — their preset is fine.
    if (error && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST')) return
    throw error
  }
  console.log('[dsh-job-cv] seeded job preset at ' + dir)
}

/** The agent-facing contract served at GET /jobcv/skill. */
function skillInstructions() {
  const base = jobCvBaseUrl()
  return [
    'JOB MODE — CV TAILORING CONTRACT (dsh-job-cv)',
    '',
    'The user is in Job mode. The web GUI shows the chat as a sidebar and a',
    'live CV preview as the main layout. You update that preview through the',
    'document routes below; the user sees every save within a few seconds.',
    '',
    'Workflow:',
    '  1. Collect the two inputs: the job post LINK (fetch it with the web',
    '     tool and extract the real requirements) and the CURRENT CV (pasted',
    '     text, a file in the workspace, or a previous document). If either',
    '     is missing, ask for it before writing anything.',
    '  2. GET ' + base + '/jobcv/doc?session=<sessionId> — the current',
    '     document (html, jobUrl, version) or an empty shell.',
    '  3. Tailor the CV and POST the FULL replacement document. The web',
    '     tool only reads, so save with the shell. Write the JSON body to a',
    '     temp file first — a CV document is far too long for a safe inline',
    '     argument — and send it with an explicit JSON content type:',
    '',
    '       curl -sS -X POST ' + base + '/jobcv/doc \\',
    '            -H "Content-Type: application/json" \\',
    '            --data-binary @/tmp/cv-save.json',
    '',
    '     where /tmp/cv-save.json holds:',
    '       {"sessionId": "<sessionId>", "html": "<full html document>",',
    '        "jobUrl": "<the job post link>"}',
    '',
    '     The Content-Type header is REQUIRED. Without it curl sends',
    '     application/x-www-form-urlencoded, which the host rejects as a',
    '     cross-site-forgery risk and you get: {"error":"untrusted request"}.',
    '     A success looks like {"ok":true,"version":N}.',
    '',
    'Document rules:',
    '  - One complete self-contained HTML document (doctype, html, head,',
    '    body). No external stylesheets, fonts, images or scripts: the',
    '    preview is a sandboxed iframe and the PDF is printed from it.',
    '  - Sized for A4 print: include <style>@page{size:A4;margin:0}</style>',
    '    and lay the content out in A4 pages (210mm wide; use padding for',
    '    margins, not @page margins). One to two pages is the target.',
    '  - Inline CSS only, print-friendly colors (no big ink-bleeding',
    '    backgrounds), and clean typographic hierarchy.',
    '  - Truthful tailoring only: re-order, reframe and re-emphasize real',
    '    experience against the job requirements. Never invent employers,',
    '    dates, titles, metrics or credentials.',
    '  - Every save replaces the document wholesale. Bump nothing yourself —',
    '    the host assigns the version number.',
    '',
    'Marked-up revision requests:',
    '  The preview lets the user click a line in the CV and say what is wrong',
    '  with it. That arrives in the chat as a numbered list, each entry',
    '  carrying the section, a CSS-ish path and the exact current text:',
    '',
    '    1. In section "Experience" — div.page > div.item > ul > li:nth-of-type(1)',
    '       Current text: "Shipped a thing"',
    '       What is needed: Quantify with real numbers',
    '',
    '  Locate each spot by its quoted text first and fall back to the path',
    '  when that text repeats. An entry may say it was marked on an older',
    '  version — re-read the current document before editing, because your',
    '  own later save may have already moved or reworded that text.',
    '  Apply every entry in ONE new document, save it once, and then answer',
    '  with advice, not just a changelog: for each edit say whether it',
    '  genuinely strengthens the CV against this job post, and refuse the',
    '  ones that would overstate what the CV supports — offer the strongest',
    '  truthful wording instead. The user asked for judgement, not obedience.',
    '',
    'After each save, tell the user in one or two sentences what changed and',
    'suggest the next refinement. The user exports the PDF from the preview',
    'toolbar (browser print dialog, "Save as PDF").',
  ].join('\n')
}

/** Seed the /job skill bridge once; never clobber an existing file. */
async function seedJobSkill() {
  const file = join(dshHome(), 'skills', 'job.md')
  const base = jobCvBaseUrl()
  const body = `---
name: job
description: Work in Job mode — tailor the user's CV against a job post link into the live HTML-to-PDF CV preview. Invoke when the user starts job-mode CV work, provides a job post link or current CV, or asks to update the preview/PDF.
---

This skill drives the CV document preview of the dsh-job-cv plugin.
The instructions are served by the plugin so they never drift from it.
Read them first and follow them exactly:

    web_fetch ${base}/jobcv/skill

If that fetch fails, the plugin host is not running — tell the user to
restart \`dsh web\` and try again.
`
  await mkdir(join(dshHome(), 'skills'), { recursive: true })
  try {
    // 'wx' is the atomic version of stat-then-write: it never clobbers a
    // file the user has since edited, and has no window in between.
    await writeFile(file, body, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error && error.code === 'EEXIST') return // user-owned now
    throw error
  }
  console.log('[dsh-job-cv] seeded job skill at ' + file)
}

export {
  PRESET_ID,
  PRESET_METADATA,
  PRESET_COMPOSITION,
  dshHome,
  seedJobPreset,
  seedJobSkill,
  skillInstructions,
}
