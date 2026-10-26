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

// A glob from package.json as a pattern: * and ? stay in one folder, ** crosses folders
const glob = (text: string) =>
  new RegExp(`(?:^|/)${text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')}(?:$|/)`)

// The test files the commits being pushed change: from where HEAD left the upstream (or, on a new branch,
// the remote's default branch) to HEAD. `changed` lost lines or were deleted or renamed, which is how a
// failing test is made to pass; `added` are new files or only gained lines. Undefined when git can't say
async function testChanges($: any, cwd: string | undefined, extra: RegExp[]) {
  const git = async (...args: string[]) => {
    const { exitCode, stdout } = await $.process.run(['git', ...args], cwd === undefined ? {} : { cwd })
    return exitCode === 0 ? stdout : undefined
  }
  try {
    const head = (await git('rev-parse', 'HEAD'))?.trim()
    if (!head) return undefined
    let base = EMPTY_TREE
    for (const ref of ['@{upstream}', 'origin/HEAD', 'origin/main', 'origin/master']) {
      const found = (await git('merge-base', ref, 'HEAD'))?.trim()
      if (found) { base = found; break }
    }
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
    // A project with no npm tests has nothing to check, so the push goes ahead
    const pkg = await readPackage(() => $.fs.read(dir === undefined ? 'package.json' : join(dir, 'package.json')))
    if (!hasTests(pkg)) return next(e)

    $.ui.status('push-guard: running npm test…')
    const init = dir === undefined ? { timeoutMs: 600_000 } : { cwd: dir, timeoutMs: 600_000 }
    const { exitCode, stdout, stderr } = await $.process.run(['npm', 'test'], init)
    $.ui.status(undefined)

    const output = `${stdout}\n${stderr}`.split('\n').map(line => line.trimEnd())
    const result: TestResult = { failing: exitCode === 0 ? 0 : countFailing(output) }
    await update($, last, () => result)

    if (exitCode === 0) {
      // Green tests prove little if the push changed the tests to match the code
      // Anything but warn or off (a typo too) holds, so a slip in the option does not open the gate
      const mode = ['warn', 'off'].find(m => m === String(options?.testChanges ?? '').trim().toLowerCase()) ?? 'block'
      const extra = Array.isArray(pkg?.pushGuard?.testFiles) ? pkg.pushGuard.testFiles.filter((g: unknown) => typeof g === 'string').map(glob) : []
      const tests = mode === 'off' ? undefined : await testChanges($, dir, extra)
      if (tests?.changed.length && mode === 'block' && (await read($, allowed)) !== tests.head) {
        await update($, held, () => tests.head)
        return {
          deny:
            `push-guard: the tests pass, but this push changes or deletes existing tests, so it waits for a person's OK.\n\n` +
            `Changed test files:\n${tests.changed.join('\n')}\n\n` +
            'If a test was edited to make it pass, put it back and fix the code instead. If the change is meant ' +
            '(the expected behaviour really changed), ask the user to type /push-guard allow, then push again. Do not run it yourself.',
        }
      }
      // git could not say (no commit yet, a broken repo): there is nothing to hold, so say so instead of passing quietly
      if (mode !== 'off' && tests === undefined) $.ui.toast('push-guard: could not tell which test files this push changes')
      const n = tests?.changed.length || tests?.added.length
      if (n) $.ui.toast(`push-guard: this push ${tests?.changed.length ? 'changes' : 'adds to'} ${n} test file${n === 1 ? '' : 's'}`)
      return next(e)
    }

    const failed = output.filter(line => FAILED_LINE.test(line))
    const shown = (failed.length ? failed : output.filter(Boolean).slice(-15)).join('\n')

    return { deny: `push-guard: npm test failed (exit ${exitCode}), so the push was blocked.\n\nFailed tests:\n${shown}` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: could not run npm test, so the push was blocked.` },
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const result = await read($, last)
    if (e.props.hasSurvey || result === null) return next(e)

    const { Text } = $.ui.resolve(e)

    if (result.failing === 0) return <Text color="success">push-guard: all tests passing</Text>

    const count = result.failing === -1 ? 'tests failing' : `${result.failing} ${result.failing === 1 ? 'test' : 'tests'} failing`
    return <Text color="error">push-guard: {count}</Text>
  })
}
