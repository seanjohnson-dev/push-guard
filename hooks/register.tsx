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

// ── With Baseline ──────────────────────────────────────────────────────────────────────────────────
// Baseline (`baseline check`) runs the tests on HEAD and on the commit the push builds on, and says per
// failing test whether this push broke it (new) or it was red already (pre_existing, flaky, environment).
// push-guard then blocks only on new failures. Whenever Baseline can't give a clear answer, push-guard
// runs npm test as it always did and blocks on any failure: Baseline breaking never lets a push through.

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
    const answer = await $.process.run([bin, 'version'], { timeoutMs: 5_000 }).catch(() => undefined)
    if (answer?.exitCode === 0 && BASELINE_VERSION.test(answer.stdout)) { found = bin; break }
  }
  await update($, baseline, () => found)
  return found
}

// Text from the tests, for Claude: quoted on one line, so a test name or an error can't start lines of its own
const quote = (text: unknown) => JSON.stringify(String(text ?? '').slice(0, 300))

// What Baseline's JSON says, checked. `why` when it can't be trusted to tell new failures from old:
// then push-guard does what it did without Baseline. A failure counts as not this push's only when the
// report says so with the runs to show for it; nothing is inferred. `check`: the command is one of the
// project's checks (npm run typecheck, lint, ...), whose report lists errors, one result each, not tests
function readReport(stdout: string, exitCode: number, range: { head: string; base: string }, check = false) {
  if (exitCode === 2) return { why: `Baseline could not run ${check ? 'the check' : 'the tests'} (exit 2)` }
  if (exitCode === 3) return { why: `Baseline could not get a trusted result on ${range.base.slice(0, 7)} (exit 3)` }
  if (exitCode !== 0 && exitCode !== 1) return { why: `Baseline exited ${exitCode}` }
  let report: any
  try { report = JSON.parse(stdout) } catch { return { why: `Baseline's output was not JSON` } }
  if (report?.tool !== 'baseline' || report.schema !== 1 || report.exit_code !== exitCode || !Array.isArray(report.results)) return { why: "Baseline's report is not one push-guard reads" }
  if (report.runner?.per_test !== true) {
    return { why: `Baseline can't ${check ? "read this check's errors one by one" : "tell this project's tests apart"} (runner: ${quote(report.runner?.name)})` }
  }
  if (report.base?.sha !== range.base || report.head?.sha !== range.head) return { why: 'Baseline compared other commits than the ones being pushed' }

  const isNew: any[] = [], red: any[] = [], unknown: any[] = []
  for (const r of report.results) {
    const [head, base] = [r.head ?? {}, r.base ?? {}]
    // The runs a verdict that lets the push through rests on: failed on both commits, or passed and failed on one
    const shown = r.verdict === 'flaky'
      ? (head.passed > 0 && head.failed > 0) || (base.passed > 0 && base.failed > 0 && head.failed > 0)
      : head.failed > 0 && base.failed > 0 && (r.verdict !== 'environment' || !!r.env_class)
    if (r.verdict === 'new') isNew.push(r)
    else if (r.verdict === 'unknown') unknown.push(r)
    else if (r.verdict === 'flaky' && r.surfaced === true) continue // passed in the full run on HEAD: not red
    else if (r.verdict in NOT_MINE && shown) red.push(r)
    else return { why: `Baseline's verdict on ${quote(r.id)} has nothing to show for it` }
  }
  if (exitCode === 1 && !isNew.length) return { why: 'Baseline exited 1 but named no new failure' }
  if (exitCode === 0 && (isNew.length || unknown.length)) return { why: 'Baseline exited 0 but named new or unknown failures' }
  // A check Baseline read error by error (tsc, eslint, prettier) has no tests to count: passing, it lists nothing
  const checked = check && report.runner?.check === true
  if (!isNew.length && !red.length && !checked && !(report.summary?.tests_passed > 0)) return { why: 'Baseline saw no tests run' }
  return { base: report.base.short ?? range.base.slice(0, 7), isNew, red, unknown }
}

type Report = Exclude<ReturnType<typeof readReport>, { why: string }>

// Runs the push's tests (or, with `script`, `npm run <script>`, one of the project's checks) through Baseline.
// Undefined when it is off or not installed (push-guard then runs exactly as it does without Baseline);
// `why` when it was not used or gave no clear answer
async function checkWithBaseline($: any, options: any, dir: string | undefined, script?: string): Promise<Report | { why: string } | undefined> {
  if (String(options?.baseline ?? '').trim().toLowerCase() === 'off') return undefined
  const bin = await findBaseline($)
  if (!bin) return undefined
  // The base is what the push holds, not Baseline's own default (on main that would be HEAD itself)
  const range = await pushRange(gitIn($, dir)).catch(() => undefined)
  if (!range) return { why: 'git could not say which commits the push holds' }
  if (range.base === EMPTY_TREE) return { why: 'there is no upstream or remote default branch to compare with' }
  if (range.base === range.head) return { why: 'nothing new to push (HEAD is already on the remote)' }

  const command = script === undefined ? ['npm', 'test'] : ['npm', 'run', script]
  $.ui.status(`push-guard: running ${command.join(' ')} through Baseline…`)
  const init = dir === undefined ? { timeoutMs: 600_000 } : { cwd: dir, timeoutMs: 600_000 }
  const ran = await $.process.run([bin, 'check', '--json', '--base', range.base, '--', ...command], init).catch((err: any) => ({ err }))
  $.ui.status(undefined)
  if ('err' in ran) return { why: `Baseline did not finish (${quote(ran.err?.message ?? ran.err)})` }
  return readReport(ran.stdout, ran.exitCode, range, script !== undefined)
}

// "2 pre-existing (already failing on abc1234), 1 flaky"; a check's errors are "already reported"
function countRed(report: Report, was = 'failing') {
  const counts = new Map<string, number>()
  for (const r of report.red) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1)
  return [...counts].map(([verdict, n]) => `${n} ${NOT_MINE[verdict]}${verdict === 'pre_existing' ? ` (already ${was} on ${report.base})` : ''}`).join(', ')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// The deny for a push that breaks tests: each new failure with its evidence, then what else is red
function newFailures(report: Report) {
  const lines = report.isNew.map(r => {
    const base = r.base?.runs ? `passed ${r.base.passed}/${r.base.runs} runs on ${report.base}` : `not on ${report.base} (new in this push)`
    const what = r.kind === 'load_error' ? `fails to load on HEAD (${plural(r.head.failed, 'run')})` : `fails ${r.head.failed}/${r.head.runs} runs on HEAD`
    return `- ${quote(r.id)}: ${base}, ${what}: ${quote(String(r.head.message || r.head.error).split('\n')[0])}`
  })
  const others = report.red.length ? `\n\nAlso still failing, not because of this push: ${countRed(report)}. Those do not block the push.` : ''
  const unknown = report.unknown.length ? `\n\nBaseline could not compare ${plural(report.unknown.length, 'more failing test')} with ${report.base}: ${report.unknown.map(r => quote(r.id)).join(', ')}.` : ''
  return (
    `push-guard: npm test fails, and ${plural(report.isNew.length, 'failure')} ${report.isNew.length === 1 ? 'is' : 'are'} new with this push ` +
    `(not failing on ${report.base}, the commit it builds on), so it was blocked. Baseline ran each failing test on both commits.\n\n` +
    `New failures:\n${lines.join('\n')}${others}${unknown}\n\n` +
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
// the hold for changed tests still applies, then the push goes ahead
async function letThrough($: any, e: any, next: any, options: any, pkg: any, dir: string | undefined, red?: Report, said = TESTS) {
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
        '(the expected behaviour really changed), ask the user to type /push-guard allow, then push again. Do not run it yourself.',
    }
  }
  // git could not say (no commit yet, a broken repo): there is nothing to hold, so say so instead of passing quietly
  if (mode !== 'off' && tests === undefined) $.ui.toast('push-guard: could not tell which test files this push changes')
  const n = tests?.changed.length || tests?.added.length
  if (n) $.ui.toast(`push-guard: this push ${tests?.changed.length ? 'changes' : 'adds to'} ${n} test file${n === 1 ? '' : 's'}`)
  if (!red) return next(e)

  // Some tests are still red, none because of this push: it goes ahead, and the user and Claude are told what is red
  const ran: any = await next(e)
  if (ran.deny) return ran
  const still = `${said.still(red.red.length)}, none from this push: ${countRed(red, said.was)}`
  const named = red.red.map(r => `${quote(r.id)}: ${NOT_MINE[r.verdict]}`)
  const more = (shown: string[]) => (named.length > shown.length ? [...shown, `and ${named.length - shown.length} more`] : shown)
  $.ui.toast([`push-guard: ${ran.isError ? 'let the push through' : 'pushed'} with ${still}`, ...more(named.slice(0, 3))].join('\n'))
  const why = red.red.map(r => `- ${quote(r.id)}: ${NOT_MINE[r.verdict]}. ${quote(r.reason)}`)
  const context =
    `push-guard: Baseline compared this push with ${red.base}, the commit it builds on: ${still}, so push-guard let the push through.\n` +
    `${more(why.slice(0, 10)).join('\n')}\n` +
    said.tell
  return { ...ran, context: [...(ran.context ?? []), context] }
}

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

// What a project with no tests and no checks to run is told: a toast, a note to Claude, the line above the prompt
async function letThroughUnchecked($: any, e: any, next: any, options: any, pkg: any, dir: string | undefined) {
  await update($, last, () => ({ failing: 0, nothing: true }))
  $.ui.toast(NOTHING)
  const ran: any = await letThrough($, e, next, options, pkg, dir, undefined, UNCHECKED)
  if (ran?.deny) return ran
  const looked = String(options?.checks ?? '').trim().toLowerCase() === 'all' ? [...CHECKS, 'build'] : CHECKS
  const context =
    `push-guard: nothing was checked before this push. package.json has no \`test\` script and none of the check scripts ` +
    `push-guard runs instead (${looked.join(', ')}), so the push went ahead without any test, type check or lint. ` +
    'Tell the user nothing was checked, and that adding a test or typecheck script to package.json would let push-guard check pushes.'
  return { ...ran, context: [...(ran?.context ?? []), context] }
}

// Runs each check script, through Baseline when it can; blocks on errors this push brought in, or on any
// failure of a check Baseline could not judge. A script npm does not find is skipped, never a failure
async function checkProject($: any, e: any, next: any, options: any, pkg: any, dir: string | undefined) {
  const scripts = checkScripts(pkg, options)
  const ran: string[] = [], failed: string[] = [], sections: string[] = [], reports: Report[] = []
  let errors = 0
  let judged = true // every failing check was judged by Baseline, so the line above the prompt can count new ones
  for (const script of scripts) {
    const checked = await checkWithBaseline($, options, dir, script).catch(err => ({ why: `Baseline could not be used (${quote(err?.message ?? err)})` }))
    if (checked && !('why' in checked)) {
      ran.push(script)
      reports.push(checked)
      errors += checked.isNew.length + checked.red.length + checked.unknown.length
      if (checked.isNew.length) { failed.push(script); sections.push(newErrors(script, checked)) }
      continue
    }
    $.ui.status(`push-guard: running npm run ${script}…`)
    const init = dir === undefined ? { timeoutMs: 600_000 } : { cwd: dir, timeoutMs: 600_000 }
    const { exitCode, stdout, stderr } = await $.process.run(['npm', 'run', script], init)
    $.ui.status(undefined)
    const output = `${stdout}\n${stderr}`.split('\n').map(line => line.trimEnd())
    if (exitCode !== 0 && output.some(line => missingScript(script).test(line))) continue
    ran.push(script)
    if (exitCode === 0) continue
    errors++
    judged = false
    failed.push(script)
    const note = checked ? `\n(push-guard did not use Baseline: ${checked.why}.)` : ''
    sections.push(`npm run ${script} failed (exit ${exitCode}):\n${output.filter(Boolean).slice(-15).join('\n')}${note}`)
  }
  if (!ran.length) return letThroughUnchecked($, e, next, options, pkg, dir)

  const isNew = reports.reduce((n, r) => n + r.isNew.length, 0)
  const red = reports.flatMap(r => r.red)
  await update($, last, () => ({ failing: errors, checks: ran, failed, ...(judged && reports.length ? { new: isNew, old: red.length } : {}) }))
  if (failed.length) {
    const list = failed.map(s => `npm run ${s}`).join(', ')
    return {
      deny:
        `push-guard: ${list} failed, so the push was blocked. This project has no \`test\` script, so push-guard ran its checks instead ` +
        `(${ran.map(s => `npm run ${s}`).join(', ')}).\n\n${sections.join('\n\n')}\n\n` +
        `Fix these, then push again.${isNew ? ' The new errors come from this push: do not call them pre-existing.' : ''}`,
    }
  }
  const old = red.length ? { base: reports[0].base, isNew: [], red, unknown: [] } : undefined
  return letThrough($, e, next, options, pkg, dir, old, CHECKED)
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
    // No npm tests: the project's own checks run instead, unless `checks` is off (then, as before, nothing runs)
    if (!hasTests(pkg)) {
      if (String(options?.checks ?? '').trim().toLowerCase() === 'off') return next(e)
      return checkProject($, e, next, options, pkg, dir)
    }

    // With Baseline, only failures this push causes block it. When it can't tell, npm test runs as it always did
    const checked = await checkWithBaseline($, options, dir).catch(err => ({ why: `Baseline could not be used (${quote(err?.message ?? err)})` }))
    if (checked && !('why' in checked)) {
      const { isNew, red, unknown } = checked
      await update($, last, () => ({ failing: isNew.length + red.length + unknown.length, new: isNew.length, old: red.length }))
      if (isNew.length) return { deny: newFailures(checked) }
      return letThrough($, e, next, options, pkg, dir, red.length ? checked : undefined)
    }
    const note = checked ? `\n\n(push-guard did not use Baseline: ${checked.why}.)` : ''

    $.ui.status('push-guard: running npm test…')
    const init = dir === undefined ? { timeoutMs: 600_000 } : { cwd: dir, timeoutMs: 600_000 }
    const { exitCode, stdout, stderr } = await $.process.run(['npm', 'test'], init)
    $.ui.status(undefined)

    const output = `${stdout}\n${stderr}`.split('\n').map(line => line.trimEnd())
    const result: TestResult = { failing: exitCode === 0 ? 0 : countFailing(output) }
    await update($, last, () => result)

    if (exitCode === 0) return letThrough($, e, next, options, pkg, dir)

    const failed = output.filter(line => FAILED_LINE.test(line))
    const shown = (failed.length ? failed : output.filter(Boolean).slice(-15)).join('\n')

    return { deny: `push-guard: npm test failed (exit ${exitCode}), so the push was blocked.\n\nFailed tests:\n${shown}${note}` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: could not run npm test, so the push was blocked.` },
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const result = await read($, last)
    if (e.props.hasSurvey || result === null) return next(e)

    const { Text } = $.ui.resolve(e)

    if (result.nothing) return <Text color="warning">push-guard: nothing checked (no test, typecheck or lint script)</Text>
    // A project with no `test` script: the checks that ran, by name
    const checks = result.checks ? `${result.checks.join(', ')}: ` : ''

    if (result.failing === 0) return <Text color="success">push-guard: {result.checks ? `${result.checks.join(', ')} passing` : 'all tests passing'}</Text>

    // Through Baseline: how many failures this push caused, and how many were red already
    if (result.new !== undefined) {
      const unclear = result.failing - result.new - (result.old ?? 0)
      const parts = [`${result.new} new`, `${result.old ?? 0} still failing (not yours)`, ...(unclear > 0 ? [`${unclear} unclear`] : [])]
      return <Text color={result.new ? 'error' : 'warning'}>push-guard: {checks}{parts.join(', ')}</Text>
    }

    if (result.failed?.length) return <Text color="error">push-guard: {result.failed.join(', ')} failing</Text>

    const count = result.failing === -1 ? 'tests failing' : `${result.failing} ${result.failing === 1 ? 'test' : 'tests'} failing`
    return <Text color="error">push-guard: {count}</Text>
  })
}
