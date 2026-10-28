import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TestResult } from '../types'

// One shell word: unquoted characters, \-escapes, 'single-quoted' and "double-quoted" parts, run together
const WORD = String.raw`(?:[^\s;&|()<>'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+`
const PART = /'[^']*'|"(?:[^"\\]|\\.)*"|(?:[^'"\\]|\\.)+/g
// `git push` as a command: at the start or after ; & | ( or a newline, with options allowed before
// `push` (`git -C dir push`); the words inside a string or a heredoc do not count. Group 1 holds the
// `cd dir &&` (or `cd dir;`) commands just before it, group 2 the options between `git` and `push`
const GIT_PUSH = new RegExp(
  String.raw`(?:^|[;&|(\n])\s*((?:cd\s+${WORD}\s*(?:&&|;|\n)\s*)*)git((?:\s+-\S+(?:\s+(?!-)${WORD})?)*)\s+push\b`,
)
const CD = new RegExp(String.raw`cd\s+(${WORD})`, 'g')
const OPTION = new RegExp(WORD, 'g')
// Lines test runners print for a failing test (node:test, jest, tap, mocha, this repo's runner)
const FAILED_LINE = /✖|✗|✕|\bnot ok\b|\bFAIL\b|\bfailing\b|\bfailed\b/i
// A runner's summary count, e.g. "2 failing" or "3 failed"
const FAILED_COUNT = /(\d+) (?:failing|failed)\b/i
// One line per failing test, without summary lines
const FAILED_TEST = /✖|✗|✕|\bnot ok\b/

// The `test` script `npm init` writes, which only prints an error
const NO_TEST_SPECIFIED = /no test specified/
// The scripts a project with no `test` script is checked with instead, in this order; `checks: all` adds build
const CHECKS = ['typecheck', 'type-check', 'tsc', 'lint', 'check', 'format:check']
const NOTHING = 'push-guard: nothing was checked: this project has no test, typecheck or lint script'

// A test file: *.test.*, *.spec.*, *_test.*, test_*.py, test.js, or anything in a test/, tests/, spec/,
// specs/, __tests__/ or __snapshots__/ folder. A project adds its own in package.json: "pushGuard": { "testFiles": [globs] }
const TEST_FILE = /(?:^|\/)(?:tests?|specs?|__tests__|__snapshots__)\/|(?:^|[\/._-])(?:test|spec)s?\.[a-z0-9]+$|(?:^|\/)test_[^/]*\.py$/i
// Where a command a person ran comes from: the prompt, the app, or a press in the UI
const PERSON = ['composer', 'bridge', 'person']
// git's empty tree: on a first push every commit is new, so the diff runs from nothing
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const last = atom({ plugin: 'push-guard', key: 'last' } as const, null)
// The commit a push was held at for changed tests, and the one you allowed with /push-guard allow
const held = atom({ plugin: 'push-guard', key: 'held' } as const, null)
const allowed = atom({ plugin: 'push-guard', key: 'allowed' } as const, null)

// package.json, or undefined when there is none or npm could not read it either
async function readPackage(read: () => Promise<string>): Promise<any> {
  try {
    return JSON.parse(await read())
  } catch {
    return undefined
  }
}

// Whether package.json has a `test` script that runs tests
function hasTests(pkg: any): boolean {
  const test = pkg?.scripts?.test
  return typeof test === 'string' && test.trim() !== '' && !NO_TEST_SPECIFIED.test(test)
}

// The check scripts package.json has, for a project with no `test` script. Anything but `all` (a typo too)
// is `auto`, so a slip in the option does not turn the checks off; `off` is handled before this
function checkScripts(pkg: any, options: any): string[] {
  const names = String(options?.checks ?? '').trim().toLowerCase() === 'all' ? [...CHECKS, 'build'] : CHECKS
  return names.filter(name => typeof pkg?.scripts?.[name] === 'string' && pkg.scripts[name].trim() !== '')
}

// npm's answer for a script package.json does not have (npm 7+ and older), which is not a failing check
const missingScript = (script: string) =>
  new RegExp(`^npm (?:error|ERR!) missing script: "?${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?$`, 'i')

// A glob from package.json as a pattern: * and ? stay in one folder, ** crosses folders
const glob = (text: string) =>
  new RegExp(`(?:^|/)${text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')}(?:$|/)`)

// git in the project being pushed: its output, or undefined when git failed
const gitIn = ($: any, cwd: string | undefined) => async (...args: string[]) => {
  const { exitCode, stdout } = await $.process.run(['git', ...args], cwd === undefined ? {} : { cwd })
  return exitCode === 0 ? stdout : undefined
}

// What the push holds: HEAD, and where HEAD left the upstream (or, on a new branch, the remote's default
// branch), or git's empty tree on a first push. Undefined when there is no commit
async function pushRange(git: ReturnType<typeof gitIn>) {
  const head = (await git('rev-parse', 'HEAD'))?.trim()
  if (!head) return undefined
  let base = EMPTY_TREE
  for (const ref of ['@{upstream}', 'origin/HEAD', 'origin/main', 'origin/master']) {
    const found = (await git('merge-base', ref, 'HEAD'))?.trim()
    if (found) { base = found; break }
  }
  return { head, base }
}

// The test files the commits being pushed change: from where HEAD left the upstream (or, on a new branch,
// the remote's default branch) to HEAD. `changed` lost lines or were deleted or renamed, which is how a
// failing test is made to pass; `added` are new files or only gained lines. Undefined when git can't say
async function testChanges($: any, cwd: string | undefined, extra: RegExp[]) {
  const git = gitIn($, cwd)
  try {
    const range = await pushRange(git)
    if (!range) return undefined
    const { head, base } = range
    const diff = await git('diff', '--numstat', '--no-renames', '-z', base, head)
    if (diff === undefined) return undefined
    const changed: string[] = []
    const added: string[] = []
    for (const line of diff.split('\0')) {
      const match = /^(\d+|-)\t(\d+|-)\t([^]+)$/.exec(line) // with -z a path may hold any character
      if (!match || !(TEST_FILE.test(match[3]) || extra.some(re => re.test(match[3])))) continue
      // A path is shown to Claude, so it gets no newlines or other control characters to hide lines in
      ;(match[2] === '0' ? added : changed).push(JSON.stringify(match[3]))
    }
    return { head, changed, added }
  } catch {
    return undefined // no git to ask: the push itself will say
  }
}

// A path is absolute from / (or a Windows drive); cd and git -C replace the folder with it
const isAbsolute = (path: string) => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)
const join = (from: string, to: string) => `${from.replace(/[\\/]+$/, '')}/${to}`

// A word as the shell passes it on, or undefined when only the shell can say: a variable, a command's
// output, a wildcard, or `~` (the mod API does not give the home folder)
function unquote(word: string): string | undefined {
  if (word.startsWith('~')) return undefined
  let text = ''
  for (const [part] of word.matchAll(PART)) {
    if (part.startsWith("'")) text += part.slice(1, -1)
    else if (/[$`]/.test(part)) return undefined
    else if (part.startsWith('"')) text += part.slice(1, -1).replace(/\\([$`"\\])/g, '$1')
    else if (/[*?[{]/.test(part)) return undefined
    else text += part.replace(/\\(.)/g, '$1')
  }
  return text
}

// The folder `git push` in the command runs in, from the `cd dir &&` just before it and its `-C dir`
// options, each taken from the one before as git and the shell do. Undefined means the session's
// folder, also when the folder cannot be told from the command; a relative path is from the session's folder
function pushFolder(command: string): string | undefined {
  const match = GIT_PUSH.exec(command)
  if (!match) return undefined
  const dirs = [...match[1].matchAll(CD)].map(([, dir]) => dir)
  if (dirs.some(dir => dir.startsWith('-'))) return undefined // `cd -` and cd's own options
  const options = match[2].match(OPTION) ?? []
  for (let i = 0; i < options.length - 1; i++) if (options[i] === '-C') dirs.push(options[++i])

  let folder: string | undefined
  for (const word of dirs) {
    const dir = unquote(word)
    if (dir === undefined) return undefined
    if (isAbsolute(dir)) folder = dir
    else if (dir !== '' && dir !== '.') folder = folder === undefined ? dir : join(folder, dir)
  }
  return folder
}

function countFailing(output: string[]): number {
  for (const line of output) {
    const match = FAILED_COUNT.exec(line)
    if (match) return Number(match[1])
  }
  return output.filter(line => FAILED_TEST.test(line)).length || -1
}

// ── Running a command without hanging ──────────────────────────────────────────────────────────────
// Every command push-guard runs (npm test, a check, Baseline) is told nobody is there to answer: CI=true,
// which jest, vitest and Create React App read as "run once, do not watch", and an empty, closed stdin.
// Each script gets one time budget (`timeoutMinutes`, 5 by default, 15 at most) for Baseline and, if
// Baseline gives no answer, the plain run together: a command that does not finish blocks the push, saying so

const NON_INTERACTIVE = { env: { CI: 'true' }, stdin: '' }
const DEFAULT_MINUTES = 5
const MAX_MINUTES = 15
// Claude Code runs one command for ten minutes at most
const RUN_CAP = 600_000
// The least time a plain run gets after Baseline gave no answer; less than this left, the push is blocked
const MIN_LEFT = 60_000

// The budget per script in ms: `timeoutMinutes` from 1 to 15; anything else (a typo too) is the default
function budgetMs(options: any): number {
  const n = Number(String(options?.timeoutMinutes ?? '').trim() || NaN)
  return (Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 1), MAX_MINUTES) : DEFAULT_MINUTES) * 60_000
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const minutes = (ms: number) => plural(Math.round(ms / 6_000) / 10, 'minute')

// The time now; the mod API's clock, so tests can move it
const now = async ($: any): Promise<number> => {
  try { return await $.clock.now() } catch { return Date.now() }
}

// The init for $.process.run: the folder, the time it may take, and no one to answer it
const runInit = (dir: string | undefined, ms: number) => ({ ...(dir === undefined ? {} : { cwd: dir }), timeoutMs: Math.min(ms, RUN_CAP), ...NON_INTERACTIVE })

// Runs a command for at most `ms`: its result, or `timedOut` when it was still running then. A command that
// cannot start rejects, as before
async function runFor($: any, argv: string[], dir: string | undefined, ms: number) {
  const started = await now($)
  try {
    return await $.process.run(argv, runInit(dir, ms))
  } catch (err: any) {
    const took = (await now($)) - started
    if (/timed? ?out|timeout/i.test(String(err?.message ?? err)) || took >= Math.min(ms, RUN_CAP) - 1_000) return { timedOut: true as const }
    throw err
  }
}

// What a command that did not finish is told, without the leading "push-guard: "; `blocked` when it is the whole message
const didNotFinish = (command: string, ms: number, total: number, blocked = true) =>
  `${command} did not finish within ${minutes(ms)}${ms < total - 30_000 ? ` (what was left of the ${minutes(total)} budget after Baseline)` : ''} ` +
  `(watch mode? a hung test?)${blocked ? ', so the push was blocked' : ''}. Run it yourself to see why, or raise the \`timeoutMinutes\` option.`

// ── Which scripts run ──────────────────────────────────────────────────────────────────────────────
// `npm test` may not cover the whole project: a `test:api` beside it, workspaces, an api/ folder with its
// own package.json. With `suites: auto` push-guard runs `test:all` when there is one (the project's own
// aggregate), else `test` and the `test:*` scripts that look like suites, and with npm workspaces also
// `npm test --workspaces --if-present`. Test scripts it finds but does not run are named, loudly

// `test:*` names that are not a suite to run before a push: watching, browsers and devices, coverage, updates
const NOT_A_SUITE = /(?:^|[^a-z])(?:watch|e2e|ui|playwright|cypress|storybook|coverage|update|snapshot|dev|ios|android|native|visual|bench|lint-staged)/i
// A script that watches whatever CI says
const WATCHES = /(?:^|\s)--watch(?:All)?(?=\s|$)/
// A script that already runs the workspaces' tests itself
const RUNS_WORKSPACES = /--workspaces?\b|(?:^|\s)-ws\b|\bturbo\b|\blerna\b|\bnx\b|\bpnpm\b[^\n&|;]*\s(?:-r|--recursive)\b/
// Folders whose subfolders are packages (packages/*, apps/*)
const CONTAINERS = ['packages', 'apps', 'services', 'libs', 'modules', 'functions']

const scriptText = (pkg: any, name: string): string => (typeof pkg?.scripts?.[name] === 'string' ? pkg.scripts[name].trim() : '')
const isRoot = (options: any) => String(options?.suites ?? '').trim().toLowerCase() === 'root'
const workspaceGlobs = (pkg: any): string[] =>
  (Array.isArray(pkg?.workspaces) ? pkg.workspaces : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : []).filter((g: unknown) => typeof g === 'string')

// One command push-guard runs: how it is named, and its argv
type Unit = { label: string; argv: string[]; script?: string }
const unitFor = (script: string): Unit =>
  script === 'test' ? { label: 'npm test', argv: ['npm', 'test'], script } : { label: `npm run ${script}`, argv: ['npm', 'run', script], script }
const WORKSPACES: Unit = { label: 'npm test --workspaces --if-present', argv: ['npm', 'test', '--workspaces', '--if-present'] }

// The test commands to run, and the `test:*` scripts left out that a person would expect to run
function testSuites(pkg: any, options: any): { units: Unit[]; left: string[] } {
  const siblings = Object.keys(pkg?.scripts ?? {}).filter(name => name.startsWith('test:') && scriptText(pkg, name))
  const suites = siblings.filter(name => name !== 'test:all' && !NOT_A_SUITE.test(name.slice(5)) && !WATCHES.test(scriptText(pkg, name)))
  const test = hasTests(pkg) ? scriptText(pkg, 'test') : ''
  if (isRoot(options)) {
    const left = test ? siblings.filter(name => name === 'test:all' || suites.includes(name)) : []
    return { units: test ? [unitFor('test')] : [], left: left.map(name => `${name} (package.json)`) }
  }
  // A suite the `test` script runs itself (npm run test:unit, run-s test:*) does not run twice
  const scripts = scriptText(pkg, 'test:all') ? ['test:all'] : [...(test ? ['test'] : []), ...suites.filter(name => !test.includes(name) && !test.includes('test:*'))]
  const units = scripts.map(unitFor)
  if (units.length && workspaceGlobs(pkg).length && !RUNS_WORKSPACES.test(scripts.map(s => scriptText(pkg, s)).join('\n'))) units.push(WORKSPACES)
  return { units, left: [] }
}

// Folders one or two levels down (api/, packages/*) whose own package.json has a `test` script none of the
// commands that ran covers: not run, so the user is told. Never throws
async function uncoveredPackages($: any, dir: string | undefined, pkg: any, ran: Unit[]): Promise<string[]> {
  const root = dir ?? '.'
  const folders = async (path: string) =>
    ((await $.fs.list(path).catch(() => [])) as any[]).filter(x => x?.kind === 'dir' && !x.name.startsWith('.') && x.name !== 'node_modules').map(x => String(x.name))
  const hasTest = async (rel: string) => hasTests(await readPackage(() => $.fs.read(join(root, `${rel}/package.json`))))
  const found: string[] = []
  try {
    for (const name of await folders(root)) {
      if (await hasTest(name)) found.push(name)
      else if (CONTAINERS.includes(name)) for (const sub of await folders(join(root, name))) if (await hasTest(`${name}/${sub}`)) found.push(`${name}/${sub}`)
    }
  } catch {
    return []
  }
  const texts = ran.map(u => (u.script ? scriptText(pkg, u.script) : '')).join('\n')
  const workspaces = ran.includes(WORKSPACES) ? workspaceGlobs(pkg).map(glob) : []
  const named = (rel: string) => new RegExp(`(?:^|[\\s'"=:/])(?:\\./)?${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s'"/;&|)])`).test(texts)
  return found.filter(rel => !workspaces.some(re => re.test(rel)) && !named(rel)).map(rel => `${rel} (${rel}/package.json: test)`)
}

// ── With Baseline ──────────────────────────────────────────────────────────────────────────────────
// Baseline (`baseline check`) runs the tests on HEAD and on the commit the push builds on, and says per
// failing test whether this push broke it (new) or it was red already (pre_existing, flaky, environment).
// push-guard then blocks only on new failures. Whenever Baseline can't give a clear answer, push-guard
// runs the script as it always did and blocks on any failure: Baseline breaking never lets a push through.

// The Baseline binary, found once per session: a path, '' when there is none, null before the first look
const baseline = atom({ plugin: 'push-guard', key: 'baseline' } as const, null)
const BASELINE_VERSION = /^baseline \d+\.\d+/
// Verdicts that let a push through, and how each is said
const NOT_MINE: Record<string, string> = {
  pre_existing: 'pre-existing',
  pre_existing_error_changed: 'pre-existing (error changed)',
  flaky: 'flaky',
  environment: 'environment',
}

// An environment variable, or '' when it is unset or the mod API gives none
const envVar = async (get: () => Promise<string | undefined>) => {
  try { return (await get()) ?? '' } catch { return '' }
}

// Where Baseline may be: $BASELINE_BIN alone when set; else `baseline` in each $PATH folder, then the
// bin/ of a Baseline plugin installed in Claude Code (from plugins/installed_plugins.json in its config folder)
async function* baselineCandidates($: any) {
  const own = await envVar(() => $.env.get('BASELINE_BIN'))
  if (own) return yield own
  const path = await envVar(() => $.env.get('PATH'))
  for (const dir of path.split(path.includes(';') ? ';' : ':')) if (dir) yield join(dir, 'baseline')
  const home = await envVar(() => $.env.get('HOME'))
  const config = (await envVar(() => $.env.get('CLAUDE_CONFIG_DIR'))) || (home && join(home, '.claude'))
  if (!config) return
  const installed = await readPackage(() => $.fs.read(join(config, 'plugins/installed_plugins.json')))
  for (const [id, installs] of Object.entries(installed?.plugins ?? {})) {
    if (!id.startsWith('baseline@') || !Array.isArray(installs)) continue
    for (const { installPath } of installs) if (typeof installPath === 'string') yield join(installPath, 'bin/baseline')
  }
}

// The Baseline to use: the first candidate that exists and answers `baseline version`; '' for none
async function findBaseline($: any): Promise<string> {
  const known = await read($, baseline)
  if (known !== null) return known
  let found = ''
  for await (const bin of baselineCandidates($)) {
    if (!(await $.fs.exists(bin).catch(() => false))) continue
    const answer = await $.process.run([bin, 'version'], { timeoutMs: 5_000, ...NON_INTERACTIVE }).catch(() => undefined)
    if (answer?.exitCode === 0 && BASELINE_VERSION.test(answer.stdout)) { found = bin; break }
  }
  await update($, baseline, () => found)
  return found
}

// Text from the tests, for Claude: quoted on one line, so a test name or an error can't start lines of its own
const quote = (text: unknown) => JSON.stringify(String(text ?? '').slice(0, 300))
const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

// What Baseline's JSON says, checked. `why` when it can't be trusted to tell new failures from old:
// then push-guard does what it did without Baseline. A failure counts as not this push's only when the
// report says so, unit by unit, with the runs to show for it; nothing is inferred. `check`: the command is
// one of the project's checks (npm run typecheck, lint, ...), whose report lists errors, one result each
function readReport(stdout: string, exitCode: number, range: { head: string; base: string }, check = false) {
  if (exitCode === 2) return { why: `Baseline could not run ${check ? 'the check' : 'the tests'} (exit 2)` }
  if (exitCode === 3) return { why: `Baseline could not get a trusted result on ${range.base.slice(0, 7)} (exit 3)` }
  if (exitCode !== 0 && exitCode !== 1) return { why: `Baseline exited ${exitCode}` }
  let report: any
  try { report = JSON.parse(stdout) } catch { return { why: `Baseline's output was not JSON` } }
  if (report?.tool !== 'baseline' || report.schema !== 1 || report.exit_code !== exitCode || !Array.isArray(report.results)) return { why: "Baseline's report is not one push-guard reads" }
  if (report.base?.sha !== range.base || report.head?.sha !== range.head) return { why: 'Baseline compared other commits than the ones being pushed' }
  const base = report.base.short ?? range.base.slice(0, 7)
  if (report.runner?.per_test !== true) {
    // A whole command that passes on HEAD needs no comparison; any other answer about it can hide failures
    if (exitCode === 0 && !report.results.length) return { base, isNew: [], red: [], unknown: [] }
    return { why: `Baseline can't ${check ? "read this check's errors one by one" : "tell this project's tests apart"} (runner: ${quote(report.runner?.name)})` }
  }
  // Errors one by one only from a check Baseline parsed (tsc, eslint, prettier, next build); tests only from a test runner
  const perError = check && report.runner?.check === true
  const units = perError ? ['check_error'] : ['test', 'load_error']

  const isNew: any[] = [], red: any[] = [], unknown: any[] = []
  for (const r of report.results) {
    const [head, base] = [r.head ?? {}, r.base ?? {}]
    // A whole command, `(command)` or `(test session)` stands for every failure in it: one verdict for all of
    // them can hide failures this push caused, so only NEW (which blocks) is taken from it
    const whole = r.kind === 'command' || /^\(.*\)$/.test(String(r.id)) || !units.includes(r.kind)
    // The runs a verdict that lets the push through rests on: failed on both commits, or passed and failed on one
    const shown = r.verdict === 'flaky'
      ? (head.passed > 0 && head.failed > 0) || (base.passed > 0 && base.failed > 0 && head.failed > 0)
      : head.failed > 0 && base.failed > 0 && (r.verdict !== 'environment' || !!r.env_class)
    if (r.verdict === 'new') isNew.push(r)
    else if (r.verdict === 'unknown') unknown.push(r)
    else if (whole) return { why: `Baseline judged ${quote(r.id)} as a whole, which can hide failures this push caused` }
    else if (r.verdict === 'flaky' && r.surfaced === true) continue // passed in the full run on HEAD: not red
    else if (r.verdict in NOT_MINE && shown) red.push(r)
    else return { why: `Baseline's verdict on ${quote(r.id)} has nothing to show for it` }
  }
  if (exitCode === 1 && !isNew.length) return { why: 'Baseline exited 1 but named no new failure' }
  if (exitCode === 0 && (isNew.length || unknown.length)) return { why: 'Baseline exited 0 but named new or unknown failures' }
  // Every failure HEAD's full run counted must have a verdict of its own: one left out could be new
  const listed = (kind: string) => report.results.filter((r: any) => r.kind === kind && !(r.verdict === 'flaky' && r.surfaced === true)).length
  const s = report.summary ?? {}
  const counted = perError ? num(s.check_errors) : num(s.tests_failed) + num(s.load_errors)
  if (counted > (perError ? listed('check_error') : listed('test') + listed('load_error'))) return { why: 'Baseline counted more failures on HEAD than it gave verdicts for' }
  // A check Baseline read error by error (tsc, eslint, prettier) has no tests to count: passing, it lists nothing
  if (!isNew.length && !red.length && !perError && !(s.tests_passed > 0)) return { why: 'Baseline saw no tests run' }
  return { base, isNew, red, unknown }
}

type Report = Exclude<ReturnType<typeof readReport>, { why: string }>

// Runs one command through Baseline, in `ms` at most. Undefined when Baseline is off or not installed;
// `why` when it was not used or gave no clear answer; `timedOut` when it or the command did not finish
async function checkWithBaseline($: any, options: any, dir: string | undefined, unit: Unit, check: boolean, ms: number): Promise<Report | { why: string } | { timedOut: string } | undefined> {
  if (String(options?.baseline ?? '').trim().toLowerCase() === 'off') return undefined
  const bin = await findBaseline($)
  if (!bin) return undefined
  // The base is what the push holds, not Baseline's own default (on main that would be HEAD itself)
  const range = await pushRange(gitIn($, dir)).catch(() => undefined)
  if (!range) return { why: 'git could not say which commits the push holds' }
  if (range.base === EMPTY_TREE) return { why: 'there is no upstream or remote default branch to compare with' }
  if (range.base === range.head) return { why: 'nothing new to push (HEAD is already on the remote)' }

  $.ui.status(`push-guard: running ${unit.label} through Baseline…`)
  // Baseline stops a test command that runs past its own --timeout, a little before push-guard stops Baseline
  const seconds = Math.max(30, Math.floor(Math.min(ms, RUN_CAP) / 1_000) - 15)
  const argv = [bin, 'check', '--json', '--base', range.base, '--timeout', String(seconds), '--', ...unit.argv]
  const ran: any = await runFor($, argv, dir, ms).catch((err: any) => ({ err }))
  $.ui.status(undefined)
  if (ran.timedOut) return { timedOut: `baseline check -- ${unit.label}` }
  if ('err' in ran) return { why: `Baseline did not start (${quote(ran.err?.message ?? ran.err)})` }
  // Baseline stopped the command itself: it did not finish on HEAD
  if (ran.exitCode === 2 && /timed out/i.test(ran.stdout)) return { timedOut: `${unit.label} (run by Baseline)` }
  return readReport(ran.stdout, ran.exitCode, range, check)
}

// How one command came out: judged by Baseline, run as is, not finished in time, or not there at all (npm
// has no such script, which is never a failure). `note`: why Baseline was not used, for a plain run
type Outcome = { unit: Unit } & ({ report: Report } | { exitCode: number; output: string[]; note: string } | { timedOut: string; ms: number } | { missing: true })

async function runUnit($: any, options: any, dir: string | undefined, unit: Unit, check: boolean, total: number): Promise<Outcome> {
  const started = await now($)
  const checked = await checkWithBaseline($, options, dir, unit, check, total).catch(err => ({ why: `Baseline could not be used (${quote(err?.message ?? err)})` }))
  if (checked && 'timedOut' in checked) return { unit, timedOut: checked.timedOut, ms: total }
  if (checked && !('why' in checked)) return { unit, report: checked }
  // One budget for both: the plain run gets what Baseline left, never less than a minute
  const left = checked ? total - ((await now($)) - started) : total
  const ms = Math.max(left, MIN_LEFT)
  $.ui.status(`push-guard: running ${unit.label}…`)
  const ran: any = await runFor($, unit.argv, dir, ms)
  $.ui.status(undefined)
  if (ran.timedOut) return { unit, timedOut: unit.label, ms }
  const output = `${ran.stdout}\n${ran.stderr}`.split('\n').map((line: string) => line.trimEnd())
  if (ran.exitCode !== 0 && unit.script !== undefined && output.some(line => missingScript(unit.script!).test(line))) return { unit, missing: true }
  return { unit, exitCode: ran.exitCode, output, note: checked ? `push-guard did not use Baseline: ${checked.why}.` : '' }
}

// "2 pre-existing (already failing on abc1234), 1 flaky"; a check's errors are "already reported"
function countRed(report: Report, was = 'failing') {
  const counts = new Map<string, number>()
  for (const r of report.red) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1)
  return [...counts].map(([verdict, n]) => `${n} ${NOT_MINE[verdict]}${verdict === 'pre_existing' ? ` (already ${was} on ${report.base})` : ''}`).join(', ')
}

// The new failures Baseline found in one command, each with its evidence, then what else is red
function newFailureLines(report: Report) {
  const lines = report.isNew.map(r => {
    const base = r.base?.runs ? `passed ${r.base.passed}/${r.base.runs} runs on ${report.base}` : `not on ${report.base} (new in this push)`
    const what = r.kind === 'load_error' ? `fails to load on HEAD (${plural(r.head.failed, 'run')})` : `fails ${r.head.failed}/${r.head.runs} runs on HEAD`
    return `- ${quote(r.id)}: ${base}, ${what}: ${quote(String(r.head.message || r.head.error).split('\n')[0])}`
  })
  const others = report.red.length ? `\n\nAlso still failing, not because of this push: ${countRed(report)}. Those do not block the push.` : ''
  const unknown = report.unknown.length ? `\n\nBaseline could not compare ${plural(report.unknown.length, 'more failing test')} with ${report.base}: ${report.unknown.map(r => quote(r.id)).join(', ')}.` : ''
  return `${lines.join('\n')}${others}${unknown}`
}

// The deny for a push that breaks tests in its one test command
function newFailures(report: Report, label = 'npm test') {
  return (
    `push-guard: ${label} fails, and ${plural(report.isNew.length, 'failure')} ${report.isNew.length === 1 ? 'is' : 'are'} new with this push ` +
    `(not failing on ${report.base}, the commit it builds on), so it was blocked. Baseline ran each failing test on both commits.\n\n` +
    `New failures:\n${newFailureLines(report)}\n\n` +
    'Fix these, then push again. They come from this push: do not call them pre-existing or flaky.'
  )
}

// How a result that lets the push through is told: about the project's tests, about its checks (a project
// with no `test` script), or when nothing was run
type Said = { pass: string; notMine: string; still: (n: number) => string; was: string; tell: string }
const TESTS: Said = {
  pass: 'the tests pass',
  notMine: 'no test fails because of this push',
  still: n => `${plural(n, 'test')} still red`,
  was: 'failing',
  tell: 'Tell the user these tests are still failing, and that they were failing before this push or are flaky or environmental.',
}
const CHECKED: Said = {
  pass: 'the checks pass',
  notMine: 'no check error is new with this push',
  still: n => `${plural(n, 'check error')} still reported`,
  was: 'reported',
  tell: 'Tell the user these check errors are still reported, and that they were there before this push or are environmental.',
}
const UNCHECKED: Said = { ...CHECKED, pass: 'nothing was checked' }

// The push's tests pass, or fail only where Baseline showed the failures are not this push's (`red`):
// the hold for changed tests still applies, then the push goes ahead. `notRun`: test scripts push-guard
// found but did not run, said loudly
async function letThrough($: any, e: any, next: any, options: any, pkg: any, dir: string | undefined, red?: Report, said = TESTS, notRun?: { ran: string[]; left: string[] }) {
  // Green tests prove little if the push changed the tests to match the code
  // Anything but warn or off (a typo too) holds, so a slip in the option does not open the gate
  const mode = ['warn', 'off'].find(m => m === String(options?.testChanges ?? '').trim().toLowerCase()) ?? 'block'
  const extra = Array.isArray(pkg?.pushGuard?.testFiles) ? pkg.pushGuard.testFiles.filter((g: unknown) => typeof g === 'string').map(glob) : []
  const tests = mode === 'off' ? undefined : await testChanges($, dir, extra)
  if (tests?.changed.length && mode === 'block' && (await read($, allowed)) !== tests.head) {
    await update($, held, () => tests.head)
    return {
      deny:
        `push-guard: ${red ? said.notMine : said.pass}, but this push changes or deletes existing tests, so it waits for a person's OK.\n\n` +
        `Changed test files:\n${tests.changed.join('\n')}\n\n` +
        'If a test was edited to make it pass, put it back and fix the code instead. If the change is meant ' +
        '(the expected behaviour really changed), ask the user to type /push-guard allow, then push again. Do not run it yourself.' +
        (notRun?.left.length ? `\n\n${notRunLine(notRun)}` : ''),
    }
  }
  // git could not say (no commit yet, a broken repo): there is nothing to hold, so say so instead of passing quietly
  if (mode !== 'off' && tests === undefined) $.ui.toast('push-guard: could not tell which test files this push changes')
  const n = tests?.changed.length || tests?.added.length
  if (n) $.ui.toast(`push-guard: this push ${tests?.changed.length ? 'changes' : 'adds to'} ${n} test file${n === 1 ? '' : 's'}`)
  if (!red && !notRun?.left.length) return next(e)

  const ran: any = await next(e)
  if (ran.deny) return ran
  const context: string[] = []
  if (red) {
    // Some tests are still red, none because of this push: it goes ahead, and the user and Claude are told what is red
    const still = `${said.still(red.red.length)}, none from this push: ${countRed(red, said.was)}`
    const named = red.red.map(r => `${quote(r.id)}: ${NOT_MINE[r.verdict]}`)
    const more = (shown: string[]) => (named.length > shown.length ? [...shown, `and ${named.length - shown.length} more`] : shown)
    $.ui.toast([`push-guard: ${ran.isError ? 'let the push through' : 'pushed'} with ${still}`, ...more(named.slice(0, 3))].join('\n'))
    const why = red.red.map(r => `- ${quote(r.id)}: ${NOT_MINE[r.verdict]}. ${quote(r.reason)}`)
    context.push(
      `push-guard: Baseline compared this push with ${red.base}, the commit it builds on: ${still}, so push-guard let the push through.\n` +
        `${more(why.slice(0, 10)).join('\n')}\n` +
        said.tell,
    )
  }
  if (notRun?.left.length) {
    // Tests the project has that did not run: the push is not checked there, and nobody may assume it was
    $.ui.toast(notRunLine(notRun))
    context.push(`${notRunLine(notRun)}. Tell the user the push went ahead without these tests, so it is not checked there.`)
  }
  return { ...ran, context: [...(ran.context ?? []), ...context] }
}

const notRunLine = ({ ran, left }: { ran: string[]; left: string[] }) => `push-guard ran ${ran.join(', ')}; these test scripts were NOT run: ${left.join(', ')}`

// ── Projects with no `test` script ─────────────────────────────────────────────────────────────────
// Their own checks run instead (npm run typecheck, lint, ...), each through Baseline when it is installed,
// so only errors this push brings in block it. Whatever Baseline can't read error by error runs as is,
// and then any failure blocks. With no check either, the push goes ahead, but the user and Claude are told

// The deny section for a check where Baseline found errors this push brought in
function newErrors(script: string, report: Report) {
  const lines = report.isNew.map(r =>
    r.kind === 'check_error'
      ? `- ${quote(r.id)}`
      : `- ${quote(r.id)}: passed on ${report.base}, fails on HEAD: ${quote(String(r.head?.error_raw || r.head?.message).split('\n')[0])}`,
  )
  const others = report.red.length ? `\nAlso still reported, not because of this push: ${countRed(report, 'reported')}. Those do not block the push.` : ''
  const unknown = report.unknown.length ? `\nBaseline could not compare ${plural(report.unknown.length, 'more error')} with ${report.base}: ${report.unknown.map(r => quote(r.id)).join(', ')}.` : ''
  const n = report.isNew.length
  return (
    `npm run ${script}: ${plural(n, 'error')} ${n === 1 ? 'is' : 'are'} new with this push (not reported on ${report.base}, the commit it builds on; ` +
    `Baseline ran the check on both commits):\n${lines.join('\n')}${others}${unknown}`
  )
}

// What a project with no tests and no checks to run is told: a toast, a note to Claude, the line above the prompt.
// `found`: its `test:*` scripts, none of which ran (watch, e2e or UI suites, or `suites: root`)
async function letThroughUnchecked($: any, e: any, next: any, options: any, pkg: any, dir: string | undefined) {
  await update($, last, () => ({ failing: 0, nothing: true }))
  const found = Object.keys(pkg?.scripts ?? {}).filter(name => name.startsWith('test:') && scriptText(pkg, name))
  const also = found.length ? ` (it has ${found.join(', ')}, which push-guard does not run before a push)` : ''
  $.ui.toast(`${NOTHING}${also}`)
  const ran: any = await letThrough($, e, next, options, pkg, dir, undefined, UNCHECKED)
  if (ran?.deny) return ran
  const looked = String(options?.checks ?? '').trim().toLowerCase() === 'all' ? [...CHECKS, 'build'] : CHECKS
  const context =
    `push-guard: nothing was checked before this push. package.json has no \`test\` script and none of the check scripts ` +
    `push-guard runs instead (${looked.join(', ')}), so the push went ahead without any test, type check or lint. ` +
    (found.length ? `It does have ${found.join(', ')}, which push-guard does not run before a push (watch, end-to-end, UI or device suites${isRoot(options) ? ', or `suites` is `root`' : ''}). ` : '') +
    'Tell the user nothing was checked, and that adding a test or typecheck script to package.json would let push-guard check pushes.'
  return { ...ran, context: [...(ran?.context ?? []), context] }
}

// ── Running the commands and judging the push ──────────────────────────────────────────────────────

// Runs each command (through Baseline when it can) and blocks on failures this push caused, on any failure of a
// command Baseline could not judge, and on a command that did not finish. `checks`: the commands are the
// check scripts of a project with no `test` script. `left`: test scripts found and not run
async function guard($: any, e: any, next: any, options: any, pkg: any, dir: string | undefined, units: Unit[], checks: boolean, left: string[] = []) {
  const total = budgetMs(options)
  const outcomes: Exclude<Outcome, { missing: true }>[] = []
  for (const unit of units) {
    const o = await runUnit($, options, dir, unit, checks, total)
    if ('missing' in o) continue
    outcomes.push(o)
    if ('timedOut' in o) break // blocked already; the rest would only keep the push waiting longer
  }
  if (!outcomes.length) return letThroughUnchecked($, e, next, options, pkg, dir)
  const ranUnits = outcomes.map(o => o.unit)
  const skipped = units.slice(units.indexOf(ranUnits[ranUnits.length - 1]) + 1).filter(() => outcomes.some(o => 'timedOut' in o))
  const notRun = { ran: ranUnits.map(u => u.label), left: [...left, ...(await uncoveredPackages($, dir, pkg, ranUnits))] }

  const reports = outcomes.flatMap(o => ('report' in o ? [o.report] : []))
  const failedOutcomes = outcomes.filter(o => 'timedOut' in o || ('report' in o ? o.report.isNew.length > 0 : o.exitCode !== 0))
  const isNew = reports.reduce((n, r) => n + r.isNew.length, 0)
  const red = reports.flatMap(r => r.red)
  const errors = outcomes.reduce((n, o) => n + ('report' in o ? o.report.isNew.length + o.report.red.length + o.report.unknown.length : 'timedOut' in o ? 1 : o.exitCode === 0 ? 0 : checks ? 1 : Math.max(countFailing(o.output), 1)), 0)
  // Every failing command was judged by Baseline, so the line above the prompt can count new ones
  const judged = reports.length > 0 && failedOutcomes.every(o => 'report' in o)
  const name = (u: Unit) => u.script ?? 'workspaces'
  const single = !checks && outcomes.length === 1 && units.length === 1 && outcomes[0].unit.script === 'test'
  const only = outcomes[0]
  await update($, last, () => ({
    ...(single
      ? 'report' in only ? { failing: errors, new: isNew, old: red.length } : { failing: 'exitCode' in only && only.exitCode !== 0 ? countFailing(only.output) : 'timedOut' in only ? -1 : 0 }
      : { failing: errors, checks: ranUnits.map(name), failed: failedOutcomes.map(o => name(o.unit)), ...(judged ? { new: isNew, old: red.length } : {}) }),
    ...(notRun.left.length ? { notRun: notRun.left.map(l => l.split(' ')[0]) } : {}),
    ...(outcomes.some(o => 'timedOut' in o) ? { timedOut: true } : {}),
  }))
  const leftLine = notRun.left.length ? `\n\n${notRunLine(notRun)}.` : ''

  if (failedOutcomes.length) {
    // The project's one test command: said as it always was
    if (single) {
      if ('timedOut' in only) return { deny: `push-guard: ${didNotFinish(only.timedOut, only.ms, total)} push-guard ran it with CI=true, so a test runner that watches would have stopped.${leftLine}` }
      if ('report' in only) return { deny: `${newFailures(only.report)}${leftLine}` }
      const failed = only.output.filter(line => FAILED_LINE.test(line))
      const shown = (failed.length ? failed : only.output.filter(Boolean).slice(-15)).join('\n')
      return { deny: `push-guard: npm test failed (exit ${only.exitCode}), so the push was blocked.\n\nFailed tests:\n${shown}${only.note ? `\n\n(${only.note})` : ''}${leftLine}` }
    }
    // Each command that ran and how it came out, so a passing one is not taken for one that never ran
    const how = (o: (typeof outcomes)[number]) =>
      'timedOut' in o ? 'did not finish' : failedOutcomes.includes(o) ? 'failed' : 'report' in o && o.report.red.length ? `had only ${checks ? 'errors' : 'failures'} from before this push` : 'passed'
    const ranList = [...outcomes.map(o => `${o.unit.label} ${how(o)}`), ...skipped.map(u => `${u.label} not run (the push was blocked already)`)].join(', ')
    const sections = failedOutcomes.map(o => {
      if ('timedOut' in o) return didNotFinish(o.timedOut, o.ms, total, false)
      if ('report' in o) {
        return checks
          ? newErrors(o.unit.script!, o.report)
          : `${o.unit.label}: ${plural(o.report.isNew.length, 'failure')} ${o.report.isNew.length === 1 ? 'is' : 'are'} new with this push (not failing on ${o.report.base}, the commit it builds on; Baseline ran each failing test on both commits):\n${newFailureLines(o.report)}`
      }
      const failed = checks ? [] : o.output.filter(line => FAILED_LINE.test(line))
      const shown = (failed.length ? failed : o.output.filter(Boolean).slice(-15)).join('\n')
      return `${o.unit.label} failed (exit ${o.exitCode}):\n${shown}${o.note ? `\n(${o.note})` : ''}`
    })
    const list = failedOutcomes.map(o => o.unit.label).join(', ')
    const intro = checks ? 'This project has no `test` script, so push-guard ran its checks instead' : 'push-guard ran'
    return {
      deny:
        `push-guard: ${list} ${failedOutcomes.length === 1 && 'timedOut' in failedOutcomes[0] ? 'did not finish' : 'failed'}, so the push was blocked. ${intro}: ${ranList}.\n\n${sections.join('\n\n')}\n\n` +
        `Fix these, then push again.${isNew ? ` The new ${checks ? 'errors' : 'failures'} come from this push: do not call them pre-existing.` : ''}${leftLine}`,
    }
  }
  const old = red.length ? { base: reports.find(r => r.red.length)!.base, isNew: [], red, unknown: [] } : undefined
  return letThrough($, e, next, options, pkg, dir, old, checks ? CHECKED : TESTS, notRun)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'push-guard', description: 'push-guard: allow the held push that changes test files', argumentHint: 'allow' })
    return next(e)
  })

  on('command.run', { command: 'push-guard' }, async ($, e) => {
    if (String(e.args ?? '').trim() !== 'allow') return { text: 'push-guard: type /push-guard allow to let through the push it held for changed tests.' }
    // Only an OK a person gave counts: typed at the prompt, or sent from the app; not a plugin, a script or Claude
    if (!PERSON.includes((e as any).origin?.kind)) return { text: 'push-guard: only a person can allow a push that changes tests. Type /push-guard allow at the prompt yourself.' }
    const head = await read($, held)
    if (head === null) return { text: 'push-guard: no push is waiting for an OK.' }
    await update($, allowed, () => head)
    return { text: `push-guard: allowed the push of ${head.slice(0, 7)} with its test changes. Ask Claude to push again; a new commit needs a new OK.` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!GIT_PUSH.test(e.command)) return next(e)
    // `git -C dir push` and `cd dir && git push` push the project in dir, so its tests are the ones to run
    const folder = pushFolder(e.command)
    const dir = folder === undefined || isAbsolute(folder) ? folder : join(await $.session.cwd(), folder)
    // Not an npm project (no package.json, or one npm can't read either): nothing push-guard can run
    const pkg = await readPackage(() => $.fs.read(dir === undefined ? 'package.json' : join(dir, 'package.json')))
    if (pkg === undefined) return next(e)
    // The project's tests: `test`, or `test:all`, with the suites beside them. With Baseline, only failures this
    // push causes block it; a command Baseline can't judge runs as it always did
    const { units, left } = testSuites(pkg, options)
    if (units.length) return guard($, e, next, options, pkg, dir, units, false, left)
    // No npm tests: the project's own checks run instead, unless `checks` is off (then, as before, nothing runs)
    if (String(options?.checks ?? '').trim().toLowerCase() === 'off') return next(e)
    const scripts = checkScripts(pkg, options)
    if (!scripts.length) return letThroughUnchecked($, e, next, options, pkg, dir)
    return guard($, e, next, options, pkg, dir, scripts.map(unitFor), true)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: could not run the project's tests, so the push was blocked.` },
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const result = await read($, last)
    if (e.props.hasSurvey || result === null) return next(e)

    const { Text } = $.ui.resolve(e)

    if (result.nothing) return <Text color="warning">push-guard: nothing checked (no test, typecheck or lint script)</Text>
    // Test scripts found but not run, after what the line says
    const notRun = result.notRun?.length ? `; NOT run: ${result.notRun.join(', ')}` : ''
    // The scripts that ran, by name (checks, or more than the one `test` script)
    const checks = result.checks ? `${result.checks.join(', ')}: ` : ''

    if (result.failing === 0) {
      const passing = `push-guard: ${result.checks ? `${result.checks.join(', ')} passing` : 'all tests passing'}${notRun}`
      return <Text color={notRun ? 'warning' : 'success'}>{passing}</Text>
    }

    // Through Baseline: how many failures this push caused, and how many were red already
    if (result.new !== undefined) {
      const unclear = result.failing - result.new - (result.old ?? 0)
      const parts = [`${result.new} new`, `${result.old ?? 0} still failing (not yours)`, ...(unclear > 0 ? [`${unclear} unclear`] : [])]
      return <Text color={result.new ? 'error' : 'warning'}>push-guard: {checks}{parts.join(', ')}{notRun}</Text>
    }

    if (result.timedOut && !result.failed?.length) return <Text color="error">push-guard: npm test did not finish{notRun}</Text>
    if (result.failed?.length) return <Text color="error">push-guard: {result.failed.join(', ')} {result.timedOut ? 'failing or not finished' : 'failing'}{notRun}</Text>

    const count = result.failing === -1 ? 'tests failing' : `${result.failing} ${result.failing === 1 ? 'test' : 'tests'} failing`
    return <Text color="error">push-guard: {count}{notRun}</Text>
  })
}
