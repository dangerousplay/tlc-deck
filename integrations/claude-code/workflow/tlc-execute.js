export const meta = {
  name: 'tlc-execute',
  description: 'Execute a tlc-spec-driven tasks.md with configurable models per role (orchestrator, implementer, reviewer, advisor); one commit per task; reports live progress through `tlc emit` when tlc is installed',
  whenToUse: 'After Specify/Design/Tasks for a Large/Complex feature. args: {feature: "<name>"} or {tasks: ".specs/features/x/tasks.md"}; optional {repo: "/abs/path" (when not the session cwd), only: ["T1"], retries: 1, commit: true, roles: {implementer: "sonnet", reviewer: {model: "sonnet", effort: "high"}, advisor: "opus" | false, orchestrator: "haiku"}}. Config files (lower precedence than args): .specs/tlc-execute.json in the repo, then ~/.claude/tlc-execute.json',
  phases: [
    { title: 'Load', detail: 'orchestrator role parses tasks.md and the role config' },
    { title: 'Implement', detail: 'implementer role (spec-implementer) per task, [P] tasks in parallel' },
    { title: 'Verify', detail: 'reviewer role (spec-reviewer) checks Done-when + gate' },
    { title: 'Advise', detail: 'advisor role diagnoses a rejected or blocked task before the retry' },
    { title: 'Commit', detail: 'orchestrator role makes one atomic commit per task' },
  ],
}

// ---------- roles ----------
// A role is a model alias ("haiku" | "sonnet" | "opus" | "fable" | full id | "inherit")
// or {model, effort}. "inherit" (or no model) uses the session model.
// advisor: false disables the advisor stage.
const DEFAULT_ROLES = {
  orchestrator: { model: 'haiku', effort: 'low' },
  implementer: { model: 'sonnet' },
  reviewer: { model: 'sonnet' },
  advisor: { model: 'opus', effort: 'high' },
}

const a = args || {}
const TASKS_PATH = a.tasks || (a.feature ? `.specs/features/${a.feature}/tasks.md` : null)
// Target repo when it differs from the session's cwd: every agent prompt starts with it.
const REPO = a.repo || null
const PRE = REPO
  ? `Repository: ${REPO}. Run every shell command from that directory (cd "${REPO}" first), resolve relative paths against it, and commit only there.\n\n`
  : ''
const ag = (prompt, o) => agent(PRE + prompt, o)
if (!TASKS_PATH) throw new Error('Pass args {feature: "<name>"} or {tasks: "<path to tasks.md>"}')

function norm(v) {
  if (v === false || v === null) return false
  if (typeof v === 'string') return { model: v }
  if (v && typeof v === 'object') return { ...v }
  return undefined
}
function merge(...layers) {
  const out = {}
  for (const role of Object.keys(DEFAULT_ROLES)) {
    let r = { ...DEFAULT_ROLES[role] }
    for (const layer of layers) {
      const v = norm(layer && layer[role])
      if (v === false) r = false
      else if (v) r = r === false ? v : { ...r, ...v }
    }
    out[role] = r
  }
  return out
}
// agent() options for a role: omit model for "inherit".
function opts(role, extra) {
  const r = ROLES[role] || {}
  const o = { ...extra }
  if (r.model && r.model !== 'inherit') o.model = r.model
  if (r.effort) o.effort = r.effort
  return o
}

// The orchestrator's own model can only come from args (it reads the config files).
let ROLES = merge(a.roles)

const TASK_LIST = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' } },
          parallel: { type: 'boolean', description: 'true if marked [P]' },
          done: { type: 'boolean', description: 'true if already complete in tasks.md (Status: Done, or every Done-when box checked)' },
        },
        required: ['id', 'title', 'depends_on', 'parallel', 'done'],
      },
    },
    project_config: { type: 'string', description: 'verbatim contents of .specs/tlc-execute.json, or empty string if absent' },
    user_config: { type: 'string', description: 'verbatim contents of ~/.claude/tlc-execute.json, or empty string if absent' },
    run_id: { type: 'string', description: 'run id printed by `tlc emit --start`, or empty string if tlc is unavailable or failed' },
  },
  required: ['tasks', 'project_config', 'user_config', 'run_id'],
}

const IMPL = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['Complete', 'Blocked', 'Partial'] },
    files_changed: { type: 'array', items: { type: 'string' } },
    gate: { type: 'string', description: 'pass|fail + command + test counts' },
    spec_deviations: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'files_changed', 'gate', 'spec_deviations', 'issues'],
}

const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'problems'],
}

const ADVICE = {
  type: 'object',
  properties: {
    diagnosis: { type: 'string', description: 'root cause in 1-3 sentences' },
    environmental: { type: 'boolean', description: 'true if the failure is the environment (sockets, network, tooling), not the code' },
    steps: { type: 'array', items: { type: 'string' }, description: 'concrete fix steps for the implementer, file:line where possible' },
  },
  required: ['diagnosis', 'environmental', 'steps'],
}

// ---------- progress reporting (tlc emit) ----------
// The script cannot write files or run commands; the agents it already runs do, through `tlc emit`.
// Every helper returns '' when there is no run id (tlc missing), so prompts stay unchanged.
const FEATURE = a.feature || TASKS_PATH.split('/').slice(-2, -1)[0] || ''
let RUN_ID = ''
const q = o => JSON.stringify(o)
function emitCmd(source, type, body, name) {
  return `tlc emit ${type} '${q(body)}' --run ${RUN_ID} --feature ${FEATURE} --harness claude-code --driver workflow --source ${source}${name ? ` --name ${name}` : ''}`
}
const custom = (source, name, value) => emitCmd(source, 'CUSTOM', { value }, name)
const step = (source, type, t, stage) => emitCmd(source, type, { stepName: `${t.id}:${stage}` })
function progress(lines) {
  if (!RUN_ID) return ''
  return `\n\nProgress reporting: run the following with Bash. Do it as one Bash call at the start for the "start" commands and one Bash call at the end for the "end" commands. Replace <angle-bracket> placeholders with real values. If the \`tlc\` command is missing or fails, skip silently and never let it change your result.\n${lines.join('\n')}`
}
const start = cmds => ['Start:', ...cmds]
const end = cmds => ['End:', ...cmds]

phase('Load')
const loadInput = { tasksPath: TASKS_PATH, harness: 'claude-code', ...(a.only ? { only: a.only } : {}), ...(a.roles ? { roles: a.roles } : {}) }
const parsed = await ag(
  `Read ${TASKS_PATH}. List every task with its id, title, dependencies (task ids), whether it is marked [P] (parallel-safe), and whether it is already complete. Do not summarize task bodies.
If the \`tlc\` command is on PATH, get the task list from \`tlc plan --feature ${FEATURE} --json\` instead of parsing the file by hand (dependsOn -> depends_on; done flag as given); otherwise parse the file as described.
Also return the verbatim text of these files if they exist (empty string if not): ".specs/tlc-execute.json" (relative to the repo root) as project_config, and "~/.claude/tlc-execute.json" as user_config.

Progress reporting (only if \`tlc\` is on PATH; otherwise skip and return run_id as an empty string; never let a failure change your result):
1. Start a run: \`tlc emit --start '{"input":${q(loadInput)}}' --feature ${FEATURE} --harness claude-code --driver workflow --source orchestrator\`. It prints the run id; return it as run_id. Before running it, inspect your shell environment (\`env\`) and add an "env" object to the input recording variables that may identify this workflow run or session: name matching CLAUDE_*, WORKFLOW*, or containing RUN_ID / SESSION / AGENT. Give the value for names starting with CLAUDE_ or WORKFLOW; for every other matching name give only the name (value null). Never record credentials or tokens.
2. Emit the plan: \`tlc emit CUSTOM '{"value": <the JSON printed by tlc plan --json, verbatim>}' --run <run_id> --feature ${FEATURE} --harness claude-code --driver workflow --source orchestrator --name tlc.plan\`.`,
  opts('orchestrator', { label: 'parse tasks.md', phase: 'Load', schema: TASK_LIST }),
)
RUN_ID = (parsed && parsed.run_id) || ''
function parseCfg(text, where) {
  if (!text || !text.trim()) return {}
  try { return JSON.parse(text) } catch (e) { log(`ignoring ${where}: invalid JSON (${e.message})`); return {} }
}
const userCfg = parseCfg(parsed.user_config, '~/.claude/tlc-execute.json')
const projCfg = parseCfg(parsed.project_config, '.specs/tlc-execute.json')
ROLES = merge(userCfg.roles, projCfg.roles, a.roles)
const RETRIES = a.retries ?? projCfg.retries ?? userCfg.retries ?? 1
const COMMIT = a.commit ?? projCfg.commit ?? userCfg.commit ?? true
const show = r => (r === false ? 'off' : `${r.model || 'inherit'}${r.effort ? `/${r.effort}` : ''}`)
log(`roles: ${Object.entries(ROLES).map(([k, v]) => `${k}=${show(v)}`).join(', ')}; retries=${RETRIES}; commit=${COMMIT}`)

let tasks = parsed.tasks.filter(t => !t.done)
if (a.only) tasks = tasks.filter(t => a.only.includes(t.id))
log(`${tasks.length} pending task(s) in ${TASKS_PATH}`)

const doneIds = new Set(parsed.tasks.filter(t => t.done).map(t => t.id))
const results = []

async function advise(t, base, impl, verdict, n) {
  if (ROLES.advisor === false) return null
  const what = verdict && !verdict.pass
    ? `The reviewer rejected it:\n- ${verdict.problems.join('\n- ')}`
    : `The implementer reported ${impl?.status ?? 'no result'}:\n- ${(impl?.issues ?? []).join('\n- ')}`
  return ag(
    `${base}\nYou are the advisor. Do not edit files. ${what}\nImplementer gate: ${impl?.gate ?? '-'}. Files changed: ${(impl?.files_changed ?? []).join(', ') || 'none'}.\nRead the code and the failing output (re-run the gate command if useful) and give the implementer a diagnosis and concrete fix steps. Say whether the failure is environmental.${progress([
      ...start([custom('advisor', 'tlc.task', { id: t.id, status: 'advising', stage: 'advise', attempt: n }), step('advisor', 'STEP_STARTED', t, 'advise')]),
      ...end([step('advisor', 'STEP_FINISHED', t, 'advise')]),
    ])}`,
    opts('advisor', { label: `advise ${t.id}`, phase: 'Advise', agentType: 'Plan', schema: ADVICE }),
  )
}
const adviceText = adv => adv
  ? `\nAdvisor diagnosis: ${adv.diagnosis}${adv.environmental ? ' (environmental: fix or work around the environment, do not change unrelated code)' : ''}\nAdvisor steps:\n- ${adv.steps.join('\n- ')}`
  : ''

const implProgress = (t, stage, n) => progress([
  ...start([custom('implementer', 'tlc.task', { id: t.id, status: 'running', stage, attempt: n }), step('implementer', 'STEP_STARTED', t, stage)]),
  ...end([
    custom('implementer', 'tlc.task', { id: t.id, status: '<review if Complete, blocked if Blocked, running if Partial>', stage, attempt: n, files: '<files_changed>', gate: { pass: '<true|false>', summary: '<gate>' }, deviations: '<spec_deviations, omit if none>' }),
    `If your status is Blocked or Partial also run: ${custom('implementer', 'tlc.blocker', { id: `${t.id}-${stage}-${n}`, task: t.id, kind: '<blocked|partial>', reason: '<issues, one line>' })}`,
    step('implementer', 'STEP_FINISHED', t, stage),
  ]),
])
const reviewProgress = (t, n) => progress([
  ...start([custom('reviewer', 'tlc.task', { id: t.id, status: 'review', stage: 'verify', attempt: n }), step('reviewer', 'STEP_STARTED', t, 'verify')]),
  ...end([
    `If you reject (pass=false) also run: ${custom('reviewer', 'tlc.blocker', { id: `${t.id}-rejected-${n}`, task: t.id, kind: 'rejected', reason: '<problems, one line>' })}`,
    step('reviewer', 'STEP_FINISHED', t, 'verify'),
  ]),
])

async function runTask(t, mayCommit) {
  const base = `Task ${t.id} ("${t.title}") from ${TASKS_PATH}. Read that task block and the spec/design it references in the same feature folder.`
  const noCommit = mayCommit ? 'Do not commit; the workflow commits.' : 'Do not commit.'
  let n = 1
  let impl = await ag(
    `${base}\nImplement it. ${noCommit}${implProgress(t, 'implement', n)}`,
    opts('implementer', { label: `impl ${t.id}`, phase: 'Implement', agentType: 'spec-implementer', schema: IMPL }),
  )
  // One advised retry for a Blocked/Partial implementation.
  if (impl && impl.status !== 'Complete' && ROLES.advisor !== false) {
    const adv = await advise(t, base, impl, null, n)
    if (adv) {
      n++
      impl = await ag(
        `${base}\nYour previous attempt ended ${impl.status}. Continue from the current working tree.${adviceText(adv)}\n${noCommit}${implProgress(t, 'implement', n)}`,
        opts('implementer', { label: `impl ${t.id} (advised)`, phase: 'Implement', agentType: 'spec-implementer', schema: IMPL }),
      )
    }
  }
  if (!impl || impl.status === 'Blocked') return { task: t, impl, verdict: null, ok: false }

  let verdict = null
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    verdict = await ag(
      `${base}\nFiles changed: ${impl.files_changed.join(', ')}. Implementer gate: ${impl.gate}. Verify it.${reviewProgress(t, n)}`,
      opts('reviewer', { label: `verify ${t.id}${attempt ? ` #${attempt + 1}` : ''}`, phase: 'Verify', agentType: 'spec-reviewer', schema: VERDICT }),
    )
    if (!verdict || verdict.pass || attempt === RETRIES) break
    const adv = await advise(t, base, impl, verdict, n)
    n++
    impl = await ag(
      `${base}\nA reviewer rejected your implementation. Fix ONLY these problems:\n- ${verdict.problems.join('\n- ')}${adviceText(adv)}\n${noCommit}${implProgress(t, 'fix', n)}`,
      opts('implementer', { label: `fix ${t.id}`, phase: 'Implement', agentType: 'spec-implementer', schema: IMPL }),
    )
    if (!impl || impl.status === 'Blocked') break
  }
  return { task: t, impl, verdict, ok: !!(impl && impl.status === 'Complete' && verdict && verdict.pass) }
}

// Dependency waves. Within a wave, [P] tasks run concurrently; non-[P] tasks run one at a time.
let pending = tasks.slice()
let stop = false
while (pending.length && !stop) {
  const ready = pending.filter(t => t.depends_on.every(d => doneIds.has(d) || !parsed.tasks.some(x => x.id === d)))
  if (!ready.length) {
    log(`Stopped: unmet dependencies for ${pending.map(t => t.id).join(', ')}`)
    break
  }
  const par = ready.filter(t => t.parallel)
  const seq = ready.filter(t => !t.parallel)
  const wave = []
  if (par.length) wave.push(...(await parallel(par.map(t => () => runTask(t, COMMIT)))).filter(Boolean))
  for (const t of seq) {
    const r = await runTask(t, COMMIT)
    wave.push(r)
    if (!r.ok) break // later sequential tasks in this wave may depend on it implicitly
  }
  if (wave.length < ready.length && wave.every(r => r.ok)) { log('An implementer crashed; stopping'); stop = true }

  // Commit sequentially to avoid git index races between parallel implementers.
  for (const r of wave) {
    results.push(r)
    if (!r.ok) { stop = true; continue }
    doneIds.add(r.task.id)
    const t = r.task
    if (COMMIT && r.impl.files_changed.length) {
      await ag(
        `Create one git commit containing ONLY these files: ${r.impl.files_changed.join(' ')}. Use \`git add -- <files>\` then commit with a Conventional Commits message for task ${r.task.id}: "${r.task.title}". Do not touch other files. Reply with the commit hash.${progress([
          ...start([step('orchestrator', 'STEP_STARTED', t, 'commit')]),
          ...end([
            custom('orchestrator', 'tlc.task', { id: t.id, status: 'done', stage: 'commit', commit: '<commit sha>', files: r.impl.files_changed }),
            step('orchestrator', 'STEP_FINISHED', t, 'commit'),
          ]),
        ])}`,
        opts('orchestrator', { label: `commit ${r.task.id}`, phase: 'Commit' }),
      )
    } else if (RUN_ID) {
      await ag(
        `Run this one Bash command (skip silently if the \`tlc\` command is missing or fails), then reply "ok": ${custom('orchestrator', 'tlc.task', { id: t.id, status: 'done', files: r.impl.files_changed })}`,
        opts('orchestrator', { label: `report ${t.id}`, phase: 'Commit' }),
      )
    }
  }
  pending = pending.filter(t => !wave.some(r => r.task.id === t.id))
  if (stop) log('Stopped after a failed/blocked task; fix or re-plan, then rerun with {only: [...]}')
}

const result = {
  tasks_path: TASKS_PATH,
  roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, show(v)])),
  completed: results.filter(r => r.ok).map(r => r.task.id),
  failed: results.filter(r => !r.ok).map(r => ({
    id: r.task.id,
    status: r.impl?.status ?? 'no result',
    issues: r.impl?.issues ?? [],
    review_problems: r.verdict?.problems ?? [],
  })),
  not_started: pending.map(t => t.id),
  spec_deviations: results.flatMap(r => (r.impl?.spec_deviations ?? []).map(d => `${r.task.id}: ${d}`)),
  gates: results.map(r => `${r.task.id}: ${r.impl?.gate ?? '-'}`),
}

// Close the run: mark failed tasks and emit RUN_FINISHED (one agent, one Bash call).
if (RUN_ID) {
  const failedCmds = result.failed.map(f => custom('orchestrator', 'tlc.task', { id: f.id, status: f.status === 'Blocked' ? 'blocked' : 'failed' }))
  const finished = emitCmd('orchestrator', 'RUN_FINISHED', {
    result: { completed: result.completed, failed: result.failed.map(f => f.id), notStarted: result.not_started, deviations: result.spec_deviations },
  })
  await ag(
    `Run these commands with Bash, in order (skip silently if the \`tlc\` command is missing or fails), then reply "ok":\n${[...failedCmds, finished].join('\n')}`,
    opts('orchestrator', { label: 'finish run', phase: 'Commit' }),
  )
}

return result
